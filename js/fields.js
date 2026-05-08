import { auth, db, storage } from "./auth.js";
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
    if (typeof p.step === "number") wizardStep = clamp(p.step, 1, 4);
  } catch {}
}

function clearDraft() {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {}
}

let wizardStep = 1;

function updateWizardUi() {
  for (let i = 1; i <= 4; i++) {
    el(`wiz-step-${i}`)?.classList.toggle("hidden", i !== wizardStep);
  }
  const prog = el("wizard-progress-fill");
  if (prog) prog.style.width = `${(wizardStep / 4) * 100}%`;
  el("wizard-step-label") && (el("wizard-step-label").textContent = `Step ${wizardStep} of 4`);
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

  let editingFieldId = null;
  let map = null;
  let markersLayer = null;
  let boundaryLayer = null;
  let drawingPoints = [];

  function initMapIfNeeded() {
    if (map || !window.L) return;
    const mapNode = el("field-map");
    if (!mapNode) return;
    map = window.L.map(mapNode, { zoomControl: true, attributionControl: false });
    window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 20 }).addTo(map);
    map.setView(FALLBACK_MAP_CENTER, 14);
    getLiveDeviceCenter().then(([lat, lng]) => {
      if (map) map.setView([lat, lng], 14);
    });
    markersLayer = window.L.layerGroup().addTo(map);
    boundaryLayer = window.L.layerGroup().addTo(map);
    map.on("click", (evt) => {
      drawingPoints.push([evt.latlng.lat, evt.latlng.lng]);
      redrawDrawing();
      persistDraft();
    });
  }

  function redrawDrawing() {
    if (!map || !markersLayer || !boundaryLayer) return;
    markersLayer.clearLayers();
    boundaryLayer.clearLayers();
    const help = el("map-help-text");

    for (let i = 0; i < drawingPoints.length; i++) {
      const [lat, lng] = drawingPoints[i];
      window.L.circleMarker([lat, lng], {
        radius: 5,
        color: "#39ff14",
        fillColor: "#39ff14",
        fillOpacity: 0.95,
        weight: 2,
      })
        .bindTooltip(String(i + 1), { permanent: true, direction: "top" })
        .addTo(markersLayer);
    }
    if (drawingPoints.length >= 2) {
      window.L.polyline(drawingPoints, { color: "#39ff14", weight: 2, dashArray: "6 6" }).addTo(boundaryLayer);
    }
    if (drawingPoints.length >= 3) {
      window.L.polygon(drawingPoints, { color: "#39ff14", weight: 2, fillColor: "#39ff14", fillOpacity: 0.18 }).addTo(boundaryLayer);
      const acres = sqMetersToAcres(polygonAreaSqM(drawingPoints));
      if (el("field-area")) el("field-area").value = acres.toFixed(2);
      if (help) help.textContent = `Boundary: ${acres.toFixed(2)} acres. Adjust points or continue.`;
    } else if (help) {
      help.textContent = "Tap the map to drop boundary corners (3+ for a polygon).";
    }
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
    initMapIfNeeded();
    setTimeout(() => map?.invalidateSize(), 120);
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
    initMapIfNeeded();
    setTimeout(() => {
      map?.invalidateSize();
      redrawDrawing();
      if (drawingPoints.length >= 1) {
        map?.fitBounds(window.L.latLngBounds(drawingPoints), { padding: [20, 20], maxZoom: 17 });
      }
    }, 120);
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
    el("map-undo-btn")?.addEventListener("click", () => {
      drawingPoints.pop();
      redrawDrawing();
    });
    el("map-clear-btn")?.addEventListener("click", clearDrawing);
    el("map-center-btn")?.addEventListener("click", () => {
      getLiveDeviceCenter().then(([lat, lng]) => map?.setView([lat, lng], 16));
    });

    el("wiz-next-btn")?.addEventListener("click", async () => {
      if (wizardStep < 4) {
        if (wizardStep === 1) {
          const n = (el("field-name")?.value || "").trim();
          if (!n) {
            alert("Enter a field name.");
            return;
          }
        }
        wizardStep += 1;
        updateWizardUi();
        if (wizardStep === 2) {
          initMapIfNeeded();
          setTimeout(() => map?.invalidateSize(), 100);
        }
        return;
      }
      await saveField(user);
    });

    el("wiz-back-btn")?.addEventListener("click", () => {
      if (wizardStep > 1) {
        wizardStep -= 1;
        updateWizardUi();
        if (wizardStep === 2) {
          initMapIfNeeded();
          setTimeout(() => map?.invalidateSize(), 100);
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
      alert("Please enter a field name.");
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
      alert(`Failed to save field: ${e.message}`);
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
