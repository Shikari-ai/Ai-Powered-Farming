import "./auth-session.js?v=33";
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
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { runAgriOrchestrator } from "./ai/orchestrator.js?v=73";
import { attachSnapshotForReply, composeAssistantReply, composeOperationsSnapshotReply } from "./ai/assistant-reply.js?v=73";
import { tryGeminiReply } from "./ai/gemini-client.js?v=3";
import { getAiConfig } from "./ai/config.js?v=71";
import {
  buildKnowledgeDocPayload,
  findMergeTargetEntry,
  findRelevantKnowledgeMemory,
  KNOWLEDGE_MEMORY_CAP,
  mergeKnowledgeEntries,
} from "./ai/assistant-knowledge-memory.js?v=1";
import { computeTurnConfidence, shouldUseWebAssistedResearch } from "./ai/web-research-policy.js?v=4";
import { fetchPublicAgriBrief, formatWebResearchAppend } from "./ai/web-research-client.js?v=4";
import {
  buildProactiveDigest,
  defaultCompanionProfile,
  mergeCompanionAfterTurn,
  normalizeCompanionProfile,
} from "./ai/companion-memory.js?v=48";
import { fetchRegionalBriefing } from "./network/regional-briefing.js";
import {
  buildCasualAssistantReply,
  buildMicroSocialAssistantReply,
  buildVagueSymptomReply,
  classifyAssistantRouting,
} from "./ai/assistant-intent-router.js?v=62";
import {
  detectConversationMood,
  polishFarmReportProse,
  pushRecentAssistantOpening,
} from "./ai/conversation-naturals.js?v=48";

import { runAssistantTextStream } from "./ai/assistant-stream.js?v=48";
import { computePresencePlan, maybePresenceMemoryNudge, sleep as presenceSleep } from "./ai/conversation-presence.js?v=48";
import { getFlowSnapshot, recordFlowUserTurn, resolveReplyVerbosity, streamRhythmPreference } from "./ai/conversation-flow.js?v=48";

const ROUTING_NO_ENGINE_LOG = /** @type {const} */ (["micro_social", "casual", "clarify", "operations_quick"]);

/** @param {Record<string, unknown>} o */
function stripUndefinedForFirestore(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** @param {{ id: string, data: () => any }} d */
function normalizeKnowledgeMemoryDoc(d) {
  const x = d.data();
  const lastR = x.lastReinforcedAt;
  const lastRMs =
    lastR && typeof lastR.toMillis === "function"
      ? lastR.toMillis()
      : typeof lastR === "string"
        ? Date.parse(lastR) || 0
        : 0;
  return {
    id: d.id,
    ...x,
    lastUsedAtMs: x.lastUsedAt?.toMillis?.() ?? 0,
    createdAtMs: x.createdAt?.toMillis?.() ?? 0,
    lastReinforcedAtMs: lastRMs,
  };
}

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
  const supersededIds = opts.supersededIds || new Set();
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
      const supersededBadge =
        role === "user" && supersededIds.has(m.id)
          ? `<div class="msg-superseded" aria-label="Superseded by the next message">superseded by your next message</div>`
          : "";
      return `
        <div class="msg ${role}${role === "user" && supersededIds.has(m.id) ? " is-superseded" : ""}">
          <div class="meta"><span>${who}</span><span>${time}</span></div>
          <div class="text">${safe}</div>
          ${supersededBadge}
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

/** @type {Array<() => void>} */
let activeSubscriptions = [];
function teardownSubscriptions() {
  for (const u of activeSubscriptions) {
    try { u?.(); } catch (e) { console.warn("[assistant] teardown:", e); }
  }
  activeSubscriptions = [];
}

onAuthStateChanged(auth, (user) => {
  // Auth callbacks can fire multiple times (token refresh, sign-out+in,
  // multi-tab). Tear down any prior snapshot listeners before re-binding,
  // otherwise each refresh stacks another full set of Firestore reads.
  teardownSubscriptions();

  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const listEl = el("assistant-messages");
  document.body.classList.add("assistant-page");

  // ── Mobile keyboard: keep fixed header pinned to the visible top ──
  // On iOS Safari (and older Android browsers) when the keyboard opens,
  // the layout viewport stays full-height but the *visual* viewport
  // shrinks. A `position: fixed; top: 0` element then sits at the top
  // of the (now-hidden) layout viewport — out of the user's view. Use
  // VisualViewport.offsetTop to glue the header to whatever the user
  // can actually see, and `--vv-offset-top` so other fixed elements
  // can pin to it too if needed.
  const headerEl = document.querySelector("header.aa-header") || document.querySelector("header.header");
  const vv = window.visualViewport;
  if (headerEl && vv) {
    const sync = () => {
      const top = Math.max(0, Math.round(vv.offsetTop));
      headerEl.style.top = top + "px";
      document.documentElement.style.setProperty("--vv-offset-top", top + "px");
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    sync();
  }

  const emptyEl = el("assistant-empty");
  const inputEl = el("assistant-input");
  inputEl?.addEventListener("focus", () => document.body.classList.add("assistant-composer-focus"));
  inputEl?.addEventListener("blur", () => document.body.classList.remove("assistant-composer-focus"));
  const sendBtn = el("assistant-send");
  const clearBtn = el("assistant-clear");
  const subEl = el("assistant-subtitle");

  // ── Model picker (user-controlled cascade override) ──
  // Persists in localStorage. The value goes into every Gemini-client call
  // as `forceProvider` so the val knows whether to honor a single model or
  // run the default cascade. "auto" → cascade (default).
  const MODEL_PREF_KEY = "agri_ai_model_pref";
  function getModelPref() {
    try {
      const v = localStorage.getItem(MODEL_PREF_KEY);
      if (v && ["auto", "gemini", "groq", "github"].includes(v)) return v;
    } catch {}
    return "auto";
  }
  function setModelPref(v) {
    try { localStorage.setItem(MODEL_PREF_KEY, v); } catch {}
  }
  function reflectModelPref() {
    const pref = getModelPref();
    const badgeEl = document.getElementById("ai-model-badge");
    if (badgeEl) {
      badgeEl.textContent =
        pref === "auto" ? "AUTO" :
        pref === "gemini" ? "GEMINI" :
        pref === "groq" ? "GROQ" :
        pref === "github" ? "GPT-4o" : "AUTO";
    }
    document.querySelectorAll(".model-opt").forEach((b) => {
      b.classList.toggle("is-selected", b.getAttribute("data-model") === pref);
    });
  }
  reflectModelPref();
  // Toggle the popover open/closed
  const modelBtn = document.getElementById("ai-model-picker");
  const modelMenu = document.getElementById("ai-model-menu");
  const closeModelMenu = () => {
    if (!modelMenu) return;
    modelMenu.classList.add("hidden");
    modelBtn?.setAttribute("aria-expanded", "false");
    document.removeEventListener("click", onDocClickForModel, true);
  };
  function onDocClickForModel(e) {
    if (!modelMenu || !modelBtn) return;
    if (modelMenu.contains(e.target) || modelBtn.contains(e.target)) return;
    closeModelMenu();
  }
  modelBtn?.addEventListener("click", () => {
    if (!modelMenu) return;
    const isOpen = !modelMenu.classList.contains("hidden");
    if (isOpen) { closeModelMenu(); return; }
    modelMenu.classList.remove("hidden");
    modelBtn.setAttribute("aria-expanded", "true");
    setTimeout(() => document.addEventListener("click", onDocClickForModel, true), 0);
  });
  modelMenu?.querySelectorAll(".model-opt").forEach((opt) => {
    opt.addEventListener("click", () => {
      const m = opt.getAttribute("data-model") || "auto";
      setModelPref(m);
      reflectModelPref();
      closeModelMenu();
    });
  });

  // Expose pref to the assistant-side request builder
  window.__agriGetModelPref = getModelPref;

  // ── Hamburger menu (top-left): opens "Clear chat" dropdown ──
  // The actual archive logic stays in the existing clearBtn click handler
  // (further down). This menu just exposes that action via a dust-bin icon.
  const menuBtn = document.getElementById("aa-menu-btn");
  const menuPop = document.getElementById("aa-menu-popover");
  if (menuBtn && menuPop) {
    const closeMenuPop = () => {
      menuPop.classList.add("hidden");
      menuBtn.setAttribute("aria-expanded", "false");
      document.removeEventListener("click", onDocMenuClick, true);
    };
    function onDocMenuClick(e) {
      if (menuPop.contains(e.target) || menuBtn.contains(e.target)) return;
      closeMenuPop();
    }
    menuBtn.addEventListener("click", () => {
      const isOpen = !menuPop.classList.contains("hidden");
      if (isOpen) { closeMenuPop(); return; }
      // Close model menu if open
      modelMenu?.classList.add("hidden");
      modelBtn?.setAttribute("aria-expanded", "false");
      menuPop.classList.remove("hidden");
      menuBtn.setAttribute("aria-expanded", "true");
      setTimeout(() => document.addEventListener("click", onDocMenuClick, true), 0);
    });
    // After Clear chat clicked, close the popover (the click handler on
    // clearBtn already runs the archive logic in its own listener).
    document.getElementById("assistant-clear")?.addEventListener("click", () => {
      closeMenuPop();
    });
  }

  // ── Microphone (Web Speech API) ──
  // Click → start listening → transcribe into the input field. Click again
  // to stop early. Falls back silently if the browser doesn't support
  // SpeechRecognition (Firefox, some older Android Chrome).
  const micBtn = document.getElementById("aa-mic-btn");
  if (micBtn) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtn.title = "Voice input not supported in this browser";
      micBtn.style.opacity = "0.5";
      micBtn.addEventListener("click", () => {
        const inp = document.getElementById("assistant-input");
        if (inp) {
          inp.focus();
          inp.placeholder = "Type here — voice input isn't supported on this browser.";
        }
      });
    } else {
      let rec = null;
      let isListening = false;
      const stopListening = () => {
        if (rec && isListening) { try { rec.stop(); } catch {} }
        isListening = false;
        micBtn.classList.remove("recording");
      };
      micBtn.addEventListener("click", () => {
        const inp = document.getElementById("assistant-input");
        if (!inp) return;
        if (isListening) { stopListening(); return; }
        rec = new SR();
        rec.lang = (navigator.language || "en-IN");
        rec.interimResults = true;
        rec.continuous = false;
        rec.maxAlternatives = 1;
        let baseText = inp.value;
        if (baseText && !/[\s]$/.test(baseText)) baseText += " ";
        rec.onresult = (ev) => {
          let interim = "";
          let finalText = "";
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i];
            if (r.isFinal) finalText += r[0].transcript;
            else interim += r[0].transcript;
          }
          inp.value = baseText + finalText + interim;
        };
        rec.onerror = (ev) => {
          console.warn("[assistant] speech recognition error:", ev.error);
          stopListening();
        };
        rec.onend = () => { stopListening(); };
        try {
          rec.start();
          isListening = true;
          micBtn.classList.add("recording");
        } catch (e) {
          console.warn("[assistant] could not start speech recognition:", e);
          stopListening();
        }
      });
    }
  }

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
  /** User-message IDs whose assistant reply was aborted by the user sending a follow-up. */
  const supersededUserMsgIds = new Set();
  /** Tracks the user-msg ID of the currently in-flight turn so we can mark it superseded on abort. */
  let currentTurnUserMsgId = null;
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
  /** Cached `assistant_knowledge_memory` rows for this user (bounded query). */
  let knowledgeMemoryEntries = [];

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
    const railBody = el("assistant-rail-body");
    if (!hintEl) return;
    if (lastMsgCount !== 0) {
      hintEl.textContent = "";
      hintEl.classList.add("hidden");
      if (railBody) {
        railBody.textContent = "";
        railBody.classList.add("hidden");
      }
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
    if (railBody) {
      railBody.textContent = full;
      railBody.classList.toggle("hidden", !full.trim());
    }
  }

  function paintChat() {
    const hasStreamShell = !!streamingAssistant;
    if (emptyEl) emptyEl.classList.toggle("hidden", chatMessages.length > 0 || hasStreamShell);
    renderMessages(listEl, chatMessages, {
      awaitingUserMsgId: awaitingAssistantAfterUserId,
      streamingAssistant,
      supersededIds: supersededUserMsgIds,
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

  activeSubscriptions.push(
    onSnapshot(doc(db, "companion_profiles", user.uid), (snap) => {
      companionProfile = normalizeCompanionProfile(snap.data(), user.uid);
      updateCompanionEmptyHint();
    }),
  );

  activeSubscriptions.push(
    onSnapshot(doc(db, "learning_profiles", user.uid), (snap) => {
      learningProfile = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      updateCompanionEmptyHint();
    }),
  );

  const knowledgeMemQ = query(
    collection(db, "assistant_knowledge_memory"),
    where("userId", "==", user.uid),
    orderBy("lastUsedAt", "desc"),
    limit(40),
  );
  onSnapshot(
    knowledgeMemQ,
    (snap) => {
      knowledgeMemoryEntries = snap.docs.map((d) => normalizeKnowledgeMemoryDoc(d));
    },
    (err) => console.warn("[assistant] knowledge memory listener:", err?.message || err),
  );

  const attachInput = el("assistant-attach-input");
  const attachBtn = el("assistant-attach");

  if (subEl) {
    const cfg = getAiConfig();
    const dataHint = cfg.inferenceBaseUrl
      ? "vision API + your farm data"
      : "live weather + your Firestore data";
    subEl.textContent = `On-device intelligence • ${dataHint}`;
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
  activeSubscriptions.push(
    onSnapshot(msgsQ, (snap) => {
      const msgs = [];
      snap.forEach((d) => {
        const data = d.data();
        // Filter out archived messages — they live in the DB but are
        // hidden from the chat view. The AI still gets the recent
        // non-archived turns as conversational context.
        if (data && data.archivedAt) return;
        msgs.push({ id: d.id, ...data });
      });
      lastMsgCount = msgs.length;
      chatMessages = msgs;
      if (!streamInFlight) paintChat();
    }),
  );

  activeSubscriptions.push(
    onSnapshot(query(collection(db, "fields"), where("userId", "==", user.uid), limit(200)), (snap) => {
      fields = [];
      snap.forEach((d) => fields.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(500)), (snap) => {
      scans = [];
      snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "ai_recommendations"), where("userId", "==", user.uid), limit(200)), (snap) => {
      recs = [];
      snap.forEach((d) => recs.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(50)), (snap) => {
      weatherLogs = [];
      snap.forEach((d) => weatherLogs.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "environmental_data"), where("userId", "==", user.uid), limit(40)), (snap) => {
      environmental = [];
      snap.forEach((d) => environmental.push({ id: d.id, ...d.data() }));
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "field_context_state"), where("userId", "==", user.uid), limit(40)), (snap) => {
      fieldContextStates = [];
      snap.forEach((d) => fieldContextStates.push({ id: d.id, fieldId: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );

  activeSubscriptions.push(
    onSnapshot(
      query(collection(db, "farm_interventions"), where("userId", "==", user.uid), limit(120)),
      (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => tsToMs(b.performedAt) - tsToMs(a.performedAt));
        farmInterventions = rows.slice(0, 48);
        updateCompanionEmptyHint();
      },
    ),
  );

  activeSubscriptions.push(
    onSnapshot(
      query(collection(db, "farm_operational_tasks"), where("userId", "==", user.uid), limit(120)),
      (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
        farmOperationalTasks = rows.slice(0, 48);
        updateCompanionEmptyHint();
      },
    ),
  );

  activeSubscriptions.push(
    onSnapshot(
      query(collection(db, "alerts"), where("userId", "==", user.uid), limit(80)),
      (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
        assistantAlerts = rows.slice(0, 40);
        updateCompanionEmptyHint();
      },
    ),
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
    // If we're aborting a turn that was either awaiting an assistant reply or
    // actively streaming one, mark its originating user message as superseded
    // so the transcript reads coherently (no orphan unanswered question).
    if (currentTurnUserMsgId && (streamInFlight || awaitingAssistantAfterUserId)) {
      supersededUserMsgIds.add(currentTurnUserMsgId);
    }
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
      currentTurnUserMsgId = userMsgRef.id;
      paintChat();

      const routing = classifyAssistantRouting(text, { hasImage: !!imageBlob });

      let snapshot = null;
      let orch = null;
      let reply = "";
      /** @type {{ entry: any, score: number }[]} */
      let learnedMemoryHits = [];

      // ── LLM-only path ──
      // Every turn goes through the Val Town proxy → Gemini 2.5 Flash →
      // Groq Llama 3.3 70B → GitHub GPT-4o-mini cascade. No rule-based
      // composer fallback — if the cascade fails, show a short error
      // and let the user retry. The old orchestrator/engine code stays
      // in the bundle but is no longer wired into the reply path.
      orch = null;
      snapshot = null;
      if (!imageBlob) {
        try {
          const gReply = await tryGeminiReply(text, { fields, scans, weatherLogs }, chatMessages);
          if (gReply) reply = gReply;
        } catch (e) {
          console.warn("[assistant] LLM cascade failed:", e);
        }
      }

      if (!reply) {
        reply = imageBlob
          ? "I can't read images yet — describe what you see (color, spots, location on the leaf, growth stage) and I'll diagnose from text."
          : "Sorry, the AI is unreachable right now. Please try again in a few seconds.";
      }
      // (Old orchestrator + web-research + knowledge-memory persistence
      // lived here and depended on `orch` being populated by the rule-based
      // engines. They're skipped now that every reply comes from the LLM
      // cascade. The helpers (composeAssistantReply, fetchPublicAgriBrief,
      // etc.) are still imported but unused — safe to prune in a later pass.)

      const mood = detectConversationMood(text);
      const naturalMicroBeforePolish =
        ROUTING_NO_ENGINE_LOG.includes(routing.mode);
      reply = polishFarmReportProse(reply, {
        mood,
        routingMode: routing.mode,
        naturalMicro: naturalMicroBeforePolish,
      });

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

      const naturalMicro =
        routing.mode === "micro_social" ||
        routing.mode === "casual" ||
        routing.mode === "clarify" ||
        reply.trim().length < 100;
      const orchForMemory =
        orch ||
        ({
              intents: routing.mode === "operations_quick" ? { operations: true } : {},
              results: {},
              enginePackVersion:
                routing.mode === "clarify"
                  ? "clarify-turn"
                  : routing.mode === "casual"
                    ? "casual-turn"
                    : routing.mode === "micro_social"
                      ? "micro-social-turn"
                      : routing.mode === "operations_quick"
                        ? "operations-turn"
                        : "direct-turn",
            });

      // Companion memory + engine-run logging are deferred until after the
      // stream actually completes, so an aborted/never-shown reply never
      // pollutes the profile or analytics. See `commitTurnSideEffects` below.

      const commitTurnSideEffects = async () => {
        try {
          if (!naturalMicro && reply.trim().length > 96) pushRecentAssistantOpening(reply);
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

        if (!ROUTING_NO_ENGINE_LOG.includes(routing.mode)) {
          try {
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
          } catch (runErr) {
            console.warn("[assistant] engine-run log:", runErr?.message || runErr);
          }
        }
      };

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
        // Aborted/superseded — keep DOM as-is until the finally block paints,
        // and skip persistence + companion-memory writes. The reply was never
        // fully shown, so don't record it.
        return;
      }

      // Persist the assistant message FIRST so the snapshot listener has it
      // ready; then in one paint frame swap streamingAssistant off. This
      // avoids the brief flicker where stream shell disappears before the
      // persisted message arrives.
      const persistedReplyDoc = await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "assistant",
        text: reply,
        createdAt: serverTimestamp(),
        replyTo: userMsgRef.id,
        enginePackVersion:
          orch?.enginePackVersion ||
          (routing.mode === "clarify"
            ? "clarify-turn"
            : routing.mode === "casual"
              ? "casual-turn"
              : routing.mode === "micro_social"
                ? "micro-social-turn"
                : routing.mode === "operations_quick"
                  ? "operations-turn"
                  : ""),
        enginePreview: orch?.persistedPreview || null,
        routingMode: routing.mode,
        schemaVersion: 2,
      });
      // Optimistically place the persisted reply into chatMessages so the
      // upcoming paint shows it instantly without waiting for snapshot RTT.
      if (persistedReplyDoc?.id && !chatMessages.some((m) => m.id === persistedReplyDoc.id)) {
        chatMessages = [
          ...chatMessages,
          {
            id: persistedReplyDoc.id,
            userId: user.uid,
            role: "assistant",
            text: reply,
            replyTo: userMsgRef.id,
            createdAt: { toMillis: () => Date.now() },
            routingMode: routing.mode,
            schemaVersion: 2,
          },
        ].sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
      }
      streamInFlight = false;
      streamingAssistant = null;
      // Turn completed successfully — clear pointer so a later abort doesn't
      // incorrectly mark this user-msg as superseded.
      if (currentTurnUserMsgId === userMsgRef.id) currentTurnUserMsgId = null;

      // Fire-and-forget — these write to Firestore but don't block the UI.
      commitTurnSideEffects();
    } catch (e) {
      console.error("[assistant] send failed:", e);
      alert(
        "Couldn’t complete that message. Check your connection and try again. If it keeps failing, open the browser console (details for support).",
      );
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
    const ok = confirm("Archive this chat? Old messages will be hidden so you can start fresh with the AI. Nothing is deleted — the history stays in your account.");
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
      const archivedAt = serverTimestamp();
      // Soft-archive every assistant message (don't delete — preserves history)
      msgSnap.forEach((d) => {
        if (d.data().archivedAt) return; // already archived
        batch.update(doc(db, "assistant_messages", d.id), { archivedAt });
      });
      // Engine runs are dev telemetry — safe to delete on archive
      runSnap.forEach((d) => batch.delete(doc(db, "ai_engine_runs", d.id)));
      await batch.commit();
    } catch (e) {
      console.error(e);
      alert(`Failed to archive: ${e.message}`);
    }
  });
});

