import { auth, db } from "./auth.js";
import { initI18n, startI18nObserver } from "./i18n.js";
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
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

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
      const who = role === "user" ? t("assistant.you") : t("assistant.assistant_name");
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
  lines.push(t("assistant.state_summary", { f: fieldCount, s: scanCount }));

  if (q.includes("start") || q.includes("setup") || q.includes("begin")) {
    if (!fieldCount && !scanCount) {
      lines.push("");
      lines.push(t("assistant.activate_analytics"));
      lines.push(`- ${t("assistant.add_field_instr")}`);
      lines.push(`- ${t("assistant.run_scan_instr")}`);
      lines.push(`- ${t("assistant.enable_loc_instr")}`);
      return lines.join("\n");
    }
  }

  if (q.includes("latest") || q.includes("last scan") || q.includes("scan")) {
    if (!latestScan) {
      lines.push("");
      lines.push(t("assistant.no_scans_yet"));
      return lines.join("\n");
    }
    const health = typeof latestScan.healthScore === "number" ? `${Math.round(latestScan.healthScore)}%` : "--";
    const diag = latestScan.diagnosis?.label || "Scan saved";
    lines.push("");
    lines.push(t("assistant.latest_scan_msg", { crop: latestScan.cropType || "Crop", diag, health }));
    if (latestScan.recommendations && latestScan.recommendations.length) {
      lines.push(t("assistant.top_actions"));
      for (const r of latestScan.recommendations.slice(0, 3)) lines.push(`- ${r.text}`);
    }
    return lines.join("\n");
  }

  if (q.includes("recommend") || q.includes("insight") || q.includes("next action")) {
    const active = recs.filter((r) => (r.status || "active") === "active");
    if (!active.length) {
      lines.push("");
      lines.push(t("assistant.no_recommendations"));
      return lines.join("\n");
    }
    active.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    lines.push("");
    lines.push(t("assistant.top_actions"));
    for (const r of active.slice(0, 5)) lines.push(`- ${r.text}`);
    return lines.join("\n");
  }

  if (q.includes("weather") || q.includes("rain") || q.includes("humidity")) {
    if (!latestWeather) {
      lines.push("");
      lines.push(t("assistant.no_weather"));
      return lines.join("\n");
    }
    const c = latestWeather.city || "your area";
    const cur = latestWeather.current || {};
    const temp = typeof cur.temperature_2m === "number" ? Math.round(cur.temperature_2m) : "--";
    const moist = latestWeather.derived?.soilMoistureEstimate || "--";
    lines.push("");
    lines.push(t("assistant.latest_weather", { temp, desc: latestWeather.derived?.conditionLabel || "Clear", moist }));
    return lines.join("\n");
  }

  if (q.includes("field")) {
    if (!fieldCount) {
      lines.push("");
      lines.push(t("assistant.add_field_instr"));
      return lines.join("\n");
    }
    lines.push("");
    lines.push(t("assistant.field_overview"));
    for (const f of fields.slice(0, 5)) lines.push(`- ${f.name || t("field_detail.overview")}${f.cropType ? ` (${f.cropType})` : ""}`);
    if (fieldCount > 5) lines.push(`- …and ${fieldCount - 5} more`);
    return lines.join("\n");
  }

  // Default: safe, minimal guidance without pretending.
  lines.push(t("assistant.default_reply"));
  return lines.join("\n");
}

onAuthStateChanged(auth, async (user) => {
  await initI18n();
  startI18nObserver();

  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const listEl = el("assistant-messages");
  const emptyEl = el("assistant-empty");
  const inputEl = el("assistant-input");
  const sendBtn = el("assistant-send");
  const clearBtn = el("assistant-clear");

  let fields = [];
  let scans = [];
  let recs = [];
  let weatherLogs = [];

  const msgsQ = query(collection(db, "assistant_messages"), where("userId", "==", user.uid), limit(200));
  onSnapshot(msgsQ, (snap) => {
    const msgs = [];
    snap.forEach((d) => msgs.push({ id: d.id, ...d.data() }));
    if (emptyEl) emptyEl.classList.toggle("hidden", msgs.length > 0);
    renderMessages(listEl, msgs);
  });

  onSnapshot(query(collection(db, "fields"), where("userId", "==", user.uid), limit(200)), (snap) => {
    fields = [];
    snap.forEach((d) => fields.push({ id: d.id, ...d.data() }));
  });
  onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(500)), (snap) => {
    scans = [];
    snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
  });
  onSnapshot(query(collection(db, "ai_recommendations"), where("userId", "==", user.uid), limit(200)), (snap) => {
    recs = [];
    snap.forEach((d) => recs.push({ id: d.id, ...d.data() }));
  });
  onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(50)), (snap) => {
    weatherLogs = [];
    snap.forEach((d) => weatherLogs.push({ id: d.id, ...d.data() }));
  });

  async function send() {
    const text = (inputEl?.value || "").trim();
    if (!text) return;

    if (sendBtn) sendBtn.disabled = true;
    if (inputEl) inputEl.value = "";

    try {
      const userMsgRef = await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "user",
        text,
        createdAt: serverTimestamp(),
        schemaVersion: 1,
      });

      const reply = buildAssistantReply({ question: text, fields, scans, recs, weatherLogs });
      await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "assistant",
        text: reply,
        createdAt: serverTimestamp(),
        replyTo: userMsgRef.id,
        schemaVersion: 1,
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
    const ok = confirm("Clear assistant chat history for this device/account?");
    if (!ok) return;
    try {
      const snap = await getDocs(msgsQ);
      const batch = writeBatch(db);
      snap.forEach((d) => batch.delete(doc(db, "assistant_messages", d.id)));
      await batch.commit();
    } catch (e) {
      console.error(e);
      alert(`Failed to clear: ${e.message}`);
    }
  });
});

