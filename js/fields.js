import "./auth-session.js?v=31";
import "./i18n.js";
import { auth, db, storage } from "./auth.js?v=31";
import { FALLBACK_LOC } from "./weather-location.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  writeBatch,
  where,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const DRAFT_KEY = "agri_field_wizard_draft";

function el(id) {
  return document.getElementById(id);
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

const FALLBACK_MAP_CENTER = [FALLBACK_LOC.lat, FALLBACK_LOC.lon];

/** Fresh GPS fix only — no cached coordinates for map center accuracy. */
function getLiveDeviceCenter() {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) {
      resolve(FALLBACK_MAP_CENTER);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve([pos.coords.latitude, pos.coords.longitude]),
      () => resolve(FALLBACK_MAP_CENTER),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 25000 },
    );
  });
}

function polygonAreaSqM(points) {
  if (!points || points.length < 3) return 0;
  const R = 6378137;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [lat1d, lon1d] = points[i];
    const [lat2d, lon2d] = points[(i + 1) % points.length];
    const lat1 = (lat1d * Math.PI) / 180;
    const lat2 = (lat2d * Math.PI) / 180;
    const lon1 = (lon1d * Math.PI) / 180;
    const lon2 = (lon2d * Math.PI) / 180;
    area += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((area * R * R) / 2);
}

function sqMetersToAcres(sqM) {
  return sqM * 0.000247105;
}

function setNotifBadge(count) {
  const badge = el("fields-notif-badge");
  if (!badge) return;
  badge.textContent = String(count);
  badge.classList.toggle("hidden", count <= 0);
}

function scoreToStatus(score) {
  if (typeof score !== "number") return { label: "Not monitored", color: "var(--dim)" };
  if (score >= 80) return { label: "Healthy", color: "var(--neon)" };
  if (score >= 50) return { label: "Moderate", color: "var(--warn)" };
  return { label: "At risk", color: "var(--danger)" };
}

function aiRiskLabel(scan) {
  if (!scan) return { text: "—", cls: "" };
  const pr = pestQuick(scan);
  if (pr >= 60) return { text: "High", cls: "risk-high" };
  if (pr >= 35) return { text: "Med", cls: "risk-med" };
  return { text: "Low", cls: "risk-low" };
}

function pestQuick(scan) {
  if (!scan) return 0;
  let p = 10;
  if (scan.severity?.level === "critical") p += 38;
  else if (scan.severity?.level === "moderate") p += 20;
  const t = `${scan.diagnosis || ""} ${(scan.observedSymptoms || []).join(" ")}`.toLowerCase();
  if (/pest|insect|borer|aphid/.test(t)) p += 28;
  return Math.min(95, p);
}

function persistDraft() {
  try {
    const payload = {
      step: wizardStep,
      name: el("field-name")?.value || "",
      crop: el("field-crop")?.value || "",
      soil: el("field-soil")?.value || "",
      irrigation: el("field-irrigation")?.value || "",
      area: el("field-area")?.value || "",
      planted: el("field-planted")?.value || "",
      notes: el("field-notes")?.value || "",
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
  } catch {}
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (el("field-name") && p.name) el("field-name").value = p.name;
    if (el("field-crop") && p.crop) el("field-crop").value = p.crop;
    if (el("field-soil") && p.soil) el("field-soil").value = p.soil;
    if (el("field-irrigation") && p.irrigation) el("field-irrigation").value = p.irrigation;
    if (el("field-area") && p.area) el("field-area").value = p.area;
    if (el("field-planted") && p.planted) el("field-planted").value = p.planted;
    if (el("field-notes") && p.notes) el("field-notes").value = p.notes;
    // Step 2 = full-screen map; don't restore it into the modal wizard
    if (typeof p.step === "number") wizardStep = p.step === 2 ? 1 : clamp(p.step, 1, 4);
  } catch {}
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {}
}

let wizardStep = 1;

function updateWizardUi() {
  // Step 2 is the full-screen map — handled by openFmsMap(), never shown in modal.
  // updateWizardUi only manages steps 1, 3, 4 inside the modal.
  el("field-map-fullscreen")?.classList.add("hidden");

  const displayStep = wizardStep === 2 ? 3 : wizardStep; // map step skipped in modal
  for (let i = 1; i <= 4; i++) {
    el(`wiz-step-${i}`)?.classList.toggle("hidden", i !== wizardStep);
  }
  const prog = el("wizard-progress-fill");
  if (prog) prog.style.width = `${(displayStep / 4) * 100}%`;
  el("wizard-step-label") && (el("wizard-step-label").textContent = `Step ${displayStep} of 4`);
  el("wiz-back-btn")?.classList.toggle("hidden", wizardStep === 1);
  const next = el("wiz-next-btn");
  if (next) next.textContent = wizardStep === 4 ? "Save field" : "Next";
  persistDraft();
}

function renderFieldCard({ index, field, latestScan, soilMoisture }) {
  const score = latestScan && typeof latestScan.healthScore === "number" ? latestScan.healthScore : null;
  const status = scoreToStatus(score);
  const pct = typeof score === "number" ? clamp(Math.round(score), 0, 100) : null;
  const mapped = Array.isArray(field?.boundary?.coordinates) && field.boundary.coordinates.length >= 3;
  const ringBg =
    pct === null ? "rgba(255,255,255,0.06)" : `conic-gradient(${status.color} ${pct}%, rgba(255,255,255,0.06) ${pct}%)`;
  const ringInner = pct === null ? "—" : `${pct}%`;
  const areaText = typeof field.areaAcres === "number" ? `${field.areaAcres.toFixed(1)} ac` : "—";
  const crop = field.cropType || "Crop not set";
  const risk = aiRiskLabel(latestScan);
  const moist =
    typeof soilMoisture === "number" ? `${Math.round(soilMoisture)}%` : "—";
  const imgUrl = field.imageUrl;
  const thumb = imgUrl
    ? `<img class="fc-img" src="${imgUrl.replace(/"/g, "&quot;")}" alt="" loading="lazy"/>`
    : `<div class="fc-img-ph"><i class="ri-landscape-line"></i></div>`;

  return `
    <div class="field-card" data-field-id="${field.id}">
      <button type="button" class="fc-edit" data-edit-id="${field.id}" aria-label="Quick edit"><i class="ri-edit-2-line"></i></button>
      <div class="fc-img-box">
        ${thumb}
        <div class="fc-img-overlay"></div>
        <div class="fc-num" style="color:${status.color}; border-color:${status.color};">${index + 1}</div>
      </div>
      <div class="fc-main">
        <h4>${field.name || `Field ${String(field.id).slice(0, 6)}`}</h4>
        <p class="fc-type" style="color:${status.color};">${crop}</p>
        <div class="fc-details">
          <p>Area: ${areaText} · ${mapped ? "Mapped" : "Unmapped"}</p>
          <p>Moisture est.: ${moist} · AI risk: <span class="${risk.cls}">${risk.text}</span></p>
        </div>
      </div>
      <div class="fc-metrics">
        <div class="fc-score">
          <p>Health</p>
          <div class="score-ring" style="background: ${ringBg};">
            <div class="score-ring-inner">${ringInner}</div>
          </div>
          <span class="score-status" style="color:${status.color};">${status.label}</span>
        </div>
        <i class="ri-arrow-right-s-line fc-arrow"></i>
      </div>
    </div>
  `;
}

function renderHolograms(container, fields, latestByField) {
  if (!container) return;
  container.innerHTML = "";
  const items = fields.slice(0, 5);
  if (!items.length) return;

  for (let i = 0; i < items.length; i++) {
    const f = items[i];
    const s = latestByField.get(f.id);
    const score = s && typeof s.healthScore === "number" ? s.healthScore : null;
    const st = scoreToStatus(score);
    const poly = document.createElement("div");
    poly.className = "f-poly";
    if (score === null) {
      poly.style.borderColor = "rgba(57,255,20,0.2)";
      poly.style.boxShadow = "inset 0 0 20px rgba(57,255,20,0.08)";
    } else if (score >= 80) poly.classList.add("f-healthy");
    else if (score >= 50) poly.classList.add("f-moderate");
    else poly.classList.add("f-critical");
    if (i === 0) poly.style.gridRow = "1/3";
    const marker = document.createElement("div");
    marker.className = "f-marker";
    marker.style.color = score === null ? "rgba(148,163,184,0.8)" : st.color;
    marker.innerHTML = `<i class="${score === null ? "ri-question-line" : score >= 80 ? "ri-leaf-fill" : score >= 50 ? "ri-bug-line" : "ri-error-warning-fill"}"></i>`;
    poly.appendChild(marker);
    container.appendChild(poly);
  }
}

window.openAddFieldModal = () => {
  el("add-field-modal")?.classList.remove("hidden");
};
window.closeAddFieldModal = () => {
  el("add-field-modal")?.classList.add("hidden");
};

let teardown = null;
let fieldsUiBound = false;

function mountFieldsPage(user) {
  const unsubs = [];

  const avatar = el("fields-avatar");
  if (avatar) {
    const name = user.displayName || (user.email ? user.email.split("@")[0] : "Farmer");
    avatar.src = user.photoURL
      ? user.photoURL
      : `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=39ff14&color=000`;
  }

  unsubs.push(
    onSnapshot(query(collection(db, "notifications"), where("userId", "==", user.uid), limit(50)), (snap) => {
      let unread = 0;
      snap.forEach((d) => {
        const v = d.data();
        if (!v.readAt) unread += 1;
      });
      setNotifBadge(unread);
    }),
  );

  const fieldsListEl = el("fields-list");
  const hologramsEl = el("fields-holograms");
  const mapEmpty = el("fields-map-empty");
  const fieldsQ = query(collection(db, "fields"), where("userId", "==", user.uid), limit(200));
  const scansQ = query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(500));

  let fields = [];
  let scans = [];
  let fieldMapById = new Map();
  let latestWeatherMoisture = null;
  let fmsUiBound = false;
  let accuracyMarker = null;
  let accuracyCircle = null;

  /* ══════════════════════════════════════════════════
     FULL-SCREEN MAP OVERLAY FUNCTIONS
  ══════════════════════════════════════════════════ */

  async function openFmsMap() {
    el("add-field-modal")?.classList.add("hidden");
    el("field-map-fullscreen")?.classList.remove("hidden");

    await initMapIfNeeded();
    map.resize(); // tell MapLibre the container is now visible

    if (drawingPoints.length >= 1) {
      redrawDrawing();
      if (drawingPoints.length === 1) {
        map.flyTo({ center: [drawingPoints[0][1], drawingPoints[0][0]], zoom: 16 });
      } else {
        const lngs = drawingPoints.map(([, lng]) => lng);
        const lats = drawingPoints.map(([lat]) => lat);
        map.fitBounds(
          [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]],
          { padding: 80, maxZoom: 17, animate: true }
        );
      }
    } else {
      centerOnGPSHighAccuracy(true);
    }

    updateFmsPointsLabel();
    if (!fmsUiBound) initFmsBindings();
  }

  function closeFmsMap() {
    el("field-map-fullscreen")?.classList.add("hidden");
    wizardStep = 1;
    // Re-show the modal at step 1
    el("field-map-fullscreen")?.classList.add("hidden");
    for (let i = 1; i <= 4; i++) {
      el(`wiz-step-${i}`)?.classList.toggle("hidden", i !== 1);
    }
    el("wiz-back-btn")?.classList.add("hidden");
    el("wiz-next-btn") && (el("wiz-next-btn").textContent = "Next");
    el("add-field-modal")?.classList.remove("hidden");
  }

  function confirmFmsMap() {
    el("field-map-fullscreen")?.classList.add("hidden");
    wizardStep = 3;
    el("add-field-modal")?.classList.remove("hidden");
    for (let i = 1; i <= 4; i++) {
      el(`wiz-step-${i}`)?.classList.toggle("hidden", i !== 3);
    }
    el("wizard-step-label") && (el("wizard-step-label").textContent = "Step 3 of 4");
    const prog = el("wizard-progress-fill");
    if (prog) prog.style.width = "75%";
    el("wiz-back-btn")?.classList.remove("hidden");
    el("wiz-next-btn") && (el("wiz-next-btn").textContent = "Next");
    persistDraft();
  }

  function centerOnGPSHighAccuracy(silent = false) {
    const badge   = el("fms-gps-badge");
    const accText = el("fms-accuracy-text");
    const btn     = el("fms-gps-btn");

    if (!silent && badge)   { badge.style.display = "block"; }
    if (!silent && accText) { accText.textContent = "Locating…"; }
    if (btn) btn.classList.add("active");

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
        if (btn) btn.classList.remove("active");
        if (!map) return;

        const zoom = acc < 20 ? 19 : acc < 100 ? 17 : acc < 500 ? 15 : 13;

        // Smooth fly-to with MapLibre
        map.flyTo({ center: [lng, lat], zoom, essential: true, speed: 1.4 });

        // GPS dot marker (MapLibre DOM marker)
        if (_gpsMLMarker) { _gpsMLMarker.remove(); _gpsMLMarker = null; }
        const dotEl = document.createElement("div");
        dotEl.style.cssText = [
          "width:20px", "height:20px", "border-radius:50%",
          "background:#0A84FF", "border:3px solid #fff",
          "box-shadow:0 2px 12px rgba(10,132,255,0.55)",
          "animation:gpsPulse 1.8s ease-in-out infinite",
        ].join(";");
        _gpsMLMarker = new maplibregl.Marker({ element: dotEl })
          .setLngLat([lng, lat])
          .addTo(map);

        // Accuracy circle via GeoJSON source
        const accSrc = map.getSource("fms-gps-acc");
        if (accSrc) {
          accSrc.setData({ type: "FeatureCollection", features: [circleFeature(lat, lng, acc)] });
        }

        if (!silent) {
          if (badge)   badge.style.display = "block";
          if (accText) accText.textContent = `±${Math.round(acc)} m`;
          fmsToast(`Located · ±${Math.round(acc)} m accuracy`);
        }
      },
      (err) => {
        if (btn) btn.classList.remove("active");
        if (!silent) {
          if (badge) badge.style.display = "none";
          fmsToast("GPS unavailable — " + err.message);
        }
      },
      { enableHighAccuracy: true, timeout: 14000, maximumAge: 0 }
    );
  }

  function initFmsBindings() {
    if (fmsUiBound) return;
    fmsUiBound = true;

    el("fms-back-btn")?.addEventListener("click", closeFmsMap);
    el("fms-confirm-hdr-btn")?.addEventListener("click", confirmFmsMap);
    el("fms-confirm-full-btn")?.addEventListener("click", confirmFmsMap);

    el("fms-undo-btn")?.addEventListener("click", () => {
      drawingPoints.pop();
      redrawDrawing();
      updateFmsPointsLabel();
    });
    el("fms-clear-btn")?.addEventListener("click", () => {
      clearDrawing();
      updateFmsPointsLabel();
    });
    el("fms-gps-btn")?.addEventListener("click", () => centerOnGPSHighAccuracy(false));
    el("fms-3d-btn")?.addEventListener("click", toggle3D);
    el("fms-sat-btn")?.addEventListener("click", () => switchLayer(true));
    el("fms-str-btn")?.addEventListener("click", () => switchLayer(false));

    setupFmsSearch();
  }

  function setupFmsSearch() {
    let searchDebounce;
    let srFocusIdx = -1;
    const inp     = el("fms-search-input");
    const clearBtn = el("fms-search-clear");
    const dd      = el("fms-search-results");

    function hideFmsDropdown() {
      if (dd) dd.style.display = "none";
      srFocusIdx = -1;
    }

    function updateClearBtn() {
      if (clearBtn) clearBtn.style.display = inp?.value ? "flex" : "none";
    }

    function flyToResult(lng, lat, name) {
      if (!map) return;
      map.flyTo({ center: [lng, lat], zoom: 17, essential: true, speed: 1.6 });
      if (inp) inp.value = name;
      hideFmsDropdown();
      updateClearBtn();
    }

    /* Photon — free, no API key, returns OSM-backed autocomplete results */
    async function fetchPhoton(q) {
      try {
        const c = map?.getCenter();
        let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=en`;
        if (c) url += `&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`;

        const res  = await fetch(url);
        const data = await res.json();

        if (!dd) return;
        if (!data.features?.length) { hideFmsDropdown(); fmsToast("No results found"); return; }

        dd.innerHTML = data.features.map((f) => {
          const p    = f.properties;
          const name = p.name || p.city || p.country || "Unknown";
          const sub  = [p.city, p.state, p.country].filter(Boolean).join(", ");
          const [lng, lat] = f.geometry.coordinates;
          return `<div class="sr-item" data-lat="${lat}" data-lng="${lng}" data-name="${name}">
            <i class="ri-map-pin-2-line"></i>
            <div>
              <div class="sr-name">${name}</div>
              ${sub ? `<div class="sr-addr">${sub}</div>` : ""}
            </div>
          </div>`;
        }).join("");
        dd.style.display = "block";

        dd.querySelectorAll(".sr-item").forEach((item) => {
          item.addEventListener("mousedown", (e) => e.preventDefault());
          item.addEventListener("click", () =>
            flyToResult(parseFloat(item.dataset.lng), parseFloat(item.dataset.lat), item.dataset.name)
          );
        });
      } catch (_) {
        fmsToast("Search failed — check connection");
      }
    }

    clearBtn?.addEventListener("click", () => {
      if (inp) { inp.value = ""; inp.focus(); }
      hideFmsDropdown();
      updateClearBtn();
    });

    inp?.addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      updateClearBtn();
      const q = e.target.value.trim();
      if (q.length < 2) { hideFmsDropdown(); return; }
      searchDebounce = setTimeout(() => fetchPhoton(q), 320);
    });

    inp?.addEventListener("keydown", (e) => {
      const items = dd?.querySelectorAll(".sr-item") || [];
      if (e.key === "ArrowDown") {
        e.preventDefault();
        srFocusIdx = Math.min(srFocusIdx + 1, items.length - 1);
        items.forEach((it, i) => it.classList.toggle("sr-focused", i === srFocusIdx));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        srFocusIdx = Math.max(srFocusIdx - 1, -1);
        items.forEach((it, i) => it.classList.toggle("sr-focused", i === srFocusIdx));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (srFocusIdx >= 0 && items[srFocusIdx]) {
          const it = items[srFocusIdx];
          flyToResult(parseFloat(it.dataset.lng), parseFloat(it.dataset.lat), it.dataset.name);
        } else {
          const q = inp?.value.trim();
          if (q) fetchPhoton(q);
        }
      } else if (e.key === "Escape") {
        hideFmsDropdown();
      }
    });

    inp?.addEventListener("blur", () => setTimeout(hideFmsDropdown, 200));
  }

  /* END FULL-SCREEN MAP FUNCTIONS */

  function wizSnack(msg) {
    const s = el("wiz-snack");
    if (!s) return;
    s.textContent = msg;
    s.style.display = "block";
    clearTimeout(s._t);
    s._t = setTimeout(() => { s.style.display = "none"; }, 3500);
  }

  unsubs.push(
    onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(40)), (snap) => {
      let best = 0;
      let moisture = null;
      snap.forEach((d) => {
        const x = d.data();
        const t = tsToMs(x.fetchedAt);
        if (t >= best) {
          best = t;
          moisture = typeof x.derived?.soilMoistureEstimate === "number" ? x.derived.soilMoistureEstimate : null;
        }
      });
      latestWeatherMoisture = moisture;
      rerender();
    }),
  );

  /* ─────────────────────────────────────────────────────────
     MAP CONSTANTS
     Street style  → OpenFreeMap Liberty (vector, shows every
       village, store, shop, school, landmark — all OSM POIs)
     Satellite     → ESRI World Imagery + CartoDB Voyager labels
  ───────────────────────────────────────────────────────── */
  const STREET_STYLE = "https://tiles.openfreemap.org/styles/liberty";

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
          "https://d.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png",
        ],
        tileSize: 256, attribution: "© CARTO",
      },
    },
    layers: [
      { id: "esri-sat",      type: "raster", source: "esri" },
      { id: "carto-labels",  type: "raster", source: "cartolabels" },
    ],
  };

  /* Helper: create a circle polygon (GeoJSON Feature) for accuracy rings */
  function circleFeature(lat, lng, radiusM) {
    const coords = [];
    const R = 6378137;
    const latR = (lat * Math.PI) / 180;
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * 2 * Math.PI;
      const dLat = (radiusM * Math.cos(a)) / R;
      const dLng = (radiusM * Math.sin(a)) / (R * Math.cos(latR));
      coords.push([lng + (dLng * 180 / Math.PI), lat + (dLat * 180 / Math.PI)]);
    }
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [coords] }, properties: {} };
  }

  let editingFieldId = null;
  let map = null;
  let drawingPoints = [];
  let is3D = false;
  let isSatellite = true;
  let _gpsMLMarker = null; // maplibregl.Marker for GPS dot

  // FMS toast
  function fmsToast(msg, ms = 3000) {
    const t = el("fms-toast");
    if (!t) return;
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), ms);
  }

  function setActiveLayerBtns(sat) {
    el("fms-sat-btn")?.classList.toggle("active", sat);
    el("fms-str-btn")?.classList.toggle("active", !sat);
  }

  function switchLayer(satellite) {
    isSatellite = satellite;
    setActiveLayerBtns(satellite);
    if (!map) return;
    map.setStyle(satellite ? SATELLITE_STYLE : STREET_STYLE);
    map.once("style.load", () => {
      _addDrawingLayers();
      redrawDrawing();
    });
  }

  function toggle3D() {
    is3D = !is3D;
    map?.easeTo({ pitch: is3D ? 55 : 0, duration: 550 });
    el("fms-3d-btn")?.classList.toggle("active", is3D);
  }

  /* Add MapLibre GeoJSON sources + layers for boundary drawing.
     Called once after style loads (and again after every setStyle). */
  function _addDrawingLayers() {
    if (!map || map.getSource("fms-drawing")) return;

    map.addSource("fms-drawing", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    // Polygon fill
    map.addLayer({ id: "fms-poly-fill", type: "fill", source: "fms-drawing",
      filter: ["==", "$type", "Polygon"],
      paint: { "fill-color": "#4DABFF", "fill-opacity": 0.2 },
    });
    // Lines (polyline + polygon outline)
    map.addLayer({ id: "fms-line", type: "line", source: "fms-drawing",
      filter: ["in", "$type", "LineString", "Polygon"],
      paint: { "line-color": "#0A84FF", "line-width": 2.5, "line-opacity": 0.9 },
    });
    // Corner circles
    map.addLayer({ id: "fms-dots", type: "circle", source: "fms-drawing",
      filter: ["==", "$type", "Point"],
      paint: { "circle-radius": 8, "circle-color": "#0A84FF",
               "circle-stroke-color": "#fff", "circle-stroke-width": 2.5 },
    });
    // Corner number labels
    map.addLayer({ id: "fms-labels", type: "symbol", source: "fms-drawing",
      filter: ["==", "$type", "Point"],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 11, "text-anchor": "center",
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
      },
      paint: { "text-color": "#fff", "text-halo-color": "#0A84FF", "text-halo-width": 1 },
    });

    // GPS accuracy circle layer
    map.addSource("fms-gps-acc", { type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({ id: "fms-gps-fill", type: "fill", source: "fms-gps-acc",
      paint: { "fill-color": "#0A84FF", "fill-opacity": 0.08 },
    });
    map.addLayer({ id: "fms-gps-ring", type: "line", source: "fms-gps-acc",
      paint: { "line-color": "#0A84FF", "line-width": 1.2, "line-opacity": 0.5 },
    });
  }

  async function initMapIfNeeded() {
    if (map) return;
    const mapNode = el("fms-map");
    if (!mapNode) return;

    map = new maplibregl.Map({
      container: mapNode,
      style: STREET_STYLE,          // start with detailed street map (all OSM POIs)
      center: [FALLBACK_MAP_CENTER[1], FALLBACK_MAP_CENTER[0]], // [lng, lat]
      zoom: 14,
      pitch: 0,
      bearing: 0,
      attributionControl: false,
    });

    await new Promise((res) => map.once("load", res));
    _addDrawingLayers();

    map.on("click", (e) => {
      drawingPoints.push([e.lngLat.lat, e.lngLat.lng]);
      redrawDrawing();
      updateFmsPointsLabel();
      persistDraft();
    });
  }

  function updateFmsPointsLabel() {
    const n = drawingPoints.length;
    const lbl = el("fms-points-label");
    const confirmBtn = el("fms-confirm-full-btn");
    if (lbl) {
      if (n === 0) lbl.textContent = "Tap map to mark corners";
      else if (n < 3) lbl.textContent = `${n} point${n > 1 ? "s" : ""} · need ${3 - n} more`;
      else lbl.textContent = `${n} corners · polygon ready ✓`;
      lbl.classList.toggle("has-poly", n >= 3);
    }
    if (confirmBtn) confirmBtn.classList.toggle("ready", n >= 3);
  }

  function redrawDrawing() {
    const src = map?.getSource("fms-drawing");
    if (!src) return;

    const features = [];

    // Corner points
    drawingPoints.forEach(([lat, lng], i) => {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { label: String(i + 1) },
      });
    });

    // Connecting line
    if (drawingPoints.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString",
          coordinates: drawingPoints.map(([lat, lng]) => [lng, lat]) },
        properties: {},
      });
    }

    // Closed polygon
    if (drawingPoints.length >= 3) {
      const ring = [...drawingPoints.map(([lat, lng]) => [lng, lat])];
      ring.push(ring[0]); // close ring
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: {},
      });
      const acres = sqMetersToAcres(polygonAreaSqM(drawingPoints));
      if (el("field-area")) el("field-area").value = acres.toFixed(2);
    }

    src.setData({ type: "FeatureCollection", features });
  }

  function clearDrawing() {
    drawingPoints = [];
    redrawDrawing();
  }

  function openFieldModalForCreate() {
    editingFieldId = null;
    wizardStep = 1;
    if (el("field-modal-title")) el("field-modal-title").textContent = "New field";
    if (el("field-name")) el("field-name").value = "";
    if (el("field-crop")) el("field-crop").value = "";
    if (el("field-soil")) el("field-soil").value = "";
    if (el("field-irrigation")) el("field-irrigation").value = "";
    if (el("field-area")) el("field-area").value = "";
    if (el("field-planted")) el("field-planted").value = "";
    if (el("field-notes")) el("field-notes").value = "";
    if (el("field-cover")) el("field-cover").value = "";
    clearDrawing();
    loadDraft();
    updateWizardUi();
    window.openAddFieldModal();
  }

  function openFieldModalForEdit(fieldId) {
    const field = fieldMapById.get(fieldId);
    if (!field) return;
    editingFieldId = fieldId;
    wizardStep = 1;
    if (el("field-modal-title")) el("field-modal-title").textContent = "Edit field";
    if (el("field-name")) el("field-name").value = field.name || "";
    if (el("field-crop")) el("field-crop").value = field.cropType || "";
    if (el("field-soil")) el("field-soil").value = field.soilType || "";
    if (el("field-irrigation")) el("field-irrigation").value = field.irrigationType || "";
    if (el("field-area")) el("field-area").value = typeof field.areaAcres === "number" ? field.areaAcres.toFixed(2) : "";
    if (el("field-planted")) el("field-planted").value = field.plantedAt || "";
    if (el("field-notes")) el("field-notes").value = field.notes || "";
    drawingPoints = Array.isArray(field?.boundary?.coordinates)
      ? field.boundary.coordinates.map(([lat, lng]) => [lat, lng])
      : [];
    updateWizardUi();
    window.openAddFieldModal();
  }

  function wireListClicks() {
    fieldsListEl?.querySelectorAll(".field-card[data-field-id]").forEach((node) => {
      node.addEventListener("click", (ev) => {
        if (ev.target.closest(".fc-edit")) return;
        const id = node.getAttribute("data-field-id");
        if (id) window.location.href = `field-detail.html?f=${encodeURIComponent(id)}`;
      });
    });
    fieldsListEl?.querySelectorAll(".fc-edit").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-edit-id");
        if (id) openFieldModalForEdit(id);
      });
    });
  }

  function rerender() {
    const latestByField = new Map();
    for (const s of scans) {
      if (!s.fieldId) continue;
      const prev = latestByField.get(s.fieldId);
      if (!prev || tsToMs(s.createdAt) > tsToMs(prev.createdAt)) latestByField.set(s.fieldId, s);
    }

    const total = fields.length;
    if (el("fields-total")) el("fields-total").textContent = total ? String(total) : "0";
    const area = fields.reduce((sum, f) => sum + (typeof f.areaAcres === "number" ? f.areaAcres : 0), 0);
    if (el("fields-area")) el("fields-area").textContent = total ? area.toFixed(1) : "--";

    let healthy = 0;
    let attn = 0;
    for (const f of fields) {
      const ls = latestByField.get(f.id);
      if (!ls || typeof ls.healthScore !== "number") continue;
      if (ls.healthScore >= 80) healthy += 1;
      else attn += 1;
    }
    if (el("fields-healthy")) el("fields-healthy").textContent = total ? String(healthy) : "--";
    if (el("fields-attn")) el("fields-attn").textContent = total ? String(attn) : "--";

    if (mapEmpty) mapEmpty.style.display = total ? "none" : "flex";
    renderHolograms(hologramsEl, fields, latestByField);

    if (!fieldsListEl) return;
    if (!total) {
      fieldsListEl.innerHTML = `
        <div class="field-card empty-card">
          <div class="fc-main">
            <h4>No fields yet</h4>
            <p class="fc-type">Start monitoring your first farm — add a field to unlock realtime analytics.</p>
            <button type="button" class="btn-neon-sm" id="empty-add-btn">Add first field</button>
          </div>
        </div>
      `;
      el("empty-add-btn")?.addEventListener("click", openFieldModalForCreate);
      return;
    }

    const html = fields
      .slice()
      .sort((a, b) => {
        const as = latestByField.get(a.id);
        const bs = latestByField.get(b.id);
        const av = as && typeof as.healthScore === "number" ? as.healthScore : -1;
        const bv = bs && typeof bs.healthScore === "number" ? bs.healthScore : -1;
        return bv - av;
      })
      .map((f, i) =>
        renderFieldCard({
          index: i,
          field: f,
          latestScan: latestByField.get(f.id),
          soilMoisture: latestWeatherMoisture,
        }),
      )
      .join("");

    fieldsListEl.innerHTML = html;
    wireListClicks();
  }

  unsubs.push(
    onSnapshot(fieldsQ, (snap) => {
      fields = [];
      snap.forEach((d) => fields.push({ id: d.id, ...d.data() }));
      fieldMapById = new Map(fields.map((f) => [f.id, f]));
      rerender();
    }),
  );

  unsubs.push(
    onSnapshot(scansQ, (snap) => {
      scans = [];
      snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
      rerender();
    }),
  );

  function bindUi() {
    if (fieldsUiBound) return;
    fieldsUiBound = true;
    el("add-field-cta")?.addEventListener("click", openFieldModalForCreate);

    el("wiz-next-btn")?.addEventListener("click", async () => {
      if (wizardStep < 4) {
        if (wizardStep === 1) {
          const n = (el("field-name")?.value || "").trim();
          if (!n) { wizSnack("Please enter a field name."); return; }
        }
        wizardStep += 1;
        if (wizardStep === 2) {
          // Open full-screen map (openFmsMap is in scope here inside the callback)
          openFmsMap();
        } else {
          updateWizardUi();
        }
        return;
      }
      await saveField(user);
    });

    el("wiz-back-btn")?.addEventListener("click", () => {
      if (wizardStep > 1) {
        wizardStep -= 1;
        if (wizardStep === 2) {
          openFmsMap();
        } else {
          updateWizardUi();
        }
      }
    });

    ["field-name", "field-crop", "field-soil", "field-irrigation", "field-area", "field-planted", "field-notes"].forEach((id) => {
      el(id)?.addEventListener("input", persistDraft);
    });

    el("area-minus")?.addEventListener("click", () => {
      const v = parseFloat(el("field-area")?.value || "0") || 0;
      el("field-area").value = Math.max(0, v - 0.5).toFixed(2);
      persistDraft();
    });
    el("area-plus")?.addEventListener("click", () => {
      const v = parseFloat(el("field-area")?.value || "0") || 0;
      el("field-area").value = (v + 0.5).toFixed(2);
      persistDraft();
    });

  }

  async function saveField(user) {
    const name = (el("field-name")?.value || "").trim();
    const cropType = (el("field-crop")?.value || "").trim();
    const soilType = el("field-soil")?.value || "";
    const irrigationType = el("field-irrigation")?.value || "";
    const areaRaw = (el("field-area")?.value || "").trim();
    const plantedAt = el("field-planted")?.value || "";
    const notes = (el("field-notes")?.value || "").trim();
    const manualArea = areaRaw ? Number(areaRaw) : null;

    if (!name) {
      wizSnack("Please enter a field name.");
      return;
    }

    const btn = el("wiz-next-btn");
    let prev = "";
    if (btn) {
      btn.disabled = true;
      prev = btn.textContent;
      btn.textContent = "Saving...";
    }

    try {
      const fieldRef = editingFieldId ? doc(db, "fields", editingFieldId) : doc(collection(db, "fields"));
      const batch = writeBatch(db);
      const hasBoundary = drawingPoints.length >= 3;
      const areaFromMap = hasBoundary ? sqMetersToAcres(polygonAreaSqM(drawingPoints)) : null;
      const areaAcres = Number.isFinite(areaFromMap) ? areaFromMap : Number.isFinite(manualArea) ? manualArea : null;
      const existing = editingFieldId ? fieldMapById.get(editingFieldId) : null;

      batch.set(
        fieldRef,
        {
          userId: user.uid,
          name,
          cropType: cropType || null,
          soilType: soilType || null,
          irrigationType: irrigationType || null,
          notes: notes || null,
          areaAcres: Number.isFinite(areaAcres) ? areaAcres : null,
          plantedAt: plantedAt || null,
          boundary: hasBoundary
            ? {
                type: "polygon",
                coordinates: drawingPoints.map(([lat, lng]) => [lat, lng]),
                areaSqM: polygonAreaSqM(drawingPoints),
                pointCount: drawingPoints.length,
                mappedAt: serverTimestamp(),
              }
            : existing?.boundary || null,
          status: "active",
          createdAt: existing?.createdAt || serverTimestamp(),
          updatedAt: serverTimestamp(),
          schemaVersion: 2,
        },
        { merge: true },
      );

      const file = el("field-cover")?.files?.[0];
      if (file && file.size <= 6 * 1024 * 1024) {
        const storageRef = ref(storage, `field_covers/${user.uid}/${fieldRef.id}/banner_${Date.now()}`);
        await uploadBytes(storageRef, file);
        const url = await getDownloadURL(storageRef);
        batch.set(
          fieldRef,
          {
            imageUrl: url,
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        );
      }

      batch.set(doc(collection(db, "activity_history")), {
        userId: user.uid,
        type: editingFieldId ? "field.updated" : "field.created",
        createdAt: serverTimestamp(),
        entity: { kind: "field", id: fieldRef.id },
        meta: { name, fieldId: fieldRef.id, cropType: cropType || null, mapped: hasBoundary },
        schemaVersion: 1,
      });

      batch.set(doc(collection(db, "notifications")), {
        userId: user.uid,
        title: editingFieldId ? "Field updated" : "Field added",
        body: editingFieldId ? `${name} was updated.` : `${name} is ready for monitoring.`,
        type: editingFieldId ? "field_updated" : "field_added",
        readAt: null,
        createdAt: serverTimestamp(),
        entity: { kind: "field", id: fieldRef.id },
        schemaVersion: 1,
      });

      await batch.commit();
      editingFieldId = null;
      wizardStep = 1;
      clearDraft();
      window.closeAddFieldModal();
      clearDrawing();
      if (el("field-name")) el("field-name").value = "";
      if (el("field-crop")) el("field-crop").value = "";
      if (el("field-soil")) el("field-soil").value = "";
      if (el("field-irrigation")) el("field-irrigation").value = "";
      if (el("field-area")) el("field-area").value = "";
      if (el("field-planted")) el("field-planted").value = "";
      if (el("field-notes")) el("field-notes").value = "";
      if (el("field-cover")) el("field-cover").value = "";
      updateWizardUi();
    } catch (e) {
      console.error(e);
      wizSnack(`Failed to save: ${e.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prev || "Next";
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindUi, { once: true });
  } else {
    bindUi();
  }

  const params = new URLSearchParams(window.location.search);
  const editParam = params.get("edit");
  if (editParam) {
    let tries = 0;
    const tryOpen = () => {
      if (fieldMapById.has(editParam)) {
        openFieldModalForEdit(editParam);
        return;
      }
      if (++tries < 30) setTimeout(tryOpen, 200);
    };
    setTimeout(tryOpen, 300);
  }

  return () => {
    fieldsUiBound = false;
    unsubs.forEach((u) => {
      try {
        u();
      } catch (e) {
        console.warn(e);
      }
    });
    map?.remove();
    map = null;
  };
}

onAuthStateChanged(auth, (user) => {
  if (teardown) {
    teardown();
    teardown = null;
  }
  if (!user) {
    window.location.href = "login.html";
    return;
  }
  teardown = mountFieldsPage(user);
});
