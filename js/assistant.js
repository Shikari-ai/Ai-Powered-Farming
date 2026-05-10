import "./auth-session.js?v=32";
import "./i18n.js?v=6";
import { auth, db } from "./auth.js?v=32";
import { getLang } from "./i18n.js?v=6";
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

import { runAgriOrchestrator } from "./ai/orchestrator.js?v=50";
import { attachSnapshotForReply, composeAssistantReply } from "./ai/assistant-reply.js?v=50";
import { getAiConfig } from "./ai/config.js?v=49";
import {
  buildProactiveDigest,
  defaultCompanionProfile,
  mergeCompanionAfterTurn,
  normalizeCompanionProfile,
} from "./ai/companion-memory.js?v=48";
import { fetchRegionalBriefing } from "./network/regional-briefing.js";
import {
  buildCasualAssistantReply,
  buildVagueSymptomReply,
  classifyAssistantRouting,
} from "./ai/assistant-intent-router.js?v=49";
import { detectConversationMood, polishFarmReportProse } from "./ai/conversation-naturals.js?v=48";
import { runAssistantTextStream } from "./ai/assistant-stream.js?v=48";
import { computePresencePlan, maybePresenceMemoryNudge, sleep as presenceSleep } from "./ai/conversation-presence.js?v=48";
import { getFlowSnapshot, recordFlowUserTurn, resolveReplyVerbosity, streamRhythmPreference } from "./ai/conversation-flow.js?v=48";

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

/** Walk up to a scrollable parent (else document). */
function getAssistantScrollRoot(fromEl) {
  let p = fromEl;
  while (p && p !== document.body) {
    const st = getComputedStyle(p);
    const oy = st.overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
    p = p.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function renderMessages(container, msgs, opts = {}) {
  if (!container) return;
  const awaitingId = opts.awaitingUserMsgId || null;
  const stream = opts.streamingAssistant || null;
  const showTyping =
    !!awaitingId &&
    msgs.some((m) => m.id === awaitingId && m.role === "user") &&
    !stream;

  const sorted = msgs.slice().sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
  const partsHtml = sorted
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

  const streamHtml = stream
    ? `
    <div class="msg assistant streaming-reply thinking" data-stream-shell="1" aria-live="polite" aria-busy="true">
      <div class="meta"><span>Assistant</span><span>…</span></div>
      <div class="stream-thinking-glow" aria-hidden="true"></div>
      <div class="text stream-text-host is-streaming" data-stream-text="1"><span class="stream-plain"></span><span class="stream-caret" aria-hidden="true"></span></div>
    </div>`
    : "";

  const typingHtml = showTyping
    ? `
    <div class="msg assistant typing" aria-live="polite" aria-busy="true">
      <div class="meta"><span>Assistant</span><span>…</span></div>
      <div class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>`
    : "";

  container.innerHTML = partsHtml + streamHtml + typingHtml;
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
  document.body.classList.add("assistant-page");

  const emptyEl = el("assistant-empty");
  const inputEl = el("assistant-input");
  inputEl?.addEventListener("focus", () => document.body.classList.add("assistant-composer-focus"));
  inputEl?.addEventListener("blur", () => document.body.classList.remove("assistant-composer-focus"));
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
  let chatMessages = [];
  /** While set, UI shows a typing row after this user message (until assistant stream starts). */
  let awaitingAssistantAfterUserId = null;
  /** When true, message list repaint during Firestore snapshot is skipped (stream owns DOM). */
  let streamInFlight = false;
  /** Live client-side stream shell; assistant row is persisted after stream completes. */
  let streamingAssistant = null; // { fullText: string, userMsgId: string, profile: string }
  /** Per-send generation; new send aborts previous stream via signal + generation check. */
  let sendGeneration = 0;
  let streamAbort = new AbortController();
  /** @type {{ promise: Promise<string>, fastForward: () => void } | null} */
  let activeStreamCtrl = null;
  /** User scrolled up → stop following; near bottom again → resume follow. */
  let followPinnedBottom = true;
  const SCROLL_NEAR_BOTTOM_PX = 110;
  /** @type {HTMLElement | null} */
  let listScrollRoot = null;
  /** Cached anonymized regional briefing; `fetchRegionalBriefing` also rate-limits reads. */
  let regionalBriefingText = null;
  /** Latest `learning_profiles/{uid}` (may be absent until first aggregation). */
  let learningProfile = null;

  listScrollRoot = getAssistantScrollRoot(listEl);
  listScrollRoot.addEventListener(
    "scroll",
    () => {
      const r = listScrollRoot;
      if (!r) return;
      const near = r.scrollHeight - r.scrollTop - r.clientHeight < SCROLL_NEAR_BOTTOM_PX;
      followPinnedBottom = near;
    },
    { passive: true },
  );

  inputEl?.addEventListener("input", () => {
    if (streamInFlight && activeStreamCtrl) activeStreamCtrl.fastForward();
  });

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

  function paintChat() {
    const hasStreamShell = !!streamingAssistant;
    if (emptyEl) emptyEl.classList.toggle("hidden", chatMessages.length > 0 || hasStreamShell);
    renderMessages(listEl, chatMessages, {
      awaitingUserMsgId: awaitingAssistantAfterUserId,
      streamingAssistant,
    });
    updateCompanionEmptyHint();
    const root = listScrollRoot || getAssistantScrollRoot(listEl);
    if (followPinnedBottom) {
      requestAnimationFrame(() => {
        try {
          root.scrollTo({ top: root.scrollHeight, behavior: "auto" });
        } catch {
          root.scrollTop = root.scrollHeight;
        }
      });
    }
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
    chatMessages = msgs;
    if (!streamInFlight) paintChat();
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

    const hadPriorStreamInterrupt = streamInFlight;
    streamAbort.abort();
    streamAbort = new AbortController();
    sendGeneration += 1;
    const myGen = sendGeneration;
    followPinnedBottom = true;

    if (sendBtn) sendBtn.disabled = true;
    if (inputEl) inputEl.value = "";

    try {
      const flowTurnText = text || (imageBlob ? "(Image attached)" : "");
      recordFlowUserTurn({ text: flowTurnText, hadPriorStreamInterrupt: hadPriorStreamInterrupt });
      const flowSnap = getFlowSnapshot();

      const userMsgRef = await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "user",
        text: text || (imageBlob ? "(Image attached)" : ""),
        hasAttachment: !!imageBlob,
        createdAt: serverTimestamp(),
        schemaVersion: 2,
      });

      const optimisticUser = {
        id: userMsgRef.id,
        userId: user.uid,
        role: "user",
        text: text || (imageBlob ? "(Image attached)" : ""),
        hasAttachment: !!imageBlob,
        createdAt: { toMillis: () => Date.now() },
        schemaVersion: 2,
      };
      if (!chatMessages.some((m) => m.id === userMsgRef.id)) {
        chatMessages = [...chatMessages, optimisticUser].sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
      }
      awaitingAssistantAfterUserId = userMsgRef.id;
      paintChat();

      const routing = classifyAssistantRouting(text, { hasImage: !!imageBlob });

      let snapshot = null;
      let orch = null;
      let reply = "";

      if (routing.mode === "casual") {
        reply = buildCasualAssistantReply(text, { fieldCount: fields.length, scanCount: scans.length });
      } else if (routing.mode === "clarify") {
        reply = buildVagueSymptomReply(text, { fieldCount: fields.length, scanCount: scans.length });
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

        orch = await runAgriOrchestrator(text || "Analyze the attached crop image.", snapshot, { imageBlob }, {
          routingMode: routing.mode === "weather_quick" ? "weather_quick" : "full",
          flowSnapshot: flowSnap,
        });
        attachSnapshotForReply(orch, snapshot);
        const replyVerbosity =
          routing.mode === "weather_quick" ? "minimal" : resolveReplyVerbosity({ routingMode: routing.mode, profile: companionProfile, flow: flowSnap });
        reply = composeAssistantReply(text || "[image]", orch, {
          locale: snapshot.locale,
          companionProfile,
          replyVerbosity,
          routingReason: routing.reason,
        });

        if (!reply) {
          reply = buildAssistantReply({ question: text, fields, scans, recs, weatherLogs });
        }
      }

      const mood = detectConversationMood(text);
      reply = polishFarmReportProse(reply, { mood, routingMode: routing.mode });

      const memNudge = maybePresenceMemoryNudge(companionProfile, {
        routingMode: routing.mode,
        userText: text,
        replyLength: reply.length,
        fields,
        flowSnapshot: flowSnap,
      });
      if (memNudge) {
        reply = `${reply.trimEnd()}\n\n${memNudge}`;
      }

      try {
        const orchForMemory =
          orch ||
          ({
            intents: {},
            results: {},
            enginePackVersion: routing.mode === "clarify" ? "clarify-turn" : "casual-turn",
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

      if (routing.mode !== "casual" && routing.mode !== "clarify") {
        await addDoc(collection(db, "ai_engine_runs"), {
          userId: user.uid,
          createdAt: serverTimestamp(),
          replyTo: userMsgRef.id,
          enginePackVersion: orch?.enginePackVersion,
          intents: orch?.intents,
          preview: orch?.persistedPreview || null,
          geo: orch?.geo || null,
          routingMode: orch?.routingMode || "full",
          cognitive: orch?.cognitivePlan
            ? {
                layer: orch.cognitivePlan.layer,
                reasoningDepth: orch.cognitivePlan.reasoningDepth,
                llmTier: orch.cognitivePlan.llmTier,
              }
            : null,
          verificationChecks: orch?.cognitiveVerification?.checks || null,
          schemaVersion: 1,
        });
      }

      const presencePlan = computePresencePlan({
        routingMode: routing.mode,
        userText: text,
        replyLength: reply.length,
        mood,
        flowSnapshot: flowSnap,
      });
      await presenceSleep(presencePlan.preStreamMs);

      awaitingAssistantAfterUserId = null;
      streamInFlight = true;
      streamingAssistant = {
        fullText: reply,
        userMsgId: userMsgRef.id,
        profile: routing.mode,
      };
      paintChat();

      const textEl = listEl.querySelector("[data-stream-text]");
      const streamShell = listEl.querySelector("[data-stream-shell]");
      if (!textEl || myGen !== sendGeneration) {
        streamInFlight = false;
        streamingAssistant = null;
        activeStreamCtrl = null;
        paintChat();
        return;
      }

      if (sendBtn) sendBtn.disabled = false;

      activeStreamCtrl = runAssistantTextStream({
        textHost: textEl,
        fullText: reply,
        streamProfile: routing.mode,
        streamLeadInMs: presencePlan.streamLeadInMs,
        rhythmTone: streamRhythmPreference(flowSnap, routing.mode),
        signal: streamAbort.signal,
        shouldFollowScroll: () => followPinnedBottom,
        getScrollRoot: getAssistantScrollRoot,
        onFirstChar: () => {
          streamShell?.classList.remove("thinking");
          streamShell?.classList.add("stream-speaking");
        },
      });

      const streamResult = await activeStreamCtrl.promise;
      activeStreamCtrl = null;

      if (myGen !== sendGeneration || streamResult === "aborted") {
        streamInFlight = false;
        streamingAssistant = null;
        activeStreamCtrl = null;
        paintChat();
        return;
      }

      await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "assistant",
        text: reply,
        createdAt: serverTimestamp(),
        replyTo: userMsgRef.id,
        enginePackVersion:
          orch?.enginePackVersion || (routing.mode === "clarify" ? "clarify-turn" : routing.mode === "casual" ? "casual-turn" : ""),
        enginePreview: orch?.persistedPreview || null,
        routingMode: routing.mode,
        schemaVersion: 2,
      });
      streamInFlight = false;
      streamingAssistant = null;
    } catch (e) {
      console.error(e);
      alert(`Failed to send: ${e.message}`);
    } finally {
      awaitingAssistantAfterUserId = null;
      streamInFlight = false;
      streamingAssistant = null;
      activeStreamCtrl = null;
      paintChat();
      if (sendBtn && myGen === sendGeneration) sendBtn.disabled = false;
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
    streamAbort.abort();
    sendGeneration += 1;
    streamAbort = new AbortController();
    streamInFlight = false;
    streamingAssistant = null;
    activeStreamCtrl = null;
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

