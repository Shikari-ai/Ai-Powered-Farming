import { isProfilePanelE2ELocal } from "./auth-session.js?v=33";
import { auth, db, storage, logoutUser } from "./auth.js?v=32";
import { LANGUAGES, setLanguage, getLang } from "./i18n.js?v=12";
import { getDiagnosticsLines } from "./ai/system-health.js";
import { onAuthStateChanged, updateProfile, sendPasswordResetEmail }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  collection, doc, limit, onSnapshot, query,
  serverTimestamp, setDoc, where, getDocs,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { queueLearningFlush } from "./learning/scheduler.js";
import { isLearningSandboxPreview } from "./learning/calibration-apply.js";
import { getAmbientAttentionPrefs, mergeAmbientAttentionPrefs } from "./ambient/attention-memory.js";
import { ref, uploadBytesResumable, getDownloadURL }
  from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

/* ─── helpers ─────────────────────────── */
const el  = (id) => document.getElementById(id);
const qs  = (sel) => document.querySelector(sel);
const setText = (id, v) => { const e = el(id); if (e) e.textContent = v ?? "--"; };
const setHide = (id, h) => el(id)?.classList.toggle("hidden", h);
const tsMs = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate   === "function") return ts.toDate().getTime();
  return 0;
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
function escHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function setAv(id, url) {
  const e = el(id);
  if (e) e.style.backgroundImage = `url('${url.replace(/'/g, "\\'")}')`;
}
function snack(msg, isError) {
  if (typeof window.showSnack === "function") window.showSnack(msg, isError);
  else console.log(msg);
}
function swal(opts) {
  return window.Swal
    ? window.Swal.fire({
        confirmButtonColor:"#10b981",
        background:"#0E1822", color:"#F8FAFC",
        ...opts })
    : Promise.resolve({ isConfirmed: window.confirm(opts.title) });
}

/* openPanel / closePanel are defined inline in profile.html for onclick reliability */

/* ─── score helpers ───────────────────── */
function computeScore({ fields, scans, msgs }) {
  const raw = Math.min(100, fields * 8 + scans * 3 + msgs * 0.5);
  return Math.round(raw * 10) / 10;
}
function scoreLbl(s) {
  if (s >= 85) return "Excellent";
  if (s >= 70) return "Good";
  if (s >= 50) return "Average";
  return "Getting started";
}
function renderStars(score) {
  const filled = Math.round((score / 100) * 5);
  const wrap = el("score-stars");
  if (!wrap) return;
  wrap.innerHTML = Array.from({ length: 5 }, (_, i) =>
    `<i class="${i < filled ? "ri-star-fill" : "ri-star-line"}" style="color:var(--yellow);${i >= filled ? "opacity:.35;" : ""}"></i>`
  ).join("");
}
function renderScore(score) {
  setText("score-num", score > 0 ? score.toFixed(1) : "--");
  setText("score-lbl", score > 0 ? scoreLbl(score) : "No data");
  renderStars(score);
}

/* ─── farm-card builder ───────────────── */
function healthClass(pct) {
  if (pct >= 70) return { cls: "hp-good", lbl: "Healthy" };
  if (pct >= 40) return { cls: "hp-mod",  lbl: "Moderate" };
  return { cls: "hp-risk", lbl: "At Risk" };
}
function buildFarmCard(field, scanPct) {
  const pct  = Math.round(scanPct ?? 0);
  const { cls, lbl } = healthClass(pct);
  const r = 18, circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  const thumb = field.coverImageUrl
    ? `background-image:url('${field.coverImageUrl}');`
    : `background:linear-gradient(135deg,rgba(16,185,129,.15),rgba(10,17,24,.9));`;
  return `
    <div class="farm-card" onclick="openPanel('panel-my-farms-detail'); renderFarmDetail(${JSON.stringify({ ...field, scanPct: pct }).replace(/"/g,"&quot;")})">
      <div class="farm-thumb" style="${thumb}"></div>
      <div class="farm-body">
        <div class="farm-name">${field.name || "Unnamed"}</div>
        <div class="farm-area">${field.areaAcres ? field.areaAcres.toFixed(1) + " acres" : "Area not set"}</div>
        <div class="farm-area" style="margin-top:3px;color:var(--dim);">${field.location || ""}</div>
        <span class="health-pill ${cls}" style="margin-top:6px;">${lbl}</span>
      </div>
      <div class="farm-ring-wrap">
        <svg class="ring-svg" viewBox="0 0 44 44">
          <circle cx="22" cy="22" r="${r}" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="3"/>
          <circle cx="22" cy="22" r="${r}" fill="none"
            stroke="${pct>=70?"#10B981":pct>=40?"#F59E0B":"#EF4444"}"
            stroke-width="3" stroke-linecap="round"
            stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}"
            transform="rotate(-90 22 22)"/>
          <text x="22" y="26" text-anchor="middle"
            font-size="9" fill="${pct>=70?"#10B981":pct>=40?"#F59E0B":"#EF4444"}"
            font-family="Outfit,sans-serif">${pct}%</text>
        </svg>
      </div>
    </div>`;
}

/* ─── activity renderer ───────────────── */
function renderActivity(scans) {
  const wrap = el("ov-activity");
  if (!wrap) return;
  if (!scans.length) {
    wrap.innerHTML = `<div class="act-item"><div class="act-dot" style="background:var(--dim);"></div>
      <div class="act-body"><div class="act-title" style="color:var(--dim);">No activity yet</div>
      <div class="act-time">Add fields and run scans to see activity</div></div></div>`;
    return;
  }
  const items = scans.slice(0, 8);
  wrap.innerHTML = items.map(s => {
    const lvl = s.severity?.level || "info";
    const col = lvl === "good" ? "var(--primary)" : lvl === "warning" ? "var(--yellow)" : "var(--red)";
    const ago = timeAgo(tsMs(s.createdAt));
    return `<div class="act-item">
      <div class="act-dot" style="background:${col};"></div>
      <div class="act-body">
        <div class="act-title">${s.cropName || "Crop scan"} – ${s.severity?.label || "Completed"}</div>
        <div class="act-time">${s.fieldName || ""} · ${ago}</div>
      </div></div>`;
  }).join("");
}
function timeAgo(ms) {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60e3) return "just now";
  if (d < 3600e3) return Math.round(d / 60e3) + "m ago";
  if (d < 86400e3) return Math.round(d / 3600e3) + "h ago";
  return Math.round(d / 86400e3) + "d ago";
}

/* ─── logout ─── expose directly so inline sheet button can call it ── */
window._profileLogout = () => logoutUser();

/* ─── static UI wiring ────────────────── */
function wireStatic() {
  /* main settings → account settings */
  el("main-settings-btn")?.addEventListener("click", () => openPanel("panel-account-settings"));

  /* logout buttons are wired to showLogoutSheet() in the inline script */

  /* change password */
  el("change-pw-btn")?.addEventListener("click", async () => {
    const user = auth.currentUser;
    if (!user?.email) { snack("No email on this account.", true); return; }
    try {
      await sendPasswordResetEmail(auth, user.email);
      snack("Reset link sent to " + user.email);
    } catch(e) { snack("Error: " + e.message, true); }
  });

  /* AI prefs save */
  const saveAiPrefs = () => {
    const prefs = {
      freq: el("ai-freq")?.value,
      crop: el("ai-crop")?.checked,
      pest: el("ai-pest")?.checked,
      weather: el("ai-weather")?.checked,
      irrigation: el("ai-irr")?.checked,
      fertilization: el("ai-fert")?.checked,
      learn: el("ai-learn")?.checked,
    };
    localStorage.setItem("ai_prefs", JSON.stringify(prefs));
    snack("AI settings saved!");
  };
  el("ai-prefs-save-btn")?.addEventListener("click", saveAiPrefs);
  el("ai-prefs-save-main")?.addEventListener("click", saveAiPrefs);

  /* restore AI prefs */
  try {
    const p = JSON.parse(localStorage.getItem("ai_prefs") || "{}");
    if (el("ai-freq") && p.freq) el("ai-freq").value = p.freq;
    if (el("ai-crop") && p.crop !== undefined) el("ai-crop").checked = p.crop;
    if (el("ai-pest") && p.pest !== undefined) el("ai-pest").checked = p.pest;
    if (el("ai-weather") && p.weather !== undefined) el("ai-weather").checked = p.weather;
    if (el("ai-irr") && p.irrigation !== undefined) el("ai-irr").checked = p.irrigation;
    if (el("ai-fert") && p.fertilization !== undefined) el("ai-fert").checked = p.fertilization;
    if (el("ai-learn") && p.learn !== undefined) el("ai-learn").checked = p.learn;
  } catch (_) {}

  /* notification save */
  const saveNotifPrefs = () => {
    const prefs = {
      alerts: el("n-alerts")?.checked,
      recs: el("n-recs")?.checked,
      irr: el("n-irr")?.checked,
      sys: el("n-sys")?.checked,
      tips: el("n-tips")?.checked,
      quiet: el("n-quiet")?.checked,
      quietStart: el("n-quiet-start")?.value,
      quietEnd: el("n-quiet-end")?.value,
    };
    localStorage.setItem("notif_prefs", JSON.stringify(prefs));
    mergeAmbientAttentionPrefs({
      focusMode: el("amb-focus")?.value,
      interruptionSensitivity: el("amb-intr")?.value,
      badgeCountsPassive: !!el("amb-badge-passive")?.checked,
      morningBriefOnHome: el("amb-morning-brief")?.checked !== false,
    });
    snack("Notification settings saved!");
  };
  el("notif-save-btn")?.addEventListener("click", saveNotifPrefs);
  el("notif-save-main")?.addEventListener("click", saveNotifPrefs);

  /* restore notification prefs */
  try {
    const p = JSON.parse(localStorage.getItem("notif_prefs") || "{}");
    const fields = ["n-alerts","n-recs","n-irr","n-sys","n-tips","n-quiet"];
    const keys   = ["alerts","recs","irr","sys","tips","quiet"];
    fields.forEach((fid, i) => {
      if (el(fid) && p[keys[i]] !== undefined) el(fid).checked = p[keys[i]];
    });
    if (el("n-quiet-start") && p.quietStart) el("n-quiet-start").value = p.quietStart;
    if (el("n-quiet-end")   && p.quietEnd)   el("n-quiet-end").value   = p.quietEnd;
  } catch (_) {}

  try {
    const ap = getAmbientAttentionPrefs();
    if (el("amb-focus") && ap.focusMode) el("amb-focus").value = ap.focusMode;
    if (el("amb-intr") && ap.interruptionSensitivity) el("amb-intr").value = ap.interruptionSensitivity;
    if (el("amb-badge-passive") && ap.badgeCountsPassive !== undefined) {
      el("amb-badge-passive").checked = !!ap.badgeCountsPassive;
    }
    if (el("amb-morning-brief") && ap.morningBriefOnHome !== undefined) {
      el("amb-morning-brief").checked = !!ap.morningBriefOnHome;
    }
  } catch (_) {}

  /* help cards */
  el("help-center-btn")?.addEventListener("click", () =>
    snack("Help Center — documentation and video guides coming soon.")
  );
  el("report-issue-btn")?.addEventListener("click", () =>
    snack("Email us at support@smartfarm.app")
  );
  el("feedback-btn")?.addEventListener("click", () =>
    swal({ title: "Rate your experience", html: "How is Smart Farming working for you?", input: "textarea", inputPlaceholder: "Your feedback...", confirmButtonText: "Send" })
      .then(r => { if (r.isConfirmed && r.value) snack("Thank you! Your feedback was received."); })
  );

  /* account settings — language modal: pick then Save */
  const langSearch = el("as-lang-search");
  const langList = el("as-lang-list");
  let pendingLangCode = getLang();

  function langMatchesFilter(L, rawQ) {
    const q = (rawQ || "").trim().toLowerCase();
    if (!q) return true;
    const blob = `${L.name} ${L.native} ${L.code} ${L.region || ""}`.toLowerCase();
    return blob.includes(q);
  }

  function syncLangSummaryLabels() {
    const cur = LANGUAGES.find((x) => x.code === getLang());
    const name = cur ? cur.name : getLang().toUpperCase();
    setText("as-lang-summary", cur ? `${cur.native} — ${name}` : name);
  }

  function updateLangSaveButton() {
    const btn = el("lang-picker-save");
    if (!btn) return;
    btn.disabled = pendingLangCode === getLang();
  }

  async function persistLangPreference(code) {
    const u = auth.currentUser;
    if (!u) return;
    try {
      await setDoc(
        doc(db, "users", u.uid),
        { langPreference: code, updatedAt: serverTimestamp() },
        { merge: true }
      );
    } catch (e) {
      console.warn("langPreference save:", e);
    }
  }

  function renderLangPickerRows() {
    if (!langList) return;
    const q = langSearch?.value ?? "";
    const items = LANGUAGES.filter((L) => langMatchesFilter(L, q));
    if (!items.length) {
      langList.innerHTML = `<div class="lang-picker-empty" role="status">No languages match “${String(q).replace(/</g, "")}”.<span>Try English, हिन्दी, বাংলা, or clear the search.</span></div>`;
      return;
    }
    const picked = pendingLangCode;
    langList.innerHTML = items.map((L) => {
      const sel = L.code === picked;
      const flag = L.flag || "🌐";
      const reg = L.region ? `<span class="lang-row-region">${L.region}</span>` : "";
      return `<button type="button" class="lang-row rw ${sel ? "selected" : ""}" role="option" data-code="${L.code}" aria-selected="${sel ? "true" : "false"}">
        <span class="lang-row-flag" aria-hidden="true">${flag}</span>
        <span class="lang-row-meta"><strong>${L.name}</strong><span class="lang-row-sub">${L.native}</span>${reg}</span>
        <span class="lang-row-check" aria-hidden="true"><i class="ri-check-line"></i></span>
      </button>`;
    }).join("");
    langList.querySelectorAll(".lang-row").forEach((row) => {
      row.addEventListener("click", () => {
        const code = row.getAttribute("data-code");
        if (!code) return;
        pendingLangCode = code;
        renderLangPickerRows();
        updateLangSaveButton();
      });
    });
  }

  async function commitLanguageChoice() {
    if (pendingLangCode === getLang()) {
      window.closeLangPicker?.();
      return;
    }
    setLanguage(pendingLangCode);
    syncLangSummaryLabels();
    updateLangSaveButton();
    snack("Language saved. Applied across the app.");
    await persistLangPreference(pendingLangCode);
    window.closeLangPicker?.();
  }

  window.__langPickerOnOpen = () => {
    pendingLangCode = getLang();
    if (langSearch) langSearch.value = "";
    renderLangPickerRows();
    updateLangSaveButton();
  };

  window.__langPickerCancel = () => {
    pendingLangCode = getLang();
    if (langSearch) langSearch.value = "";
    renderLangPickerRows();
    updateLangSaveButton();
  };

  if (langSearch && langList) {
    syncLangSummaryLabels();
    langSearch.addEventListener("input", () => renderLangPickerRows());
    langSearch.addEventListener("search", () => renderLangPickerRows());
    el("lang-picker-save")?.addEventListener("click", () => commitLanguageChoice());
    document.addEventListener("langchange", () => {
      pendingLangCode = getLang();
      syncLangSummaryLabels();
      renderLangPickerRows();
      updateLangSaveButton();
    });
  }
}

/* ─── auth-dependent wiring ───────────── */
function attachUser(user) {
  const unsubs = [];
  /** @type {Record<string, unknown> | null} */
  let learningProfileLive = null;

  function renderLearningEvolutionPanel() {
    const lp = learningProfileLive;
    const lastHost = el("learn-ev-last-agg");
    const edgeHost = el("learn-ev-edge-teaser");
    const reflHost = el("learn-ev-reflections");
    const tlHost = el("learn-ev-timeline");
    const auditHost = el("learn-ev-audit");

    if (lastHost) {
      if (lp?.lastAggregatedAt) {
        const ms = tsMs(lp.lastAggregatedAt);
        const rs = typeof lp.lastReason === "string" ? lp.lastReason : "";
        lastHost.textContent =
          ms ? `${timeAgo(ms)} · ${rs || "scheduled merge"}` : "—";
      } else lastHost.textContent = "Not merged yet — save a scan or tap refresh.";
    }

    if (edgeHost) {
      const edges = Array.isArray(lp?.knowledgeEdges) ? lp.knowledgeEdges : [];
      if (!edges.length) edgeHost.textContent = "No distilled links yet.";
      else {
        const bits = edges.slice(0, 5).map((e) => {
          const c = typeof e.count === "number" ? `${e.count}×` : "";
          return `${escHtml(e.from)}→${escHtml(e.to)} ${c}`.trim();
        });
        edgeHost.innerHTML = `${bits.join("<br>")}<br><span style="opacity:.82;">${escHtml(String(edges.length))} total · co-occurrence heuristic</span>`;
      }
    }

    if (reflHost) {
      const raw = Array.isArray(lp?.reflections) ? lp.reflections : [];
      const lines = raw
        .map((x) => (typeof x === "string" ? x : x && typeof x.text === "string" ? x.text : ""))
        .map((t) => String(t).trim())
        .filter(Boolean)
        .slice(0, 8);
      reflHost.innerHTML = lines.length
        ? lines.map((t) => `<li>${escHtml(t)}</li>`).join("")
        : `<li style="color:var(--dim);list-style:none;margin-left:-10px;">No reflections yet — save scans or tap refresh.</li>`;
    }

    if (tlHost) {
      const tl = Array.isArray(lp?.timeline) ? lp.timeline : [];
      const slice = tl.slice(0, 6);
      tlHost.innerHTML = slice.length
        ? slice
            .map((row) => {
              const at = typeof row.at === "number" ? row.at : tsMs(row.at);
              const ago = at ? timeAgo(at) : "";
              const lab = row.label ? escHtml(row.label) : "";
              const val = row.value ? escHtml(row.value) : "";
              const det = row.detail ? ` — ${escHtml(row.detail)}` : "";
              return `<li>${ago ? `${ago}: ` : ""}<strong>${lab}</strong> ${val}${det}</li>`;
            })
            .join("")
        : `<li style="list-style:none;color:var(--dim);margin-left:-10px;">Empty — merges append short timeline notes.</li>`;
    }

    if (auditHost) {
      const al = Array.isArray(lp?.auditLog) ? lp.auditLog : [];
      const slice = al.slice(0, 6);
      auditHost.innerHTML = slice.length
        ? slice
            .map((a) => {
              const at = typeof a.at === "number" ? a.at : tsMs(a.at);
              const ago = at ? timeAgo(at) : "";
              const fld = a.field ? escHtml(a.field) : "";
              const rs = a.reason ? escHtml(a.reason) : "";
              const ch =
                a.oldVal != null || a.newVal != null
                  ? ` (${escHtml(String(a.oldVal))} → ${escHtml(String(a.newVal))})`
                  : "";
              return `<li>${ago ? `${ago} · ` : ""}${fld}: ${rs}${ch}</li>`;
            })
            .join("")
        : `<li style="list-style:none;color:var(--dim);margin-left:-10px;">No audit rows yet.</li>`;
    }
  }

  const refreshLearnBtn = el("learn-ev-refresh");
  if (refreshLearnBtn && !refreshLearnBtn.dataset.wired) {
    refreshLearnBtn.dataset.wired = "1";
    refreshLearnBtn.addEventListener("click", () => {
      queueLearningFlush(db, user.uid, "manual");
      snack("Learning refresh queued (background).");
    });
  }
  const sandTog = el("learn-ev-sandbox");
  if (sandTog && !sandTog.dataset.wired) {
    sandTog.dataset.wired = "1";
    sandTog.checked = isLearningSandboxPreview();
    sandTog.addEventListener("change", () => {
      try {
        if (sandTog.checked) localStorage.setItem("agri_learning_preview", "1");
        else localStorage.removeItem("agri_learning_preview");
      } catch (_) {}
      snack(sandTog.checked ? "Sandbox preview on (this device only)." : "Sandbox preview off.");
    });
  }

  const fallbackName = user.displayName || user.email?.split("@")[0] || "Farmer";
  const fallbackAv   = `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName)}&background=10B981&color=fff`;

  /* ── avatar upload ── */
  const camSetup = (btnId, avId) => {
    const btn = el(btnId);
    if (!btn) return;
    const inp = document.createElement("input");
    inp.type = "file"; inp.accept = "image/*"; inp.style.display = "none";
    document.body.appendChild(inp);
    btn.addEventListener("click", () => inp.click());
    inp.addEventListener("change", async () => {
      const file = inp.files?.[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) { window.alert("Image must be under 5 MB."); return; }
      try {
        const storageRef = ref(storage, `avatars/${user.uid}/${Date.now()}_${file.name}`);
        const task = uploadBytesResumable(storageRef, file);
        await new Promise((res, rej) => task.on("state_changed", null, rej, res));
        const url = await getDownloadURL(task.snapshot.ref);
        await setDoc(doc(db, "users", user.uid), { photoURL: url, updatedAt: serverTimestamp() }, { merge: true });
        await updateProfile(user, { photoURL: url });
        ["main-av","ep-av"].forEach(id => setAv(id, url));
      } catch (e) { window.alert("Upload failed: " + e.message); }
      finally { inp.value = ""; }
    });
    unsubs.push(() => { inp.remove(); });
  };
  camSetup("main-cam-btn", "main-av");
  camSetup("ep-cam-btn",   "ep-av");

  /* ── user doc ── */
  unsubs.push(onSnapshot(doc(db, "users", user.uid), snap => {
    const d = snap.exists() ? snap.data() : {};
    const name = d.name || user.displayName || fallbackName;
    const av   = d.photoURL || user.photoURL || fallbackAv;

    /* main */
    setText("main-name",  name);
    setText("main-email", user.email || "--");
    setText("main-phone", d.phone || user.phoneNumber || "Not set");
    setText("main-location", d.village || "Location not set");
    setHide("main-verified", !d.isVerified);
    setAv("main-av", av);

    /* account settings */
    setText("as-name",     name);
    setText("as-email",    user.email || "--");
    setText("as-phone",    d.phone || "Not set");
    setText("as-location", d.village || "Not set");

    /* edit profile defaults */
    const epName = el("ep-name"); if (epName) epName.value = name;
    const epEmail = el("ep-email"); if (epEmail) epEmail.value = user.email || "";
    const epPhone = el("ep-phone"); if (epPhone) epPhone.value = d.phone || "";
    const epLoc   = el("ep-location"); if (epLoc) epLoc.value = d.village || "";
    setAv("ep-av", av);
  }));

  /* ── edit profile save ── */
  const doSaveProfile = async () => {
    const name  = (el("ep-name")?.value  || "").trim();
    const phone = (el("ep-phone")?.value || "").trim();
    const loc   = (el("ep-location")?.value || "").trim();
    if (!name) { snack("Please enter your name.", true); return; }

    const btn = el("ep-save-btn");
    const hdrBtn = el("ep-save-hdr-btn");
    const setBusy = (v) => {
      if (btn) { btn.disabled = v; btn.textContent = v ? "Saving…" : "Save Changes"; }
      if (hdrBtn) hdrBtn.style.opacity = v ? ".4" : "1";
    };
    setBusy(true);
    try {
      // Write to Firestore
      await setDoc(
        doc(db, "users", user.uid),
        { name, phone, village: loc, updatedAt: serverTimestamp() },
        { merge: true }
      );
      // Update Auth display name — ignore failure, it's cosmetic
      try { await updateProfile(user, { displayName: name }); } catch (_) {}

      // Show feedback, then close panel after snackbar is visible
      snack("Profile saved!");
      setTimeout(() => window.closePanel?.("panel-edit-profile"), 900);
    } catch (e) {
      console.error("Save profile error:", e);
      snack("Save failed: " + (e.message || e.code || "unknown error"), true);
    } finally {
      setBusy(false);
    }
  };
  el("ep-save-btn")?.addEventListener("click",     doSaveProfile);
  el("ep-save-hdr-btn")?.addEventListener("click", doSaveProfile);

  /* ── farm data ── */
  let fields = [], scans = [], msgs = 0;

  const recompute = () => {
    const score = computeScore({ fields: fields.length, scans: scans.length, msgs });
    renderScore(score);

    /* overview */
    const crops = new Set(fields.map(f => f.cropName).filter(Boolean)).size;
    setText("ov-farms",  fields.length || "0");
    setText("ov-area",   fields.length ? fields.reduce((s,f) => s + (f.areaAcres||0), 0).toFixed(1) : "--");
    setText("ov-crops",  crops || "--");
    el("ov-farms-pill") && (el("ov-farms-pill").textContent = fields.length ? "Active" : "—");

    const recent = scans.filter(s => Date.now() - tsMs(s.createdAt) <= 30 * 86400000);
    if (recent.length) {
      const good = recent.filter(s => s.severity?.level === "good").length;
      const pct  = Math.round((good / recent.length) * 100);
      setText("ov-health", pct + "%");
      const ph = el("ov-health-pill");
      if (ph) {
        ph.textContent = pct >= 70 ? "Good" : pct >= 40 ? "Moderate" : "At Risk";
        ph.className   = "sb-pill " + (pct >= 70 ? "hp-good" : pct >= 40 ? "hp-mod" : "hp-risk");
      }
    } else {
      setText("ov-health", "--");
    }
    renderActivity(scans);

    /* my farms list */
    const farmsList = el("farms-list");
    if (farmsList) {
      if (!fields.length) {
        farmsList.innerHTML = `<div style="text-align:center;padding:40px 20px;color:var(--dim);font-size:13px;">
          <i class="ri-plant-line" style="font-size:36px;display:block;margin-bottom:10px;"></i>
          No fields yet. Add one from Fields page.</div>`;
      } else {
        const fieldScans = {};
        scans.forEach(s => {
          if (!s.fieldId) return;
          if (!fieldScans[s.fieldId]) fieldScans[s.fieldId] = [];
          fieldScans[s.fieldId].push(s);
        });
        farmsList.innerHTML = fields.map(f => {
          const fscans = fieldScans[f.id] || [];
          const good   = fscans.filter(s => s.severity?.level === "good").length;
          const pct    = fscans.length ? (good / fscans.length) * 100 : 0;
          return buildFarmCard(f, pct);
        }).join("");
      }
    }
  };

  unsubs.push(onSnapshot(
    query(collection(db, "fields"), where("userId","==",user.uid), limit(100)),
    snap => { fields = snap.docs.map(d => ({ id: d.id, ...d.data() })); recompute(); }
  ));

  unsubs.push(onSnapshot(
    query(collection(db, "crop_scans"), where("userId","==",user.uid), limit(500)),
    snap => { scans = snap.docs.map(d => ({ id: d.id, ...d.data() })); recompute(); }
  ));

  unsubs.push(onSnapshot(
    query(collection(db, "activity_history"), where("userId","==",user.uid), limit(300)),
    snap => {
      msgs = 0;
      snap.forEach(d => { if (d.data().type === "assistant.message") msgs++; });
      recompute();
    }
  ));

  unsubs.push(
    onSnapshot(doc(db, "learning_profiles", user.uid), (snap) => {
      learningProfileLive = snap.exists() ? snap.data() : null;
      renderLearningEvolutionPanel();
    }),
  );

  renderLearningEvolutionPanel();

  return () => unsubs.forEach(u => { try { u(); } catch(_){} });
}

/* ─── boot ────────────────────────────── */
let teardown = null;

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", wireStatic, { once: true });
} else {
  wireStatic();
}

onAuthStateChanged(auth, user => {
  if (teardown) { teardown(); teardown = null; }
  if (!user) {
    if (isProfilePanelE2ELocal()) return;
    if (!location.pathname.includes("login.html")) location.href = "login.html";
    return;
  }
  teardown = attachUser(user);
});

window.refreshAiDiag = function refreshAiDiag() {
  const p = document.getElementById("ai-diag-body");
  if (p) p.textContent = getDiagnosticsLines().join("\n");
};
