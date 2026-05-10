import "./auth-session.js?v=31";
import "./i18n.js?v=5";
import { auth, db } from "./auth.js?v=31";
import { getLang } from "./i18n.js?v=5";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { runAgriOrchestrator } from "./ai/orchestrator.js?v=41";
import { attachSnapshotForReply, composeAssistantReply } from "./ai/assistant-reply.js?v=41";
import { getAiConfig } from "./ai/config.js?v=34";
import {
  buildProactiveDigest,
  defaultCompanionProfile,
  mergeCompanionAfterTurn,
  normalizeCompanionProfile,
} from "./ai/companion-memory.js?v=35";
import { fetchRegionalBriefing } from "./network/regional-briefing.js";
import {
  buildCasualAssistantReply,
  classifyAssistantRouting,
} from "./ai/assistant-intent-router.js?v=41";

function el(id) {
  return document.getElementById(id);
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function formatTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function renderMessages(container, msgs) {
  if (!container) return;
  container.innerHTML = msgs
    .slice()
    .sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt))
    .map((m) => {
      const role = m.role === "user" ? "user" : "assistant";
      const who = role === "user" ? "You" : "Assistant";
      const time = formatTime(tsToMs(m.createdAt));
      const safe = String(m.text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      return `
        <div class="msg ${role}">
          <div class="meta"><span>${who}</span><span>${time}</span></div>
          <div class="text">${safe}</div>
        </div>
      `;
    })
    .join("");
  // keep latest visible
  container.scrollIntoView({ block: "end" });
}

function buildAssistantReply({ question, fields, scans, recs, weatherLogs }) {
  const q = question.toLowerCase();

  const fieldCount = fields.length;
  const scanCount = scans.length;
  const latestScan = scans.slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))[0] || null;
  const latestWeather = weatherLogs.slice().sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt))[0] || null;

  const lines = [];

  // Always ground the response in real state first.
  lines.push(`Current state: ${fieldCount} field${fieldCount === 1 ? "" : "s"}, ${scanCount} scan${scanCount === 1 ? "" : "s"}.`);

  if (q.includes("start") || q.includes("setup") || q.includes("begin")) {
    if (!fieldCount && !scanCount) {
      lines.push("");
      lines.push("To activate analytics:");
      lines.push("- Add your first field in Fields.");
      lines.push("- Run your first crop scan and save it.");
      lines.push("- (Optional) Enable location to build weather logs.");
      return lines.join("\n");
    }
  }

  if (q.includes("latest") || q.includes("last scan") || q.includes("scan")) {
    if (!latestScan) {
      lines.push("");
      lines.push("No scans yet. Run a scan to generate your first health score and recommendations.");
      return lines.join("\n");
    }
    const health = typeof latestScan.healthScore === "number" ? `${Math.round(latestScan.healthScore)}%` : "--";
    const diag = latestScan.diagnosis?.label || "Scan saved";
    lines.push("");
    lines.push(`Latest scan: ${latestScan.cropType || "Crop"} • ${diag} • Health ${health}.`);
    if (latestScan.recommendations && latestScan.recommendations.length) {
      lines.push("Top actions:");
      for (const r of latestScan.recommendations.slice(0, 3)) lines.push(`- ${r.text}`);
    }
    return lines.join("\n");
  }

  if (q.includes("recommend") || q.includes("insight") || q.includes("next action")) {
    const active = recs.filter((r) => (r.status || "active") === "active");
    if (!active.length) {
      lines.push("");
      lines.push("No recommendations yet. Recommendations appear after you save scans (and later: weather/sensor logs).");
      return lines.join("\n");
    }
    active.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    lines.push("");
    lines.push("Latest recommendations:");
    for (const r of active.slice(0, 5)) lines.push(`- ${r.text}`);
    return lines.join("\n");
  }

  if (q.includes("weather") || q.includes("rain") || q.includes("humidity")) {
    if (!latestWeather) {
      lines.push("");
      lines.push("No weather logs yet. Enable location in the app to sync real weather data into your account.");
      return lines.join("\n");
    }
    const c = latestWeather.city || "your area";
    const cur = latestWeather.current || {};
    const t = typeof cur.temperature_2m === "number" ? `${Math.round(cur.temperature_2m)}°C` : "--";
    const hum = typeof cur.relative_humidity_2m === "number" ? `${Math.round(cur.relative_humidity_2m)}%` : "--";
    lines.push("");
    lines.push(`Latest weather log (${c}): Temp ${t}, Humidity ${hum}.`);
    return lines.join("\n");
  }

  if (q.includes("field")) {
    if (!fieldCount) {
      lines.push("");
      lines.push("No fields yet. Add a field to unlock per-field monitoring and coverage metrics.");
      return lines.join("\n");
    }
    lines.push("");
    lines.push("Your fields:");
    for (const f of fields.slice(0, 5)) lines.push(`- ${f.name || "Field"}${f.cropType ? ` (${f.cropType})` : ""}`);
    if (fieldCount > 5) lines.push(`- …and ${fieldCount - 5} more`);
    return lines.join("\n");
  }

  // Default: safe, minimal guidance without pretending.
  lines.push("");
  if (!fieldCount && !scanCount) {
    lines.push("I don’t have enough activity to analyze yet. Add a field or save a scan and I’ll adapt immediately.");
  } else {
    lines.push("Ask about your latest scan, recommendations, weather logs, or field coverage and I’ll answer using your real data.");
  }
  return lines.join("\n");
}

onAuthStateChanged(auth, (user) => {
  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const listEl = el("assistant-messages");
  const emptyEl = el("assistant-empty");
  const inputEl = el("assistant-input");
  const sendBtn = el("assistant-send");
  const clearBtn = el("assistant-clear");
  const subEl = el("assistant-subtitle");

  let fields = [];
  let scans = [];
  let recs = [];
  let weatherLogs = [];
  let environmental = [];
  let fieldContextStates = [];
  let farmInterventions = [];
  let farmOperationalTasks = [];
  let assistantAlerts = [];
  let pendingImageBlob = null;
  let companionProfile = defaultCompanionProfile(user.uid);
  let lastMsgCount = 0;
  /** Cached anonymized regional briefing; `fetchRegionalBriefing` also rate-limits reads. */
  let regionalBriefingText = null;
  /** Latest `learning_profiles/{uid}` (may be absent until first aggregation). */
  let learningProfile = null;

  function updateCompanionEmptyHint() {
    const hintEl = el("assistant-companion-hint");
    if (!hintEl) return;
    if (lastMsgCount !== 0) {
      hintEl.textContent = "";
      hintEl.classList.add("hidden");
      return;
    }
    const live = buildProactiveDigest({ fields, scans, fieldContextStates, weatherLogs, recs });
    const text = (companionProfile.proactiveDigest || "").trim() || live;
    const regHint =
      regionalBriefingText && regionalBriefingText.length > 30
        ? `\n\nRegional network (coarse, anonymized): ${regionalBriefingText.slice(0, 240).trim()}${
            regionalBriefingText.length > 240 ? "…" : ""
          }`
        : "";
    const full = text + regHint;
    hintEl.textContent = full;
    hintEl.classList.toggle("hidden", !full.trim());
  }

  onSnapshot(doc(db, "companion_profiles", user.uid), (snap) => {
    companionProfile = normalizeCompanionProfile(snap.data(), user.uid);
    updateCompanionEmptyHint();
  });

  onSnapshot(doc(db, "learning_profiles", user.uid), (snap) => {
    learningProfile = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    updateCompanionEmptyHint();
  });

  const attachInput = el("assistant-attach-input");
  const attachBtn = el("assistant-attach");

  if (subEl) {
    const cfg = getAiConfig();
    subEl.textContent = cfg.inferenceBaseUrl
      ? `Agricultural intelligence • ${cfg.enginePackVersion} • vision API configured`
      : `Agricultural intelligence • ${cfg.enginePackVersion} • live weather + your Firestore data`;
  }

  fetchRegionalBriefing(db)
    .then((t) => {
      regionalBriefingText = t;
      updateCompanionEmptyHint();
    })
    .catch(() => {});

  const refreshAttachUi = () => {
    if (!attachBtn) return;
    attachBtn.classList.toggle("has-file", !!pendingImageBlob);
    attachBtn?.setAttribute("aria-label", pendingImageBlob ? "Replace attached image" : "Attach crop photo");
  };

  const msgsQ = query(collection(db, "assistant_messages"), where("userId", "==", user.uid), limit(200));
  onSnapshot(msgsQ, (snap) => {
    const msgs = [];
    snap.forEach((d) => msgs.push({ id: d.id, ...d.data() }));
    lastMsgCount = msgs.length;
    if (emptyEl) emptyEl.classList.toggle("hidden", msgs.length > 0);
    renderMessages(listEl, msgs);
    updateCompanionEmptyHint();
  });

  onSnapshot(query(collection(db, "fields"), where("userId", "==", user.uid), limit(200)), (snap) => {
    fields = [];
    snap.forEach((d) => fields.push({ id: d.id, ...d.data() }));
    updateCompanionEmptyHint();
  });
  onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(500)), (snap) => {
    scans = [];
    snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
    updateCompanionEmptyHint();
  });
  onSnapshot(query(collection(db, "ai_recommendations"), where("userId", "==", user.uid), limit(200)), (snap) => {
    recs = [];
    snap.forEach((d) => recs.push({ id: d.id, ...d.data() }));
    updateCompanionEmptyHint();
  });
  onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(50)), (snap) => {
    weatherLogs = [];
    snap.forEach((d) => weatherLogs.push({ id: d.id, ...d.data() }));
    updateCompanionEmptyHint();
  });
  onSnapshot(query(collection(db, "environmental_data"), where("userId", "==", user.uid), limit(40)), (snap) => {
    environmental = [];
    snap.forEach((d) => environmental.push({ id: d.id, ...d.data() }));
  });
  onSnapshot(query(collection(db, "field_context_state"), where("userId", "==", user.uid), limit(40)), (snap) => {
    fieldContextStates = [];
    snap.forEach((d) => fieldContextStates.push({ id: d.id, fieldId: d.id, ...d.data() }));
    updateCompanionEmptyHint();
  });

  onSnapshot(
    query(collection(db, "farm_interventions"), where("userId", "==", user.uid), limit(120)),
    (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      rows.sort((a, b) => tsToMs(b.performedAt) - tsToMs(a.performedAt));
      farmInterventions = rows.slice(0, 48);
      updateCompanionEmptyHint();
    },
  );

  onSnapshot(
    query(collection(db, "farm_operational_tasks"), where("userId", "==", user.uid), limit(120)),
    (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      rows.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
      farmOperationalTasks = rows.slice(0, 48);
      updateCompanionEmptyHint();
    },
  );

  onSnapshot(
    query(collection(db, "alerts"), where("userId", "==", user.uid), limit(80)),
    (snap) => {
      const rows = [];
      snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
      rows.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
      assistantAlerts = rows.slice(0, 40);
      updateCompanionEmptyHint();
    },
  );

  attachBtn?.addEventListener("click", () => attachInput?.click());
  attachInput?.addEventListener("change", () => {
    const f = attachInput.files?.[0];
    if (!f || !String(f.type || "").startsWith("image/")) return;
    pendingImageBlob = f;
    refreshAttachUi();
    attachInput.value = "";
  });

  async function send() {
    const text = (inputEl?.value || "").trim();
    const imageBlob = pendingImageBlob;
    if (!text && !imageBlob) return;

    pendingImageBlob = null;
    refreshAttachUi();

    if (sendBtn) sendBtn.disabled = true;
    if (inputEl) inputEl.value = "";

    try {
      const userMsgRef = await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "user",
        text: text || (imageBlob ? "(Image attached)" : ""),
        hasAttachment: !!imageBlob,
        createdAt: serverTimestamp(),
        schemaVersion: 2,
      });

      const routing = classifyAssistantRouting(text, { hasImage: !!imageBlob });

      let snapshot = null;
      let orch = null;
      let reply = "";

      if (routing.mode === "casual") {
        reply = buildCasualAssistantReply(text, { fieldCount: fields.length, scanCount: scans.length });
      } else {
        if (routing.mode !== "weather_quick" && !regionalBriefingText) {
          try {
            regionalBriefingText = await fetchRegionalBriefing(db);
          } catch {
            regionalBriefingText = "";
          }
        }

        snapshot = {
          userId: user.uid,
          fields,
          scans,
          recs,
          weatherLogs,
          environmental,
          fieldContextStates,
          interventions: farmInterventions,
          operationalTasks: farmOperationalTasks,
          alerts: assistantAlerts,
          locale: getLang() || "en",
          companion: companionProfile,
          regionalBriefing: routing.mode === "weather_quick" ? "" : regionalBriefingText || "",
          learningProfile: routing.mode === "weather_quick" ? null : learningProfile || null,
        };

        const orchOpts = routing.mode === "weather_quick" ? { routingMode: "weather_quick" } : {};
        orch = await runAgriOrchestrator(text || "Analyze the attached crop image.", snapshot, { imageBlob }, orchOpts);
        attachSnapshotForReply(orch, snapshot);
        reply = composeAssistantReply(text || "[image]", orch, {
          locale: snapshot.locale,
          companionProfile,
          replyVerbosity: routing.mode === "weather_quick" ? "minimal" : "full",
        });

        if (!reply) {
          reply = buildAssistantReply({ question: text, fields, scans, recs, weatherLogs });
        }
      }

      try {
        const orchForMemory =
          orch ||
          ({
            intents: {},
            results: {},
            enginePackVersion: "casual-turn",
          });
        const nextProfile = mergeCompanionAfterTurn(companionProfile, {
          userText: text,
          assistantReply: reply,
          orch: orchForMemory,
          locale: (snapshot && snapshot.locale) || getLang() || "en",
          fields,
          scans,
          fieldContextStates,
          weatherLogs,
          recs,
          userId: user.uid,
        });
        await setDoc(doc(db, "companion_profiles", user.uid), nextProfile, { merge: true });
      } catch (memErr) {
        console.warn("[assistant] companion memory:", memErr?.message || memErr);
      }

      if (routing.mode !== "casual") {
        await addDoc(collection(db, "ai_engine_runs"), {
          userId: user.uid,
          createdAt: serverTimestamp(),
          replyTo: userMsgRef.id,
          enginePackVersion: orch?.enginePackVersion,
          intents: orch?.intents,
          preview: orch?.persistedPreview || null,
          geo: orch?.geo || null,
          routingMode: orch?.routingMode || "full",
          schemaVersion: 1,
        });
      }

      await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "assistant",
        text: reply,
        createdAt: serverTimestamp(),
        replyTo: userMsgRef.id,
        enginePackVersion: orch?.enginePackVersion || (routing.mode === "casual" ? "casual-turn" : ""),
        enginePreview: orch?.persistedPreview || null,
        routingMode: routing.mode,
        schemaVersion: 2,
      });
    } catch (e) {
      console.error(e);
      alert(`Failed to send: ${e.message}`);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
      inputEl?.focus();
    }
  }

  sendBtn?.addEventListener("click", send);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  clearBtn?.addEventListener("click", async () => {
    const ok = confirm("Clear assistant chat and engine run history for this account?");
    if (!ok) return;
    try {
      const runsQ = query(collection(db, "ai_engine_runs"), where("userId", "==", user.uid), limit(500));
      const [msgSnap, runSnap] = await Promise.all([getDocs(msgsQ), getDocs(runsQ)]);
      const batch = writeBatch(db);
      msgSnap.forEach((d) => batch.delete(doc(db, "assistant_messages", d.id)));
      runSnap.forEach((d) => batch.delete(doc(db, "ai_engine_runs", d.id)));
      await batch.commit();
    } catch (e) {
      console.error(e);
      alert(`Failed to clear: ${e.message}`);
    }
  });
});

