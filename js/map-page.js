/**
 * map-page.js — Farm Map Command Center
 * MapLibre GL + Firestore fields + GPS + Overpass nearby + Weather
 */

import "./auth-session.js?v=33";
import "./i18n.js?v=6";
import { auth, db } from "./auth.js?v=32";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection, query, where, onSnapshot, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { resolveLocationApprox } from "./weather-location.js";
import { peekActiveWeatherLocation } from "./geo/active-location.js?v=1";
import { runLocationIntelligence, CATEGORIES } from "./location-intelligence.js?v=2";
import { normalizeBoundaryCoords } from "./boundary-coords.js?v=1";
import { NAVIC_GPS_OPTIONS, detectGNSSSource, navicBadgeHTML } from "./navic.js";
import { getActiveBasemapDescriptor, getNdviTileLayerConfig } from "./geo/satellite-providers.js";
import {
  buildStressGridGeoJson,
  buildSpreadWedgeFeature,
  summarizeStressGrid,
  buildGeoNarration,
  computeFusionSignals,
} from "./geo/geo-intelligence-engine.js";
import {
  ensureRegionalMapLayers,
  setRegionalMapData,
  setRegionalMapVisible,
} from "./geo/regional-map-layers.js";
import { fetchRegionalCellsForMap } from "./network/regional-briefing.js";
import {
  ensureGeoIntelLayers,
  setStressGridData,
  setSpreadData,
} from "./geo/map-geo-layers.js";
import { mergeGeoIntelSnapshot } from "./geo/land-memory-sync.js";
import { syncGeoDerivedAlerts } from "./geo/geo-alert-sync.js";
import { oneLineTwinHint } from "./twin/map-twin-hint.js";
import { applyMapAmbientMood, getMapMoodDataset } from "./ambient/map-mood.js";

/* ── helpers ── */
function el(id) { return document.getElementById(id); }
function healthColor(score) {
  if (score === null || score === undefined) return "#94A3B8";
  if (score >= 80) return "#22C55E";
  if (score >= 40) return "#F59E0B";
  return "#EF4444";
}
function healthLabel(score) {
  if (score === null || score === undefined) return "No Data";
  if (score >= 80) return "Healthy";
  if (score >= 40) return "Moderate";
  return "At Risk";
}
function timeAgo(ms) {
  if (!ms) return "No scan yet";
  const diff = Date.now() - ms;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function tsMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

/* ── Map state ── */
let map = null;
let fields = [];          // field documents
let scansByField = {};    // fieldId → latest scan
let nearbyPlaces = [];    // from Overpass
let activeCat = "all";
let is3D = false;
let layerState = {
  sat: true, bounds: true, health: true,
  moisture: false, weather: true, pest: false, irrigation: false,
  geoStress: false, geoSpread: false, geoNdvi: false,
  regionalNetwork: false,
};
/** @type {GeoJSON.FeatureCollection|null} */
let regionalMapCache = null;
let gpsMkr = null;
let fieldMarkers = [];    // { marker, fieldId }
let previewFieldId = null;
/** @type {Record<string, object>} */
let contextByField = {};
let weatherLogs = [];
let lastWindDeg = 45;
let timelineMonths = 0;
let geoPersistTimer = null;
let lastGeoAlertKey = "";
let mapUserId = null;

/* ── Map style constants ── */
const SATELLITE_STYLE = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256, maxzoom: 19, attribution: "© Esri",
    },
    cartolabels: {
      type: "raster",
      tiles: [
        "https://a.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://b.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        "https://c.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
      ],
      tileSize: 256, attribution: "© CARTO",
    },
  },
  layers: [
    { id: "esri-sat",     type: "raster", source: "esri" },
    { id: "carto-labels", type: "raster", source: "cartolabels" },
  ],
};
const STREET_STYLE = "https://tiles.openfreemap.org/styles/liberty";

function getLatestWeatherLog() {
  return weatherLogs.slice().sort((a, b) => tsMs(b.fetchedAt) - tsMs(a.fetchedAt))[0] || null;
}

function updateGeoAttributionStrip() {
  const base = getActiveBasemapDescriptor();
  const ndvi = getNdviTileLayerConfig();
  const g = el("geo-attribution");
  if (g) {
    g.textContent = `Basemap: ${base.label} (${base.notes || "see provider docs"}). ` +
      (ndvi.kind === "tiles" ? "NDVI tile proxy active." : "NDVI tiles: optional meta agri-geo-tiles-proxy. ") +
      "Stress mesh: inferred client-side fusion — not a substitute for processed Sentinel/Landsat rasters.";
  }
}

function refreshGeoIntelOverlays() {
  if (!map || !map.loaded()) return;
  const wx = getLatestWeatherLog();
  ensureGeoIntelLayers(map, {
    showStress: layerState.geoStress,
    showSpread: layerState.geoSpread,
    showNdviTiles: layerState.geoNdvi,
  });
  if (!layerState.geoStress) {
    setStressGridData(map, { type: "FeatureCollection", features: [] });
  }
  if (!layerState.geoSpread) {
    setSpreadData(map, null);
  }
  if (!layerState.geoStress && !layerState.geoSpread) {
    const narr = el("geo-narration");
    if (narr) narr.textContent = "Enable stress mesh or spread corridor to render land-scale fusion layers.";
    return;
  }

  const allFeatures = [];
  for (const f of fields) {
    if (!f.boundary?.coordinates || f.boundary.coordinates.length < 3) continue;
    const scan = scansByField[f.id];
    const ctx = contextByField[f.id] || null;
    const fc = buildStressGridGeoJson(f, scan || {}, wx, ctx, { historyMonthsAgo: timelineMonths });
    for (const ft of fc.features) {
      allFeatures.push({ ...ft, properties: { ...ft.properties, fieldId: f.id } });
    }
  }
  const collectionFc = { type: "FeatureCollection", features: allFeatures };
  if (layerState.geoStress) setStressGridData(map, collectionFc);

  const focus = previewFieldId
    ? fields.find((x) => x.id === previewFieldId)
    : fields.find((ff) => ff.boundary?.coordinates?.length >= 3);
  if (layerState.geoSpread && focus) {
    setSpreadData(map, buildSpreadWedgeFeature(focus, lastWindDeg));
  } else {
    setSpreadData(map, null);
  }

  const { meanStress, meanNdvi } = summarizeStressGrid(collectionFc);
  if (document.documentElement.dataset.agriPerf !== "low") {
    applyMapAmbientMood(wx, meanStress);
  }

  const narr = buildGeoNarration({
    fieldLabel: focus?.name || "",
    monthsAgo: timelineMonths,
    meanStress,
    meanNdvi,
    bearing: lastWindDeg,
  });
  let twinLine = "";
  try {
    if (focus) {
      twinLine = oneLineTwinHint(
        focus,
        scansByField[focus.id] || null,
        getLatestWeatherLog(),
        contextByField[focus.id] || null,
      );
    }
  } catch (_) {
    twinLine = "";
  }
  const narrEl = el("geo-narration");
  if (narrEl) narrEl.textContent = [narr, twinLine].filter(Boolean).join(" ");

  if (typeof mapUserId === "string" && focus?.id) {
    scheduleLandMemoryPersist(mapUserId, focus.id);
    void maybeEmitGeoAlert(mapUserId, focus.id);
  }
}

function scheduleLandMemoryPersist(userId, focusFieldId) {
  if (!userId || !focusFieldId || !layerState.geoStress) return;
  clearTimeout(geoPersistTimer);
  geoPersistTimer = setTimeout(async () => {
    const focus = fields.find((x) => x.id === focusFieldId);
    if (!focus) return;
    const wx = getLatestWeatherLog();
    const scan = scansByField[focusFieldId];
    const ctx = contextByField[focusFieldId];
    const fc = buildStressGridGeoJson(focus, scan || {}, wx, ctx || null, { historyMonthsAgo: timelineMonths });
    const { meanStress, meanNdvi } = summarizeStressGrid(fc);
    const periodKey = new Date().toISOString().slice(0, 7);
    try {
      await mergeGeoIntelSnapshot(db, userId, focusFieldId, periodKey, {
        inferred: {
          meanStress,
          meanNdviProxy: meanNdvi,
          windDeg: lastWindDeg,
          timelineMonths,
          fusionSignals: computeFusionSignals(focus, scan || {}, wx, ctx || null).map((s) => s.id),
        },
        observed: {
          basemap: getActiveBasemapDescriptor().id,
          satelliteNote: "Esri World Imagery mosaic — per-tile capture dates vary.",
        },
      });
    } catch (e) {
      console.warn("[geo] land memory:", e?.message || e);
    }
  }, 4000);
}

async function maybeEmitGeoAlert(userId, focusFieldId) {
  if (!userId || !focusFieldId || timelineMonths > 0) return;
  const focus = fields.find((x) => x.id === focusFieldId);
  if (!focus) return;
  const wx = getLatestWeatherLog();
  const scan = scansByField[focusFieldId];
  const ctx = contextByField[focusFieldId];
  const fc = buildStressGridGeoJson(focus, scan || {}, wx, ctx || null, { historyMonthsAgo: 0 });
  const { meanStress, meanNdvi } = summarizeStressGrid(fc);
  if (typeof meanStress !== "number" || meanStress < 0.72) return;
  const dayKey = new Date().toISOString().slice(0, 10);
  const k = `${focusFieldId}_${dayKey}`;
  if (lastGeoAlertKey === k) return;
  lastGeoAlertKey = k;
  try {
    await syncGeoDerivedAlerts(db, userId, {
      fieldId: focusFieldId,
      fieldName: focus.name,
      stressMean: meanStress,
      ndviProxy: meanNdvi,
      signals: computeFusionSignals(focus, scan || {}, wx, ctx || null),
    });
  } catch (e) {
    console.warn("[geo] alert:", e?.message || e);
  }
}

/* ══════════════════════════════════════════════
   MAP INIT
══════════════════════════════════════════════ */
function initMap(center) {
  map = new maplibregl.Map({
    container: "map-canvas",
    style: SATELLITE_STYLE,
    center,
    zoom: 14,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
  });

  map.once("load", () => {
    addFieldLayers();
    ensureRegionalMapLayers(map, "field-fills");
    if (regionalMapCache) setRegionalMapData(map, regionalMapCache);
    setRegionalMapVisible(map, layerState.regionalNetwork);
    updateGeoAttributionStrip();
    ensureGeoIntelLayers(map, {
      showStress: layerState.geoStress,
      showSpread: layerState.geoSpread,
      showNdviTiles: layerState.geoNdvi,
    });
    refreshGeoIntelOverlays();
    updateScale();
    map.on("zoom", updateScale);
  });
}

async function syncRegionalMapOverlay() {
  if (!map?.loaded()) return;
  ensureRegionalMapLayers(map, "field-fills");
  if (!layerState.regionalNetwork) {
    setRegionalMapVisible(map, false);
    return;
  }
  try {
    if (!regionalMapCache || !regionalMapCache.features?.length) {
      regionalMapCache = await fetchRegionalCellsForMap(db, undefined, 72);
    }
    setRegionalMapData(map, regionalMapCache);
  } catch (e) {
    console.warn("[regional] map overlay:", e?.message || e);
    setRegionalMapData(map, { type: "FeatureCollection", features: [] });
  }
  setRegionalMapVisible(map, true);
}

function addFieldLayers() {
  // GeoJSON source for all field polygons
  map.addSource("fields-src", {
    type: "geojson",
    data: buildFieldsGeoJSON(),
  });

  // Fill — colour by health
  map.addLayer({
    id: "field-fills",
    type: "fill",
    source: "fields-src",
    paint: {
      "fill-color": [
        "case",
        [">=", ["get", "health"], 80], "#22C55E",
        [">=", ["get", "health"], 40], "#F59E0B",
        "#EF4444",
      ],
      "fill-opacity": 0.3,
    },
  });

  // Outline
  map.addLayer({
    id: "field-outlines",
    type: "line",
    source: "fields-src",
    paint: {
      "line-color": [
        "case",
        [">=", ["get", "health"], 80], "#22C55E",
        [">=", ["get", "health"], 40], "#F59E0B",
        "#EF4444",
      ],
      "line-width": 2.5,
      "line-opacity": 0.9,
    },
  });

  // Click on field polygon → show preview
  map.on("click", "field-fills", (e) => {
    if (e.features?.length) {
      showFieldPreview(e.features[0].properties.id);
    }
  });
  map.on("mouseenter", "field-fills", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "field-fills", () => { map.getCanvas().style.cursor = ""; });
}

function buildFieldsGeoJSON() {
  const features = fields
    .filter(f => f.boundary?.coordinates?.length >= 3)
    .map(f => {
      const score = scansByField[f.id]?.healthScore ?? null;
      const ring = normalizeBoundaryCoords(f.boundary.coordinates).map(([lat, lng]) => [lng, lat]);
      ring.push(ring[0]);
      return {
        type: "Feature",
        id: f.id,
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {
          id: f.id,
          name: f.name || "Unnamed",
          health: typeof score === "number" ? score : -1,
          area: f.areaAcres ? `${parseFloat(f.areaAcres).toFixed(1)} ac` : "--",
          crop: f.cropType || "",
        },
      };
    });
  return { type: "FeatureCollection", features };
}

/* ── Update GeoJSON source ── */
function refreshFieldLayer() {
  const src = map?.getSource("fields-src");
  if (src) src.setData(buildFieldsGeoJSON());
  refreshHealthBadges();
  refreshGeoIntelOverlays();
}

/* ── Health badges (DOM Markers) ── */
function polygonCenter(coords) {
  const lats = coords.map(([, lat]) => lat);  // [lng, lat] format
  const lngs = coords.map(([lng]) => lng);
  return [
    (Math.min(...lngs) + Math.max(...lngs)) / 2,
    (Math.min(...lats) + Math.max(...lats)) / 2,
  ];
}

function refreshHealthBadges() {
  // Remove old markers
  fieldMarkers.forEach(({ marker }) => marker.remove());
  fieldMarkers = [];

  const showBadges = layerState.health && layerState.bounds;

  fields.filter(f => f.boundary?.coordinates?.length >= 3).forEach(f => {
    const score = scansByField[f.id]?.healthScore ?? null;
    const color = healthColor(score);
    const label = healthLabel(score);
    const ring = normalizeBoundaryCoords(f.boundary.coordinates).map(([lat, lng]) => [lng, lat]);
    const center = polygonCenter(ring);

    const div = document.createElement("div");
    div.className = "field-health-badge";
    const mood = getMapMoodDataset();
    const stressLike = mood === "stress" || mood === "watch";
    const lowScore = score !== null && score < 52;
    if (stressLike || lowScore) {
      if (document.documentElement.dataset.agriPerf !== "low") div.classList.add("field-health-badge--pulse");
    }
    if (!showBadges) div.style.display = "none";
    div.innerHTML = `
      <div class="fhb-name">${f.name || "Unnamed"}</div>
      <div class="fhb-score" style="color:${color}">${score !== null ? score + "%" : "--"}</div>
      <div class="fhb-area">${f.areaAcres ? parseFloat(f.areaAcres).toFixed(1) + " ac" : ""}</div>
      <div class="fhb-label" style="color:${color}">${label}</div>
    `;
    div.addEventListener("click", () => showFieldPreview(f.id));

    const mkr = new maplibregl.Marker({ element: div, anchor: "center" })
      .setLngLat(center)
      .addTo(map);

    fieldMarkers.push({ marker: mkr, fieldId: f.id, div });
  });
}

/* ── GPS dot (with NavIC/ISRO badge) ── */
function showGPSDot(lng, lat, gnssSource) {
  if (gpsMkr) { gpsMkr.remove(); gpsMkr = null; }
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:4px;";

  const dot = document.createElement("div");
  dot.className = "gps-dot";
  wrap.appendChild(dot);

  if (gnssSource) {
    const badge = document.createElement("div");
    badge.innerHTML = navicBadgeHTML(gnssSource);
    badge.style.cssText = "pointer-events:none;";
    wrap.appendChild(badge);
  }

  gpsMkr = new maplibregl.Marker({ element: wrap, anchor: "center" })
    .setLngLat([lng, lat])
    .addTo(map);
}

/* ── Scale bar ── */
function updateScale() {
  if (!map) return;
  const bounds = map.getBounds();
  const lat = (bounds.getNorth() + bounds.getSouth()) / 2;
  const metersPerPx = (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, map.getZoom());
  const scaleM = Math.round(metersPerPx * 60);
  const txt = el("mp-scale-txt");
  if (txt) txt.textContent = scaleM >= 1000 ? `${(scaleM / 1000).toFixed(1)} km` : `${scaleM} m`;
}

/* ══════════════════════════════════════════════
   LAYER CONTROLS
══════════════════════════════════════════════ */
function applyLayers() {
  if (!map?.getLayer) return;

  // Base style: satellite or street
  const currentStyle = typeof map.getStyle?.() === "object"
    ? map.getStyle().name
    : null;

  // Satellite toggle → switch base style
  const targetStyle = layerState.sat ? SATELLITE_STYLE : STREET_STYLE;
  // Only switch if needed (avoid expensive style reload every time)
  if (layerState._lastSat !== layerState.sat) {
    layerState._lastSat = layerState.sat;
    map.setStyle(targetStyle);
    map.once("style.load", () => {
      addFieldLayers();
      ensureRegionalMapLayers(map, "field-fills");
      if (regionalMapCache) setRegionalMapData(map, regionalMapCache);
      setRegionalMapVisible(map, layerState.regionalNetwork);
      refreshHealthBadges();
      updateGeoAttributionStrip();
      ensureGeoIntelLayers(map, {
        showStress: layerState.geoStress,
        showSpread: layerState.geoSpread,
        showNdviTiles: layerState.geoNdvi,
      });
      refreshGeoIntelOverlays();
    });
    return; // layers re-added in style.load handler
  }

  // Field outlines visibility
  const boundsVis = layerState.bounds ? "visible" : "none";
  if (map.getLayer("field-outlines")) map.setLayoutProperty("field-outlines", "visibility", boundsVis);

  // Health fill visibility
  const healthVis = layerState.health && layerState.bounds ? "visible" : "none";
  if (map.getLayer("field-fills")) map.setLayoutProperty("field-fills", "visibility", healthVis);

  // Badge visibility
  const showBadges = layerState.health && layerState.bounds;
  fieldMarkers.forEach(({ div }) => { div.style.display = showBadges ? "block" : "none"; });

  ensureGeoIntelLayers(map, {
    showStress: layerState.geoStress,
    showSpread: layerState.geoSpread,
    showNdviTiles: layerState.geoNdvi,
  });
  refreshGeoIntelOverlays();
  if (layerState.regionalNetwork) {
    syncRegionalMapOverlay();
  } else {
    setRegionalMapVisible(map, false);
  }
}

function bindLayerToggles() {
  const map_toggle = (id, key) => {
    el(id)?.addEventListener("change", (e) => {
      layerState[key] = e.target.checked;
      applyLayers();
    });
  };
  map_toggle("lyr-sat",       "sat");
  map_toggle("lyr-bounds",    "bounds");
  map_toggle("lyr-health",    "health");
  map_toggle("lyr-moisture",  "moisture");
  map_toggle("lyr-weather",   "weather");
  map_toggle("lyr-pest",      "pest");
  map_toggle("lyr-irrigation","irrigation");
  map_toggle("lyr-geo-ndvi",     "geoNdvi");
  map_toggle("lyr-geo-stress",   "geoStress");
  map_toggle("lyr-geo-spread",   "geoSpread");

  el("lyr-regional-network")?.addEventListener("change", async (e) => {
    layerState.regionalNetwork = e.target.checked;
    if (e.target.checked) regionalMapCache = null;
    await syncRegionalMapOverlay();
    if (!e.target.checked) applyLayers();
  });

  el("btn-reset-layers")?.addEventListener("click", () => {
    layerState = {
      sat: true, bounds: true, health: true, moisture: false, weather: true, pest: false, irrigation: false,
      geoStress: false, geoSpread: false, geoNdvi: false, regionalNetwork: false,
    };
    regionalMapCache = null;
    el("lyr-sat").checked = true; el("lyr-bounds").checked = true;
    el("lyr-health").checked = true; el("lyr-moisture").checked = false;
    el("lyr-weather").checked = true; el("lyr-pest").checked = false;
    el("lyr-irrigation").checked = false;
    if (el("lyr-geo-ndvi")) el("lyr-geo-ndvi").checked = false;
    if (el("lyr-geo-stress")) el("lyr-geo-stress").checked = false;
    if (el("lyr-geo-spread")) el("lyr-geo-spread").checked = false;
    if (el("lyr-regional-network")) el("lyr-regional-network").checked = false;
    applyLayers();
  });
}

/* ══════════════════════════════════════════════
   PANEL CONTROLS
══════════════════════════════════════════════ */
function openPanel(id) {
  document.querySelectorAll(".mp-panel").forEach(p => p.classList.remove("open"));
  el(id)?.classList.add("open");
  el("mp-backdrop")?.classList.add("show");
  if (id === "panel-geo") {
    if (el("lyr-geo-stress")) el("lyr-geo-stress").checked = !!layerState.geoStress;
    if (el("lyr-geo-spread")) el("lyr-geo-spread").checked = !!layerState.geoSpread;
    if (el("geo-timeline")) el("geo-timeline").value = String(timelineMonths);
    updateGeoAttributionStrip();
  }
  if (id === "panel-layers" && el("lyr-regional-network")) {
    el("lyr-regional-network").checked = !!layerState.regionalNetwork;
  }
}
function closeAllPanels() {
  document.querySelectorAll(".mp-panel").forEach(p => p.classList.remove("open"));
  el("mp-backdrop")?.classList.remove("show");
}

/* ══════════════════════════════════════════════
   FIELD PREVIEW SHEET
══════════════════════════════════════════════ */
function showFieldPreview(fieldId) {
  const field = fields.find(f => f.id === fieldId);
  if (!field) return;
  previewFieldId = fieldId;

  const scan  = scansByField[fieldId];
  const score = scan?.healthScore ?? null;
  const color = healthColor(score);
  const label = healthLabel(score);

  // Header
  if (el("fp-name")) el("fp-name").textContent = field.name || "Unnamed Field";

  // Chips
  const chips = [];
  if (field.areaAcres)   chips.push(`${parseFloat(field.areaAcres).toFixed(1)} acres`);
  if (field.cropType)    chips.push(field.cropType);
  if (field.soilType)    chips.push(field.soilType);
  if (field.irrigationType) chips.push(field.irrigationType);
  if (el("fp-chips")) el("fp-chips").innerHTML = chips.map(c => `<span class="mp-preview-chip">${c}</span>`).join("");

  // Health ring
  const ring = el("fp-ring");
  if (ring) {
    ring.style.background = `conic-gradient(${color} ${score ?? 0}%, rgba(255,255,255,0.06) ${score ?? 0}%)`;
    ring.style.boxShadow  = `0 0 24px ${color}44`;
  }
  if (el("fp-score")) { el("fp-score").textContent = score !== null ? `${score}%` : "--"; el("fp-score").style.color = color; }

  // Stats
  if (el("fp-moisture")) el("fp-moisture").textContent = field.soilMoisture ? `${field.soilMoisture}%` : "--";
  if (el("fp-area")) el("fp-area").textContent = field.areaAcres ? `${parseFloat(field.areaAcres).toFixed(1)} ac` : "--";

  // Scan time
  const scanTime = tsMs(scan?.createdAt);
  if (el("fp-scan-time")) el("fp-scan-time").textContent = timeAgo(scanTime);

  // Risk badge
  const riskEl = el("fp-risk");
  if (riskEl) {
    if (score === null) { riskEl.textContent = ""; }
    else {
      const riskColor = color;
      const riskText  = score >= 80 ? "Low Risk" : score >= 40 ? "Moderate" : "High Risk";
      riskEl.textContent = riskText;
      riskEl.style.cssText = `background:${riskColor}22;color:${riskColor};border:1px solid ${riskColor}44;border-radius:10px;padding:4px 10px;font-size:11px;font-weight:600;display:inline-flex;align-items:center;`;
    }
  }

  // View button
  if (el("fp-view-btn")) el("fp-view-btn").onclick = () => { window.location.href = `fields.html`; };

  refreshGeoIntelOverlays();

  el("field-preview")?.classList.add("open");
}

/* ══════════════════════════════════════════════
   NEARBY PLACES RENDERING
══════════════════════════════════════════════ */
function catGroup(cat) {
  if (["store","agri","market"].includes(cat)) return "store";
  if (["hospital","school","fuel"].includes(cat)) return "hospital";
  if (["water"].includes(cat)) return "water";
  return "other";
}

function renderNearby() {
  const container = el("nearby-list");
  if (!container) return;

  const filtered = activeCat === "all"
    ? nearbyPlaces
    : nearbyPlaces.filter(p => catGroup(p.category) === activeCat || p.category === activeCat);

  if (!filtered.length) {
    container.innerHTML = `<div class="mp-nearby-empty">No nearby places found</div>`;
    return;
  }

  container.innerHTML = filtered.slice(0, 12).map((p, i) => {
    const cat = CATEGORIES[p.category] || { icon: "📍", color: "#94A3B8", label: p.category };
    return `
    <div class="mp-place-item" style="animation-delay:${i * 50}ms">
      <div class="mp-place-icon" style="border-color:${cat.color}22;background:${cat.color}11;">${cat.icon}</div>
      <div class="mp-place-info">
        <div class="mp-place-name">${p.name}</div>
        <div class="mp-place-type">${cat.label}</div>
      </div>
      <div class="mp-place-dist" style="color:${cat.color}">${p.distLabel}</div>
    </div>`;
  }).join("");
}

/* ══════════════════════════════════════════════
   WEATHER IN HEADER
══════════════════════════════════════════════ */
async function loadMapWeather(lat, lng) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&hourly=relativehumidity_2m,windspeed_10m,winddirection_10m&timezone=auto`;
    const res = await fetch(url);
    const data = await res.json();
    const cw = data.current_weather;
    if (!cw) return;
    const hIdx = data.hourly?.time?.findIndex(t => t === cw.time) ?? 0;
    const hum  = data.hourly?.relativehumidity_2m?.[hIdx >= 0 ? hIdx : 0] ?? "--";
    const wdir = data.hourly?.winddirection_10m?.[hIdx >= 0 ? hIdx : 0];
    if (typeof wdir === "number") lastWindDeg = wdir;
    if (el("mp-w-temp"))  el("mp-w-temp").textContent  = `${Math.round(cw.temperature)}°C`;
    if (el("mp-w-hum"))   el("mp-w-hum").textContent   = `${hum}%`;
    if (el("mp-w-wind"))  el("mp-w-wind").textContent  = `${Math.round(cw.windspeed)} km/h`;
    // Sync field preview temperature
    if (el("fp-temp")) el("fp-temp").textContent = `${Math.round(cw.temperature)}°C`;
    refreshGeoIntelOverlays();
  } catch (e) {
    console.warn("[Map] Weather fetch failed:", e.message);
  }
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    try {
      return AbortSignal.timeout(ms);
    } catch (_) {}
  }
  const c = new AbortController();
  setTimeout(() => {
    try {
      c.abort();
    } catch (_) {}
  }, ms);
  return c.signal;
}

/* ══════════════════════════════════════════════
   MAIN BOOT
══════════════════════════════════════════════ */
onAuthStateChanged(auth, async (user) => {
  if (!user) { window.location.replace("login.html"); return; }
  mapUserId = user.uid;

  /* ── 1. Quick IP location → init map immediately ── */
  let initCenter = [78.9629, 22.5937]; // India fallback [lng, lat]
  try {
    const ip = await fetch("https://ip-api.com/json/?fields=lat,lon", { signal: createTimeoutSignal(3000) });
    const ipD = await ip.json();
    if (ipD.lat) initCenter = [ipD.lon, ipD.lat];
  } catch (_) {}
  const pinnedWx = peekActiveWeatherLocation();
  if (pinnedWx && typeof pinnedWx.lat === "number" && typeof pinnedWx.lon === "number") {
    initCenter = [pinnedWx.lon, pinnedWx.lat];
  }

  initMap(initCenter);
  bindLayerToggles();

  /* ── 2. Firestore: stream fields ── */
  const fieldsQ = query(collection(db, "fields"), where("userId", "==", user.uid));
  onSnapshot(fieldsQ, (snap) => {
    fields = [];
    snap.forEach(d => fields.push({ id: d.id, ...d.data() }));
    if (map.loaded()) {
      refreshFieldLayer();
    } else {
      map.once("load", refreshFieldLayer);
    }
    // Fit map to field bounds if any mapped fields exist
    fitToFields();
  });

  /* ── 3. Firestore: stream scans (for health scores) ── */
  const scansQ = query(collection(db, "crop_scans"), where("userId", "==", user.uid), orderBy("createdAt", "desc"), limit(200));
  onSnapshot(scansQ, (snap) => {
    scansByField = {};
    snap.forEach(d => {
      const s = d.data();
      if (s.fieldId && !scansByField[s.fieldId]) {
        scansByField[s.fieldId] = { ...s, id: d.id };
      }
    });
    if (map.loaded()) refreshFieldLayer();
  });

  onSnapshot(query(collection(db, "field_context_state"), where("userId", "==", user.uid), limit(40)), (snap) => {
    contextByField = {};
    snap.forEach((d) => { contextByField[d.id] = { fieldId: d.id, ...d.data() }; });
    if (map?.loaded()) refreshGeoIntelOverlays();
  });

  onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(15)), (snap) => {
    weatherLogs = [];
    snap.forEach((d) => weatherLogs.push({ id: d.id, ...d.data() }));
    if (map?.loaded()) refreshGeoIntelOverlays();
  });

  /* ── 4. GPS (NavIC / ISRO on compatible devices) ── */
  navigator.geolocation?.getCurrentPosition((pos) => {
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    const gnssSource = detectGNSSSource(lat, lng, accuracy ?? null);
    showGPSDot(lng, lat, gnssSource);
    loadMapWeather(lat, lng);
  }, () => {}, NAVIC_GPS_OPTIONS);

  /* ── 5. Location intelligence (nearby places) ── */
  runLocationIntelligence(user.uid, (data) => {
    if (data.places?.length) {
      nearbyPlaces = data.places;
      renderNearby();
      el("nearby-list") && nearbyPlaces.length === 0 &&
        (el("nearby-list").innerHTML = '<div class="mp-nearby-empty">No places found nearby</div>');
    }
  }, { radius: 3000, persist: false });

  /* ── 6. FAB bindings ── */
  el("fab-layers")?.addEventListener("click", () => openPanel("panel-layers"));
  el("fab-geo")?.addEventListener("click", () => openPanel("panel-geo"));
  el("fab-nearby")?.addEventListener("click", () => {
    openPanel("panel-nearby");
    if (!nearbyPlaces.length) {
      el("nearby-list").innerHTML = `<div class="mp-nearby-loading"><div class="mp-skeleton"></div><div class="mp-skeleton"></div><div class="mp-skeleton"></div></div>`;
    }
  });
  el("fab-3d")?.addEventListener("click", () => {
    is3D = !is3D;
    map.easeTo({ pitch: is3D ? 55 : 0, duration: 500 });
    el("fab-3d")?.classList.toggle("active", is3D);
  });
  el("fab-gps")?.addEventListener("click", () => {
    el("fab-gps")?.classList.add("active");
    navigator.geolocation?.getCurrentPosition((pos) => {
      const { latitude: lat, longitude: lng, accuracy } = pos.coords;
      const gnssSource = detectGNSSSource(lat, lng, accuracy ?? null);
      showGPSDot(lng, lat, gnssSource);
      map.flyTo({ center: [lng, lat], zoom: 16, essential: true, speed: 1.4 });
      el("fab-gps")?.classList.remove("active");
    }, () => el("fab-gps")?.classList.remove("active"),
    NAVIC_GPS_OPTIONS);
  });
  el("fab-search")?.addEventListener("click", () => {
    const q = prompt("Search a location:");
    if (!q) return;
    fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&lang=en`)
      .then(r => r.json())
      .then(d => {
        const f = d.features?.[0];
        if (f?.geometry?.coordinates) {
          const [lng, lat] = f.geometry.coordinates;
          map.flyTo({ center: [lng, lat], zoom: 15, essential: true });
        }
      }).catch(() => {});
  });

  /* ── 7. Panel close bindings ── */
  el("close-layers")?.addEventListener("click", closeAllPanels);
  el("close-nearby")?.addEventListener("click", closeAllPanels);
  el("close-geo")?.addEventListener("click", closeAllPanels);
  el("mp-backdrop")?.addEventListener("click", closeAllPanels);
  el("fp-close")?.addEventListener("click", () => el("field-preview")?.classList.remove("open"));

  el("geo-timeline")?.addEventListener("input", (e) => {
    timelineMonths = Math.max(0, Math.min(6, Number(e.target.value) || 0));
    refreshGeoIntelOverlays();
  });

  /* ── 8. Category chips ── */
  el("nearby-cats")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cat]");
    if (!chip) return;
    activeCat = chip.dataset.cat;
    el("nearby-cats").querySelectorAll(".mp-cat-chip").forEach(c => c.classList.toggle("active", c === chip));
    renderNearby();
  });
});

/* ── Fit map to all mapped fields ── */
function fitToFields() {
  const mapped = fields.filter(f => f.boundary?.coordinates?.length >= 3);
  if (!mapped.length || !map) return;
  const allCoords = mapped.flatMap(f => normalizeBoundaryCoords(f.boundary.coordinates).map(([lat, lng]) => [lng, lat]));
  const lngs = allCoords.map(([lng]) => lng);
  const lats = allCoords.map(([, lat]) => lat);
  const sw = [Math.min(...lngs), Math.min(...lats)];
  const ne = [Math.max(...lngs), Math.max(...lats)];
  if (sw[0] === ne[0] && sw[1] === ne[1]) return;
  map.fitBounds([sw, ne], { padding: 80, maxZoom: 17, animate: true });
}
