/**
 * Full-screen regional intelligence map + briefing + optional calibration.
 */
import "./auth-session.js?v=33";
import { auth, db } from "./auth.js?v=32";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { fetchRegionalBriefing, fetchRegionalCellsForMap } from "./network/regional-briefing.js";
import {
  ensureRegionalMapLayers,
  setRegionalMapData,
  setRegionalMapVisible,
} from "./geo/regional-map-layers.js";
import { submitRegionalCalibration } from "./network/regional-calibration.js";
import { isoWeekKey } from "./network/regional-privacy.js";

function el(id) {
  return document.getElementById(id);
}

const SATELLITE_STYLE = {
  version: 8,
  glyphs: "https://fonts.openmaptiles.org/{fontstack}/{range}.pbf",
  sources: {
    esri: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© Esri",
    },
  },
  layers: [{ id: "esri-sat", type: "raster", source: "esri" }],
};

function populateCellSelect(fc) {
  const sel = el("reg-cell");
  if (!sel) return;
  sel.innerHTML = '<option value="">Select coarse cell…</option>';
  const feats = fc?.features || [];
  for (const f of feats) {
    const id = f.properties?.cellId;
    if (!id) continue;
    const opt = document.createElement("option");
    opt.value = id;
    const s = typeof f.properties.stress === "number" ? Math.round(f.properties.stress * 100) : "—";
    opt.textContent = `${id} · blended stress ~${s}%`;
    sel.appendChild(opt);
  }
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const map = new maplibregl.Map({
    container: "reg-map-canvas",
    style: SATELLITE_STYLE,
    center: [78.96, 20.59],
    zoom: 5.2,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), "top-right");

  async function loadAll() {
    const briefEl = el("reg-brief");
    try {
      if (briefEl) briefEl.textContent = await fetchRegionalBriefing(db);
      const fc = await fetchRegionalCellsForMap(db, undefined, 80);
      populateCellSelect(fc);
      if (map.loaded()) {
        ensureRegionalMapLayers(map, "__no_field_layer__");
        setRegionalMapData(map, fc);
        setRegionalMapVisible(map, true);
      }
    } catch (e) {
      console.warn("[regional-view]", e?.message || e);
      if (briefEl) briefEl.textContent = "Could not load regional data. Check Firestore rules and try again.";
    }
  }

  map.once("load", () => {
    loadAll();
  });

  el("reg-refresh")?.addEventListener("click", () => loadAll());

  el("reg-vote-align")?.addEventListener("click", async () => {
    const cellId = el("reg-cell")?.value;
    if (!cellId) {
      alert("Choose a cell from the list (cells appear when the network has anonymized contributions this week).");
      return;
    }
    const r = await submitRegionalCalibration(db, user.uid, isoWeekKey(), cellId, "align");
    alert(
      r.ok
        ? "Thanks — your anonymous calibration nudges trust weighting for that coarse cell."
        : `Not recorded: ${r.reason || "error"}`,
    );
  });

  el("reg-vote-down")?.addEventListener("click", async () => {
    const cellId = el("reg-cell")?.value;
    if (!cellId) {
      alert("Choose a cell first.");
      return;
    }
    const r = await submitRegionalCalibration(db, user.uid, isoWeekKey(), cellId, "too_alarmist");
    alert(
      r.ok
        ? "Recorded — we’ll down-weight alarmism for that cell aggregate."
        : `Not recorded: ${r.reason || "error"}`,
    );
  });
});
