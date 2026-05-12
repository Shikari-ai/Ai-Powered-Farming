import "./auth-session.js?v=33";
import "./i18n.js?v=12";
import { auth, db, storage } from "./auth.js?v=32";
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
import { decorateNotificationForAmbient } from "./ambient/notification-decorator.js";
import { openCropPicker } from "./crop-picker.js?v=1";
import { normalizeBoundaryCoords } from "./boundary-coords.js?v=1";

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

// 4-tier health buckets (used for status pill, sort grouping, and legend):
//   Healthy   ≥ 80
//   Moderate  60–79
//   At Risk   40–59
//   Critical  < 40
function scoreToStatus(score) {
  if (typeof score !== "number") return { label: "Not monitored", color: "var(--dim)", rank: 4, key: "none" };
  if (score >= 80) return { label: "Healthy", color: "var(--neon)", rank: 0, key: "healthy" };
  if (score >= 60) return { label: "Moderate", color: "var(--warn)", rank: 1, key: "moderate" };
  if (score >= 40) return { label: "At Risk", color: "#F97316", rank: 2, key: "risk" };
  return { label: "Critical", color: "var(--danger)", rank: 3, key: "critical" };
}

// ─── Sort options for the Field Overview list ───
const SORT_OPTIONS = [
  { id: "health-desc", label: "Health: best first" },
  { id: "health-asc",  label: "Health: worst first" },
  { id: "status-critical", label: "Status: Critical → Healthy" },
  { id: "status-healthy",  label: "Status: Healthy → Critical" },
  { id: "name-asc",  label: "Name (A–Z)" },
  { id: "area-desc", label: "Area: largest first" },
  { id: "recent",    label: "Recently added" },
];
const SORT_KEY = "agri.fields.sortMode";
function getSortMode() {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v && SORT_OPTIONS.some((o) => o.id === v)) return v;
  } catch {}
  return "health-desc";
}
function setSortMode(id) {
  try { localStorage.setItem(SORT_KEY, id); } catch {}
}
function sortModeLabel(id) {
  return (SORT_OPTIONS.find((o) => o.id === id) || SORT_OPTIONS[0]).label;
}
function scoreOf(field, latestByField) {
  const s = latestByField.get(field.id);
  return s && typeof s.healthScore === "number" ? s.healthScore : null;
}
function makeFieldComparator(mode, latestByField) {
  const createdMs = (f) => {
    const c = f.createdAt;
    if (!c) return 0;
    if (typeof c.toMillis === "function") return c.toMillis();
    if (typeof c.seconds === "number") return c.seconds * 1000;
    if (typeof c === "number") return c;
    const t = Date.parse(c);
    return Number.isFinite(t) ? t : 0;
  };
  return (a, b) => {
    const sa = scoreOf(a, latestByField);
    const sb = scoreOf(b, latestByField);
    const ra = scoreToStatus(sa).rank;
    const rb = scoreToStatus(sb).rank;
    switch (mode) {
      case "health-asc":  return (sa ?? -1) - (sb ?? -1);
      case "status-critical": return rb - ra || (sa ?? -1) - (sb ?? -1);
      case "status-healthy":  return ra - rb || (sb ?? -1) - (sa ?? -1);
      case "name-asc":
        return (a.name || "").localeCompare(b.name || "", undefined, { sensitivity: "base" });
      case "area-desc":
        return (b.areaAcres || 0) - (a.areaAcres || 0);
      case "recent":
        return createdMs(b) - createdMs(a);
      case "health-desc":
      default:
        return (sb ?? -1) - (sa ?? -1);
    }
  };
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

// Set the crop on the wizard's hidden inputs + visible label/trigger.
// Pass empty strings to clear.
function setCropValue(crop, variety) {
  const cropEl = el("field-crop");
  const varEl = el("field-crop-variety");
  const labelEl = el("field-crop-label");
  const trigger = el("field-crop-trigger");
  if (cropEl) cropEl.value = crop || "";
  if (varEl) varEl.value = variety || "";
  if (labelEl) {
    if (crop) {
      labelEl.textContent = variety ? `${crop} · ${variety}` : crop;
    } else {
      labelEl.textContent = "Tap to search 200+ crops…";
    }
  }
  if (trigger) trigger.classList.toggle("has-value", !!crop);
}

function persistDraft() {
  try {
    const payload = {
      step: wizardStep,
      name: el("field-name")?.value || "",
      crop: el("field-crop")?.value || "",
      cropVariety: el("field-crop-variety")?.value || "",
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
    if (p.crop) setCropValue(p.crop, p.cropVariety || "");
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
  const crop = field.cropType
    ? (field.cropVariety ? `${field.cropType} · ${field.cropVariety}` : field.cropType)
    : "Crop not set";
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
    else if (score >= 60) poly.classList.add("f-moderate");
    else if (score >= 40) poly.classList.add("f-risk");
    else poly.classList.add("f-critical");
    if (i === 0) poly.style.gridRow = "1/3";
    const marker = document.createElement("div");
    marker.className = "f-marker";
    marker.style.color = score === null ? "rgba(148,163,184,0.8)" : st.color;
    marker.innerHTML = `<i class="${score === null ? "ri-question-line" : score >= 80 ? "ri-leaf-fill" : score >= 60 ? "ri-bug-line" : score >= 40 ? "ri-alert-line" : "ri-error-warning-fill"}"></i>`;
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
      // Silent (no toast) first-fix attempt; uses NavIC + GPS via the OS
      startNavicWatch(true);
    }

    updateFmsPointsLabel();
    if (!fmsUiBound) initFmsBindings();
  }

  function closeFmsMap() {
    stopNavicWatch();
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
    stopNavicWatch();
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

  // ── NavIC + GNSS continuous location ──────────────────────────
  // The Web Geolocation API doesn't let JS pick a constellation —
  // the OS does. On modern Indian Android phones (Snapdragon 720G+,
  // MediaTek Helio G37+, etc.) NavIC is automatically combined with
  // GPS / GLONASS / Galileo when `enableHighAccuracy: true` is set,
  // which is what we do here. The UI honestly reflects multi-
  // constellation positioning instead of just saying "GPS".
  let _gpsWatchId = null;
  let _firstFix = true;

  function stopNavicWatch() {
    if (_gpsWatchId != null) {
      navigator.geolocation.clearWatch(_gpsWatchId);
      _gpsWatchId = null;
    }
    el("fms-gps-btn")?.classList.remove("active");
  }

  function startNavicWatch(silent = false) {
    // Toggle: tapping the button again stops the watch.
    if (_gpsWatchId != null) {
      stopNavicWatch();
      const badge = el("fms-gps-badge");
      if (badge) badge.style.display = "none";
      return;
    }
    const badge   = el("fms-gps-badge");
    const accText = el("fms-accuracy-text");
    const coords  = el("fms-gps-coords");
    const btn     = el("fms-gps-btn");

    if (!silent && badge)   { badge.style.display = "block"; }
    if (!silent && accText) { accText.textContent = "Locating…"; }
    if (coords) coords.textContent = "";
    if (btn) btn.classList.add("active");
    _firstFix = true;

    _gpsWatchId = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude: lat, longitude: lng, accuracy: acc, altitude, heading, speed } = pos.coords;
        if (!map) return;

        if (_firstFix) {
          const zoom = acc < 20 ? 19 : acc < 100 ? 17 : acc < 500 ? 15 : 13;
          map.flyTo({ center: [lng, lat], zoom, essential: true, speed: 1.4 });
          _firstFix = false;
          if (!silent) fmsToast(`NavIC + GPS locked · ±${Math.round(acc)} m`);
        }

        // GPS dot marker (created once, then moved)
        if (!_gpsMLMarker) {
          const dotEl = document.createElement("div");
          dotEl.style.cssText = [
            "width:20px", "height:20px", "border-radius:50%",
            "background:#39ff14", "border:3px solid #fff",
            "box-shadow:0 2px 14px rgba(57,255,20,0.6)",
            "animation:gpsPulse 1.8s ease-in-out infinite",
          ].join(";");
          _gpsMLMarker = new maplibregl.Marker({ element: dotEl })
            .setLngLat([lng, lat])
            .addTo(map);
        } else {
          _gpsMLMarker.setLngLat([lng, lat]);
        }

        // Accuracy circle via GeoJSON source
        const accSrc = map.getSource("fms-gps-acc");
        if (accSrc) {
          accSrc.setData({ type: "FeatureCollection", features: [circleFeature(lat, lng, acc)] });
        }

        if (badge)   badge.style.display = "block";
        if (accText) accText.textContent = `±${Math.round(acc)} m`;
        if (coords) {
          const parts = [
            `${lat.toFixed(5)}°, ${lng.toFixed(5)}°`,
          ];
          if (Number.isFinite(altitude)) parts.push(`alt ${Math.round(altitude)} m`);
          if (Number.isFinite(speed) && speed > 0.3) parts.push(`${(speed * 3.6).toFixed(1)} km/h`);
          if (Number.isFinite(heading)) parts.push(`hdg ${Math.round(heading)}°`);
          coords.textContent = parts.join(" · ");
        }
      },
      (err) => {
        stopNavicWatch();
        if (!silent) {
          if (badge) badge.style.display = "none";
          fmsToast("Positioning unavailable — " + err.message);
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
    el("fms-gps-btn")?.addEventListener("click", () => startNavicWatch(false));
    el("fms-3d-btn")?.addEventListener("click", () => setView3D(true));
    el("fms-2d-btn")?.addEventListener("click", () => setView3D(false));
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

    // ── Category icon resolution ───────────────────────────────
    // Maps OSM key/value tags from Photon & Nominatim into a small
    // set of visual categories so the dropdown reads like a real
    // places picker (shops, food, schools, transit, etc.).
    function categorize(kind, type) {
      const k = (kind || "").toLowerCase();
      const t = (type || "").toLowerCase();
      const m = (re) => re.test(k) || re.test(t);
      if (m(/shop|store|mall|market|kirana|bazaar|supermarket/)) return { cls: "cat-shop", icon: "ri-store-2-line", label: "Shop" };
      if (m(/restaurant|cafe|food|bar|pub|fast_food|biryani|bakery|sweet/)) return { cls: "cat-food", icon: "ri-restaurant-2-line", label: "Food" };
      if (m(/school|college|university|education|kindergarten|coaching/)) return { cls: "cat-school", icon: "ri-book-open-line", label: "Education" };
      if (m(/hospital|clinic|pharmacy|health|dispensary|doctor/)) return { cls: "cat-health", icon: "ri-hospital-line", label: "Health" };
      if (m(/station|airport|bus|train|transport|metro|terminal|fuel|petrol/)) return { cls: "cat-transit", icon: "ri-bus-line", label: "Transit" };
      if (m(/temple|mosque|church|gurdwara|shrine|monastery|religious/)) return { cls: "cat-religion", icon: "ri-temple-line", label: "Religious" };
      if (m(/park|forest|river|lake|reservoir|natural|peak|hill|wood/)) return { cls: "cat-nature", icon: "ri-leaf-line", label: "Nature" };
      if (m(/farm|farmland|orchard|vineyard|nursery|plantation|paddy/)) return { cls: "cat-farm", icon: "ri-plant-line", label: "Farm" };
      if (m(/city|town|village|hamlet|locality|suburb|district|state|country/)) return { cls: "cat-place", icon: "ri-map-pin-2-line", label: "Place" };
      return { cls: "", icon: "ri-map-pin-line", label: "" };
    }

    // ── Photon: keyword autocomplete (OSM-backed) ──────────────
    async function fetchPhoton(q, c) {
      try {
        let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=15&lang=en`;
        if (c) url += `&lat=${c.lat.toFixed(4)}&lon=${c.lng.toFixed(4)}`;
        const res = await fetch(url);
        const data = await res.json();
        return (data.features || []).map((f) => {
          const p = f.properties || {};
          const [lng, lat] = f.geometry.coordinates;
          const name = p.name || p.city || p.country || "Unknown";
          const sub = [p.street, p.city, p.state, p.country].filter(Boolean).join(", ");
          return { lat, lng, name, sub, kind: p.osm_key, type: p.osm_value };
        });
      } catch { return []; }
    }

    // ── Nominatim: detail-rich free-text search ────────────────
    async function fetchNominatim(q, c) {
      try {
        const params = new URLSearchParams({
          q, format: "jsonv2", limit: "15", addressdetails: "1",
          "accept-language": "en",
        });
        if (c) {
          // Soft bias: small viewbox around current map center
          const d = 0.6;
          params.set("viewbox", `${c.lng - d},${c.lat + d},${c.lng + d},${c.lat - d}`);
          params.set("bounded", "0");
        }
        const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
          headers: { "Accept-Language": "en" },
        });
        const arr = await res.json();
        return (arr || []).map((r) => {
          const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
          const a = r.address || {};
          const sub = [a.suburb || a.neighbourhood, a.city || a.town || a.village, a.state, a.country].filter(Boolean).join(", ");
          return { lat, lng, name: r.name || r.display_name?.split(",")[0] || "Unknown", sub, kind: r.class || r.category, type: r.type };
        });
      } catch { return []; }
    }

    // Merge + de-duplicate by ~30m radius + name similarity
    function mergeResults(a, b) {
      const keep = [];
      const close = (p, q) => {
        const d = Math.hypot((p.lat - q.lat) * 111000, (p.lng - q.lng) * 111000 * Math.cos((p.lat * Math.PI) / 180));
        return d < 30 && (p.name || "").toLowerCase().split(" ").some((w) => (q.name || "").toLowerCase().includes(w));
      };
      [...a, ...b].forEach((r) => {
        if (!keep.some((k) => close(k, r))) keep.push(r);
      });
      return keep.slice(0, 18);
    }

    async function fetchPlaces(q) {
      const c = map?.getCenter();
      // Run both in parallel — Photon is fast autocomplete; Nominatim
      // adds Indian POIs (shops, schools, temples, etc.) Photon can miss.
      const [a, b] = await Promise.all([fetchPhoton(q, c), fetchNominatim(q, c)]);
      const results = mergeResults(a, b);
      if (!dd) return;
      if (!results.length) { hideFmsDropdown(); fmsToast("No spots match — try a different query"); return; }

      const hdr = `<div class="fms-search-hdr">
        <i class="ri-radar-line"></i>
        <span>${results.length} spot${results.length > 1 ? "s" : ""} · NavIC + OpenStreetMap</span>
      </div>`;
      dd.innerHTML = hdr + results.map((r, i) => {
        const cat = categorize(r.kind, r.type);
        return `<div class="sr-item" data-i="${i}">
          <div class="sr-ico ${cat.cls}"><i class="${cat.icon}"></i></div>
          <div class="sr-meta">
            <div class="sr-name">${escapeHtmlSr(r.name)}</div>
            ${r.sub ? `<div class="sr-addr">${escapeHtmlSr(r.sub)}</div>` : ""}
            ${cat.label ? `<span class="sr-type-pill">${cat.label}</span>` : ""}
          </div>
        </div>`;
      }).join("");
      dd.style.display = "block";

      dd.querySelectorAll(".sr-item").forEach((item) => {
        const i = parseInt(item.dataset.i, 10);
        const r = results[i];
        item.addEventListener("mousedown", (e) => e.preventDefault());
        item.addEventListener("click", () => flyToResult(r.lng, r.lat, r.name));
      });
    }
    function escapeHtmlSr(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    }
    const fetchPhotonShim = fetchPlaces; // keep old call sites working

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
      searchDebounce = setTimeout(() => fetchPlaces(q), 320);
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
          items[srFocusIdx].click();
        } else {
          const q = inp?.value.trim();
          if (q) fetchPlaces(q);
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
      // Re-attach terrain DEM if 3D mode was active before the style swap
      if (is3D) {
        ensureTerrainSource();
        try { map.setTerrain({ source: "terrain-dem", exaggeration: 1.35 }); } catch (_) {}
      }
    });
  }

  // ── 3D terrain support ─────────────────────────────────────────
  // AWS Terrain Tiles (free, public, Terrarium-encoded DEM). When 3D
  // is enabled we attach this as a raster-dem source and call
  // map.setTerrain(), giving true elevation-based 3D — not just a tilt.
  const TERRAIN_TILES = [
    "https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png",
  ];
  function ensureTerrainSource() {
    if (!map) return;
    if (!map.getSource("terrain-dem")) {
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: TERRAIN_TILES,
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 14,
        attribution: "© Mapzen / Amazon Public Datasets",
      });
    }
    // Sky layer for atmospheric 3D feel
    if (!map.getLayer("fms-sky")) {
      try {
        map.addLayer({
          id: "fms-sky",
          type: "sky",
          paint: {
            "sky-type": "atmosphere",
            "sky-atmosphere-sun": [0.0, 90.0],
            "sky-atmosphere-sun-intensity": 8,
          },
        });
      } catch (_) { /* some maplibre versions lack sky layer; ignore */ }
    }
  }
  function setView3D(on) {
    is3D = !!on;
    el("fms-3d-btn")?.classList.toggle("active", is3D);
    el("fms-2d-btn")?.classList.toggle("active", !is3D);
    el("fms-3d-btn")?.setAttribute("aria-selected", String(is3D));
    el("fms-2d-btn")?.setAttribute("aria-selected", String(!is3D));
    if (!map) return;
    if (is3D) {
      ensureTerrainSource();
      try { map.setTerrain({ source: "terrain-dem", exaggeration: 1.35 }); } catch (_) {}
      map.easeTo({ pitch: 60, bearing: -20, duration: 700 });
    } else {
      try { map.setTerrain(null); } catch (_) {}
      map.easeTo({ pitch: 0, bearing: 0, duration: 600 });
    }
  }
  function toggle3D() { setView3D(!is3D); }

  /* Add MapLibre GeoJSON sources + layers for boundary drawing.
     Called once after style loads (and again after every setStyle). */
  function _addDrawingLayers() {
    if (!map || map.getSource("fms-drawing")) return;

    map.addSource("fms-drawing", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    // Polygon fill — neon-tinted, more visible on satellite
    map.addLayer({ id: "fms-poly-fill", type: "fill", source: "fms-drawing",
      filter: ["all", ["==", "$type", "Polygon"], ["!=", ["get", "kind"], "closing"]],
      paint: { "fill-color": "#39ff14", "fill-opacity": 0.18 },
    });

    // Outer line "glow" halo — drawn under the main stroke so it pops on imagery
    map.addLayer({ id: "fms-line-glow", type: "line", source: "fms-drawing",
      filter: ["all", ["in", "$type", "LineString", "Polygon"], ["!=", ["get", "kind"], "closing"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#39ff14",
        "line-width": 9,
        "line-opacity": 0.22,
        "line-blur": 4,
      },
    });

    // Main connecting line (solid, bright)
    map.addLayer({ id: "fms-line", type: "line", source: "fms-drawing",
      filter: ["all", ["in", "$type", "LineString", "Polygon"], ["!=", ["get", "kind"], "closing"]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": "#39ff14",
        "line-width": 3.5,
        "line-opacity": 0.95,
      },
    });

    // Closing-ring preview (dashed) — drawn from last point back to first
    // before the polygon is finalized at 3+ corners. Visualizes the close.
    map.addLayer({ id: "fms-line-closing", type: "line", source: "fms-drawing",
      filter: ["==", ["get", "kind"], "closing"],
      layout: { "line-cap": "round" },
      paint: {
        "line-color": "#39ff14",
        "line-width": 2.5,
        "line-opacity": 0.6,
        "line-dasharray": [1.6, 1.6],
      },
    });

    // Corner halo (soft outer ring)
    map.addLayer({ id: "fms-dots-halo", type: "circle", source: "fms-drawing",
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-radius": 18,
        "circle-color": "#39ff14",
        "circle-opacity": 0.18,
        "circle-blur": 0.4,
      },
    });

    // First corner gets a slightly larger, brighter ring to mark the start
    map.addLayer({ id: "fms-dots-first-ring", type: "circle", source: "fms-drawing",
      filter: ["all", ["==", "$type", "Point"], ["==", ["get", "first"], true]],
      paint: {
        "circle-radius": 14,
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": "#39ff14",
        "circle-stroke-width": 2,
        "circle-stroke-opacity": 0.7,
      },
    });

    // Corner circles — bigger, neon-green, white inner border
    map.addLayer({ id: "fms-dots", type: "circle", source: "fms-drawing",
      filter: ["==", "$type", "Point"],
      paint: {
        "circle-radius": 10,
        "circle-color": "#39ff14",
        "circle-stroke-color": "#0a1410",
        "circle-stroke-width": 2.5,
      },
    });

    // Corner number labels
    map.addLayer({ id: "fms-labels", type: "symbol", source: "fms-drawing",
      filter: ["==", "$type", "Point"],
      layout: {
        "text-field": ["get", "label"],
        "text-size": 12,
        "text-anchor": "center",
        "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": "#0a1410",
        "text-halo-color": "#39ff14",
        "text-halo-width": 1.2,
      },
    });

    // GPS accuracy circle layer
    map.addSource("fms-gps-acc", { type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    map.addLayer({ id: "fms-gps-fill", type: "fill", source: "fms-gps-acc",
      paint: { "fill-color": "#39ff14", "fill-opacity": 0.07 },
    });
    map.addLayer({ id: "fms-gps-ring", type: "line", source: "fms-gps-acc",
      paint: { "line-color": "#39ff14", "line-width": 1.2, "line-opacity": 0.45 },
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

    // Tap an existing corner to remove it; tap empty area to add one.
    map.on("click", (e) => {
      let hit = null;
      try {
        hit = map.queryRenderedFeatures(e.point, { layers: ["fms-dots"] });
      } catch { hit = null; }
      if (hit && hit.length) {
        const lbl = hit[0].properties?.label;
        const i = parseInt(lbl, 10) - 1;
        if (Number.isInteger(i) && i >= 0 && i < drawingPoints.length) {
          drawingPoints.splice(i, 1);
          redrawDrawing();
          updateFmsPointsLabel();
          persistDraft();
          fmsToast(`Removed corner ${lbl}`, 1500);
          return;
        }
      }
      drawingPoints.push([e.lngLat.lat, e.lngLat.lng]);
      redrawDrawing();
      updateFmsPointsLabel();
      persistDraft();
    });
    // Show a "deletable" cursor when hovering over a corner
    map.on("mouseenter", "fms-dots", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "fms-dots", () => { map.getCanvas().style.cursor = ""; });
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

    // Corner points — first one gets a special marker (start of polygon)
    drawingPoints.forEach(([lat, lng], i) => {
      features.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [lng, lat] },
        properties: { label: String(i + 1), first: i === 0 },
      });
    });

    // Connecting line (sequential corners as user taps)
    if (drawingPoints.length >= 2) {
      features.push({
        type: "Feature",
        geometry: { type: "LineString",
          coordinates: drawingPoints.map(([lat, lng]) => [lng, lat]) },
        properties: { kind: "edge" },
      });
    }

    // Dashed closing-ring preview from the last point back to the first.
    // Shows up from 2 points onward so users can see how the polygon will close.
    if (drawingPoints.length >= 2) {
      const first = drawingPoints[0];
      const last = drawingPoints[drawingPoints.length - 1];
      features.push({
        type: "Feature",
        geometry: { type: "LineString", coordinates: [[last[1], last[0]], [first[1], first[0]]] },
        properties: { kind: "closing" },
      });
    }

    // Closed polygon fill
    if (drawingPoints.length >= 3) {
      const ring = [...drawingPoints.map(([lat, lng]) => [lng, lat])];
      ring.push(ring[0]); // close ring
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [ring] },
        properties: { kind: "fill" },
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
    setCropValue("", "");
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
    setCropValue(field.cropType || "", field.cropVariety || "");
    if (el("field-soil")) el("field-soil").value = field.soilType || "";
    if (el("field-irrigation")) el("field-irrigation").value = field.irrigationType || "";
    if (el("field-area")) el("field-area").value = typeof field.areaAcres === "number" ? field.areaAcres.toFixed(2) : "";
    if (el("field-planted")) el("field-planted").value = field.plantedAt || "";
    if (el("field-notes")) el("field-notes").value = field.notes || "";
    drawingPoints = normalizeBoundaryCoords(field?.boundary?.coordinates);
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
      .sort(makeFieldComparator(getSortMode(), latestByField))
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

  function bindSortDropdown() {
    const dd = document.querySelector(".sort-dropdown");
    if (!dd) return;
    // Make it look/act like a real control
    dd.setAttribute("role", "button");
    dd.setAttribute("tabindex", "0");
    dd.setAttribute("aria-haspopup", "listbox");
    dd.setAttribute("aria-expanded", "false");
    dd.style.cursor = "pointer";
    dd.style.userSelect = "none";

    const labelEl = dd.querySelector("span");
    const reflectLabel = () => { if (labelEl) labelEl.textContent = sortModeLabel(getSortMode()); };
    reflectLabel();

    let menu = null;
    const closeMenu = () => {
      if (!menu) return;
      menu.remove();
      menu = null;
      dd.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDocClick, true);
    };
    const onDocClick = (e) => {
      if (menu && !menu.contains(e.target) && !dd.contains(e.target)) closeMenu();
    };
    const openMenu = () => {
      if (menu) { closeMenu(); return; }
      menu = document.createElement("div");
      menu.className = "fields-sort-menu";
      menu.setAttribute("role", "listbox");
      const current = getSortMode();
      menu.innerHTML = SORT_OPTIONS.map((o) =>
        `<button type="button" role="option" data-sort="${o.id}" aria-selected="${o.id === current}">
           <span>${o.label}</span>
           ${o.id === current ? '<i class="ri-check-line"></i>' : ""}
         </button>`
      ).join("");
      // Position the menu under the dropdown trigger
      const rect = dd.getBoundingClientRect();
      Object.assign(menu.style, {
        position: "fixed",
        top: `${Math.round(rect.bottom + 6)}px`,
        right: `${Math.round(window.innerWidth - rect.right)}px`,
        zIndex: "9999",
      });
      document.body.appendChild(menu);
      dd.setAttribute("aria-expanded", "true");
      menu.querySelectorAll("button[data-sort]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const id = btn.getAttribute("data-sort");
          setSortMode(id);
          reflectLabel();
          closeMenu();
          rerender();
        });
      });
      // Defer doc-click bind so the opening click doesn't immediately close it
      setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
    };
    dd.addEventListener("click", openMenu);
    dd.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openMenu(); }
      if (e.key === "Escape") closeMenu();
    });
  }

  function bindUi() {
    if (fieldsUiBound) return;
    fieldsUiBound = true;
    el("add-field-cta")?.addEventListener("click", openFieldModalForCreate);

    // Wire the "Sort by:" dropdown in the Field Overview header
    bindSortDropdown();

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

    ["field-name", "field-soil", "field-irrigation", "field-area", "field-planted", "field-notes"].forEach((id) => {
      el(id)?.addEventListener("input", persistDraft);
    });

    // Crop picker trigger — opens full-screen searchable picker
    el("field-crop-trigger")?.addEventListener("click", () => {
      openCropPicker({
        initialCrop: el("field-crop")?.value || "",
        initialVariety: el("field-crop-variety")?.value || "",
        onSelect: ({ crop, variety }) => {
          setCropValue(crop, variety);
          persistDraft();
        },
      });
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
    const cropVariety = (el("field-crop-variety")?.value || "").trim();
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
          cropVariety: cropVariety || null,
          soilType: soilType || null,
          irrigationType: irrigationType || null,
          notes: notes || null,
          areaAcres: Number.isFinite(areaAcres) ? areaAcres : null,
          plantedAt: plantedAt || null,
          boundary: hasBoundary
            ? {
                type: "polygon",
                // Firestore forbids nested arrays inside documents, so we
                // store corners as an array of {lat, lng} objects instead
                // of [[lat, lng], …]. Readers normalize both shapes.
                coordinates: drawingPoints.map(([lat, lng]) => ({ lat, lng })),
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

      const notifDraft = {
        userId: user.uid,
        title: editingFieldId ? "Field updated" : "Field added",
        body: editingFieldId ? `${name} was updated.` : `${name} is ready for monitoring.`,
        type: editingFieldId ? "field_updated" : "field_added",
        readAt: null,
        createdAt: serverTimestamp(),
        entity: { kind: "field", id: fieldRef.id },
        schemaVersion: 1,
      };
      const decorated = decorateNotificationForAmbient(notifDraft, {
        fieldId: fieldRef.id,
      });
      if (decorated) {
        batch.set(doc(collection(db, "notifications")), decorated);
      }

      await batch.commit();
      editingFieldId = null;
      wizardStep = 1;
      clearDraft();
      window.closeAddFieldModal();
      clearDrawing();
      if (el("field-name")) el("field-name").value = "";
      setCropValue("", "");
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
