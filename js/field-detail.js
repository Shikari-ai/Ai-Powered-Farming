import "./auth-session.js?v=31";
import "./i18n.js";
import { auth, db, storage } from "./auth.js?v=31";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const qs = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function fieldIdFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return p.get("f") || p.get("field") || "";
}

function formatAgo(ms) {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pestRiskFromScan(scan) {
  if (!scan) return null;
  let p = 12;
  const sev = scan.severity?.level;
  if (sev === "critical") p += 40;
  else if (sev === "moderate") p += 22;
  else if (sev === "good") p += 0;
  const obs = Array.isArray(scan.observedSymptoms) ? scan.observedSymptoms.join(" ").toLowerCase() : "";
  const diag = String(scan.diagnosis || "").toLowerCase();
  if (/pest|insect|borer|aphid/.test(obs + diag)) p += 28;
  if (/fungal|rust|blight/.test(obs + diag)) p += 15;
  return Math.min(96, Math.round(p));
}

function diseaseProbFromScan(scan) {
  if (!scan) return null;
  let p = 10;
  const sev = scan.severity?.level;
  if (sev === "critical") p += 35;
  else if (sev === "moderate") p += 20;
  const obs = Array.isArray(scan.observedSymptoms) ? scan.observedSymptoms.join(" ").toLowerCase() : "";
  const diag = String(scan.diagnosis || "").toLowerCase();
  if (/fungal|disease|rot|mildew|rust|blight|wil/.test(obs + diag)) p += 32;
  return Math.min(95, Math.round(p));
}

function renderSparkline(scansAsc) {
  const host = el("fd-sparkline");
  if (!host) return;
  const pts = scansAsc
    .map((s) => (typeof s.healthScore === "number" ? s.healthScore : null))
    .filter((n) => n != null);
  if (pts.length < 2) {
    host.innerHTML = '<div class="empty" style="padding:12px;">Need at least two scans to plot a trend</div>';
    return;
  }
  const w = 300;
  const h = 72;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const pad = 6;
  const dx = (w - pad * 2) / (pts.length - 1);
  const path = pts
    .map((v, i) => {
      const x = pad + i * dx;
      const t = max === min ? 0.5 : (v - min) / (max - min);
      const y = pad + (1 - t) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#39ff14" stop-opacity="0.35"/><stop offset="100%" stop-color="#39ff14" stop-opacity="0"/></linearGradient></defs><path d="${path}" fill="none" stroke="#39ff14" stroke-width="2"/><path d="${path} L ${w - pad},${h} L ${pad},${h} Z" fill="url(#g)" stroke="none"/></svg>`;
}

function buildInsights(field, latest, scansDesc, soilMoisture) {
  const items = [];
  if (latest && typeof latest.healthScore === "number") {
    if (latest.healthScore < 50) {
      items.push({ cls: "bad", icon: "ri-alarm-warning-line", text: "Latest scan health is low. Re-run a scan after any treatment or irrigation change." });
    } else if (latest.healthScore >= 80) {
      items.push({ cls: "", icon: "ri-plant-line", text: "Latest scan indicates strong canopy health. Maintain current scouting rhythm." });
    }
  }
  const pr = pestRiskFromScan(latest);
  if (pr != null && pr >= 55) {
    items.push({ cls: "warn", icon: "ri-bug-line", text: `Elevated pest pressure signal (${pr}%) from symptom patterns — prioritize field edges and stressed rows.` });
  }
  const dp = diseaseProbFromScan(latest);
  if (dp != null && dp >= 50) {
    items.push({ cls: "warn", icon: "ri-virus-line", text: `Disease risk estimate ${dp}% from recent scan — improve airflow and avoid overhead irrigation when humid.` });
  }
  if (typeof soilMoisture === "number") {
    if (soilMoisture < 35) items.push({ cls: "", icon: "ri-drop-line", text: "Regional moisture model is dry — align irrigation with early morning blocks." });
    if (soilMoisture > 78) items.push({ cls: "warn", icon: "ri-water-flash-line", text: "Moisture model is high — check drainage in low spots after rain." });
  }
  if (field?.irrigationType === "Rain-fed" && typeof soilMoisture === "number" && soilMoisture < 40) {
    items.push({ cls: "warn", icon: "ri-cloud-off-line", text: "Rain-fed field with dry moisture estimate — monitor soil crusting and consider contingency irrigation." });
  }
  if (!items.length) {
    items.push({ cls: "", icon: "ri-sparkling-line", text: "Keep scanning after major weather or input changes to sharpen field intelligence." });
  }
  return items;
}

let detach = null;

function attachFieldDetail(user, fieldId) {
  const unsubs = [];
  let fieldSnap = null;
  let scans = [];
  let recs = [];
  let activities = [];
  let latestWeatherMoisture = null;

  const unsubField = onSnapshot(doc(db, "fields", fieldId), (snap) => {
    if (!snap.exists()) {
      window.location.href = "fields.html";
      return;
    }
    const data = snap.data();
    if (data.userId !== user.uid) {
      window.location.href = "fields.html";
      return;
    }
    fieldSnap = { id: snap.id, ...data };
    paintFieldHeader(fieldSnap);
    fillEditForm(fieldSnap);
    rerenderAll();
  });
  unsubs.push(unsubField);

  unsubs.push(
    onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(400)), (snap) => {
      scans = [];
      snap.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        if (x.fieldId === fieldId) scans.push(x);
      });
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "ai_recommendations"), where("userId", "==", user.uid), limit(300)), (snap) => {
      recs = [];
      snap.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        if (x.fieldId === fieldId) recs.push(x);
      });
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "activity_history"), where("userId", "==", user.uid), limit(300)), (snap) => {
      activities = [];
      const seen = new Set();
      snap.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        const e = x.entity;
        const matchField = e && e.kind === "field" && e.id === fieldId;
        const matchMeta = x.meta?.fieldId === fieldId;
        if ((matchField || matchMeta) && !seen.has(d.id)) {
          seen.add(d.id);
          activities.push(x);
        }
      });
      activities.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(40)), (snap) => {
      let best = 0;
      let moisture = null;
      snap.forEach((d) => {
        const x = d.data();
        const t = tsToMs(x.fetchedAt);
        if (t >= best) {
          best = t;
          moisture =
            typeof x.derived?.soilMoistureEstimate === "number"
              ? x.derived.soilMoistureEstimate
              : null;
        }
      });
      latestWeatherMoisture = moisture;
      rerenderAll();
    }),
  );

  function latestScan() {
    let best = null;
    let bestT = 0;
    for (const s of scans) {
      const t = tsToMs(s.createdAt);
      if (t >= bestT) {
        bestT = t;
        best = s;
      }
    }
    return best;
  }

  function paintFieldHeader(f) {
    el("fd-name").textContent = f.name || "Field";
    const crop = f.cropType || "Crop not set";
    const area = typeof f.areaAcres === "number" ? `${f.areaAcres.toFixed(1)} acres` : "Area not set";
    el("fd-sub").textContent = `${crop} · ${area}`;
    const img = el("fd-hero-img");
    const fb = el("fd-hero-fallback");
    if (f.imageUrl && img && fb) {
      img.src = f.imageUrl;
      img.classList.remove("hidden");
      fb.classList.add("hidden");
      img.onload = () => {
        img.classList.remove("hidden");
        fb.classList.add("hidden");
      };
      img.onerror = () => {
        img.classList.add("hidden");
        fb.classList.remove("hidden");
      };
    } else if (img && fb) {
      img.classList.add("hidden");
      fb.classList.remove("hidden");
    }
  }

  function fillEditForm(f) {
    el("fd-in-name").value = f.name || "";
    el("fd-in-crop").value = f.cropType || "";
    el("fd-in-soil").value = f.soilType || "";
    el("fd-in-irr").value = f.irrigationType || "";
    el("fd-in-area").value = typeof f.areaAcres === "number" ? String(f.areaAcres) : "";
    el("fd-in-planted").value = f.plantedAt || "";
    el("fd-in-notes").value = f.notes || "";
  }

  function rerenderAll() {
    const f = fieldSnap;
    if (!f) return;
    const latest = latestScan();
    const health = latest && typeof latest.healthScore === "number" ? `${Math.round(latest.healthScore)}%` : "—";
    el("fd-health").textContent = health;
    el("fd-area").textContent = typeof f.areaAcres === "number" ? `${f.areaAcres.toFixed(1)} ac` : "—";
    const moist =
      latestWeatherMoisture != null ? `${Math.round(latestWeatherMoisture)}%` : "—";
    el("fd-moisture").textContent = moist;
    const pr = pestRiskFromScan(latest);
    el("fd-pest").textContent = pr != null ? `${pr}%` : "—";

    const scansChrono = scans.slice().sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
    renderSparkline(scansChrono);

    const cropEl = el("fd-crop-summary");
    cropEl.innerHTML = `
      <strong style="color:var(--neon)">${f.cropType || "Not set"}</strong><br/>
      Soil: ${f.soilType || "—"} · Irrigation: ${f.irrigationType || "—"}<br/>
      Planted: ${f.plantedAt ? new Date(f.plantedAt).toLocaleDateString() : "—"}
    `;

    const recHost = el("fd-recs-list");
    const fieldRecs = recs
      .slice()
      .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
      .slice(0, 12);
    if (!fieldRecs.length) {
      recHost.innerHTML = '<div class="empty">No recommendations yet. Run a scan linked to this field.</div>';
    } else {
      recHost.innerHTML = fieldRecs
        .map(
          (r) => `
        <div class="insight-row"><i class="ri-lightbulb-flash-line"></i><div>
          <div><span style="color:var(--neon);font-size:10px;">${escapeHtml(r.type || "tip")}</span><br/>${escapeHtml(r.text || "")}</div>
          <div class="t">${formatAgo(tsToMs(r.createdAt))}</div>
        </div></div>`,
        )
        .join("");
    }

    const latestHost = el("fd-latest-scan");
    if (!latest) {
      latestHost.innerHTML = '<div class="empty">No scans for this field yet. Use Scan from the nav.</div>';
    } else {
      latestHost.innerHTML = `
        <div class="scan-card">
          <div class="score">Health ${Math.round(latest.healthScore)}% · ${latest.severity?.label || latest.severity?.level || ""}</div>
          <div style="margin-top:6px;color:var(--dim);font-size:11px;">${escapeHtml(latest.diagnosis || "")}</div>
          <div class="t">${formatAgo(tsToMs(latest.createdAt))}</div>
        </div>
      `;
    }

    const ins = buildInsights(f, latest, scans, latestWeatherMoisture);
    el("fd-insights").innerHTML = ins
      .map(
        (x) =>
          `<div class="insight-row ${x.cls}"><i class="${x.icon}"></i><div>${escapeHtml(x.text)}</div></div>`,
      )
      .join("");

    const actHost = el("fd-activity-list");
    const acts = activities.slice(0, 25);
    if (!acts.length) {
      actHost.innerHTML = '<div class="empty">No activity for this field yet.</div>';
    } else {
      actHost.innerHTML = acts
        .map((a) => {
          const msg =
            a.type === "field.created"
              ? "Field created"
              : a.type === "field.updated"
                ? "Field updated"
                : a.type === "crop_scan.created"
                  ? "Crop scan saved"
                  : a.type || "Activity";
          return `<div class="activity-item"><div>${escapeHtml(msg)}</div><div class="t">${formatAgo(tsToMs(a.createdAt))}</div></div>`;
        })
        .join("");
    }

    const scanHost = el("fd-scans-list");
    const sdesc = scans
      .slice()
      .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
      .slice(0, 15);
    if (!sdesc.length) {
      scanHost.innerHTML = '<div class="empty">No scans yet.</div>';
    } else {
      scanHost.innerHTML = sdesc
        .map(
          (s) => `
        <div class="scan-card">
          <span class="score">${Math.round(s.healthScore)}%</span> · ${escapeHtml(s.cropType || "")}
          <div style="color:var(--dim);font-size:11px;margin-top:4px;">${formatAgo(tsToMs(s.createdAt))}</div>
        </div>`,
        )
        .join("");
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  el("fd-save-meta").onclick = async () => {
    const btn = el("fd-save-meta");
    const name = el("fd-in-name").value.trim();
    if (!name) {
      alert("Name is required.");
      return;
    }
    btn.disabled = true;
    try {
      const area = parseFloat(el("fd-in-area").value);
      await updateDoc(doc(db, "fields", fieldId), {
        name,
        cropType: el("fd-in-crop").value.trim() || null,
        soilType: el("fd-in-soil").value || null,
        irrigationType: el("fd-in-irr").value || null,
        areaAcres: Number.isFinite(area) ? area : null,
        plantedAt: el("fd-in-planted").value || null,
        notes: el("fd-in-notes").value.trim() || null,
        updatedAt: serverTimestamp(),
        schemaVersion: 2,
      });
      const file = el("fd-cover-file").files?.[0];
      if (file) {
        if (file.size > 6 * 1024 * 1024) {
          alert("Image must be under 6MB.");
        } else {
          const storageRef = ref(storage, `field_covers/${user.uid}/${fieldId}/banner_${Date.now()}`);
          await uploadBytes(storageRef, file);
          const url = await getDownloadURL(storageRef);
          await updateDoc(doc(db, "fields", fieldId), { imageUrl: url, updatedAt: serverTimestamp() });
        }
        el("fd-cover-file").value = "";
      }
      const batch = writeBatch(db);
      batch.set(doc(collection(db, "activity_history")), {
        userId: user.uid,
        type: "field.updated",
        createdAt: serverTimestamp(),
        entity: { kind: "field", id: fieldId },
        meta: { fieldId, source: "field_detail" },
        schemaVersion: 1,
      });
      batch.set(doc(collection(db, "notifications")), {
        userId: user.uid,
        title: "Field updated",
        body: `${name} was updated.`,
        type: "field_updated",
        readAt: null,
        createdAt: serverTimestamp(),
        entity: { kind: "field", id: fieldId },
        schemaVersion: 1,
      });
      await batch.commit();
    } catch (e) {
      console.error(e);
      alert(e.message || "Save failed");
    } finally {
      btn.disabled = false;
    }
  };

  el("fd-delete-field").onclick = async () => {
    if (!confirm("Delete this field permanently? Scans remain but lose this link.")) return;
    try {
      await deleteDoc(doc(db, "fields", fieldId));
      window.location.href = "fields.html";
    } catch (e) {
      alert(e.message || "Delete failed");
    }
  };

  el("fd-edit-map-btn").onclick = () => {
    window.location.href = `fields.html?edit=${encodeURIComponent(fieldId)}`;
  };

  return () => unsubs.forEach((u) => u());
}

let tabsWired = false;
function setupTabs() {
  if (tabsWired) return;
  tabsWired = true;
  qs(".tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    const id = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${id}`));
  });
}

onAuthStateChanged(auth, (user) => {
  if (detach) {
    detach();
    detach = null;
  }
  if (!user) {
    window.location.href = "login.html";
    return;
  }
  const fid = fieldIdFromUrl();
  if (!fid) {
    window.location.href = "fields.html";
    return;
  }
  setupTabs();
  detach = attachFieldDetail(user, fid);
});
