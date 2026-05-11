// Gemini proxy client — talks to a Val Town HTTP val that holds the API key
// and forwards to Google's Gemini API. Returns the reply text or null on any
// failure (caller falls back to the rule-based composer).
//
// Endpoint must accept POST with { question, farmContext, history } and return
// { reply, finishReason, model, promptTokens, completionTokens }.

const GEMINI_PROXY_URL =
  "https://harshwardhanparganiha--992de5aa4d5911f1849eee650bb23af1.web.val.run";

const REQUEST_TIMEOUT_MS = 25000;

/**
 * @param {string} question
 * @param {object} snapshot — orchestrator snapshot (fields, scans, weatherLogs)
 * @param {Array<{senderRole?:string, role?:string, text?:string}>} chatMessages — last few turns
 * @returns {Promise<string|null>}
 */
export async function tryGeminiReply(question, snapshot, chatMessages) {
  const q = String(question || "").trim();
  if (!q) return null;

  const farmContext = buildFarmContext(snapshot);
  const history = buildHistory(chatMessages);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(GEMINI_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q, farmContext, history }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn("[gemini] proxy returned", res.status);
      return null;
    }
    const data = await res.json();
    const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
    if (!reply) return null;
    return reply;
  } catch (e) {
    clearTimeout(t);
    console.warn("[gemini] proxy call failed:", e?.message || e);
    return null;
  }
}

function buildFarmContext(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const out = {};

  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  if (fields.length) {
    out.fields = fields.slice(0, 6).map((f) => ({
      name: f?.name || null,
      cropType: f?.cropType || null,
      cropVariety: f?.cropVariety || null,
      areaAcres: typeof f?.areaAcres === "number" ? Number(f.areaAcres.toFixed(2)) : null,
    }));
  }

  const scans = Array.isArray(snapshot.scans) ? snapshot.scans : [];
  if (scans.length) {
    const s = scans[0];
    out.latestScan = {
      healthScore: typeof s?.healthScore === "number" ? Math.round(s.healthScore) : null,
      diagnosis: s?.diagnosis || null,
      observedSymptoms: Array.isArray(s?.observedSymptoms)
        ? s.observedSymptoms.slice(0, 5)
        : Array.isArray(s?.selectedSymptoms)
          ? s.selectedSymptoms.slice(0, 5)
          : [],
    };
  }

  const w = Array.isArray(snapshot.weatherLogs) ? snapshot.weatherLogs[0] : null;
  if (w) {
    const c = w.current || w;
    out.weather = {
      tempC: pickNum(c?.temperature_2m, c?.temperature, c?.tempC, w?.tempC),
      rhPct: pickNum(c?.relative_humidity_2m, c?.humidity, c?.rhPct, w?.rhPct),
      city: w.city || w.location?.city || null,
      rainTomorrowMm: pickNum(w?.derived?.rainTomorrowMm, w?.rainTomorrowMm),
    };
  }

  if (snapshot.location?.city) {
    out.location = { city: snapshot.location.city };
  }

  return Object.keys(out).length ? out : null;
}

function pickNum(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function buildHistory(chatMessages) {
  if (!Array.isArray(chatMessages)) return [];
  const out = [];
  // Take the last 8 messages, oldest first. Skip empty / image-only entries.
  const slice = chatMessages.slice(-10);
  for (const m of slice) {
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    if (!text) continue;
    const senderRole = m.senderRole || m.role || (m.from === "user" ? "user" : "assistant");
    const role = senderRole === "user" ? "user" : "assistant";
    out.push({ role, text: text.slice(0, 2000) });
  }
  // Drop the last user turn — caller will append `question` as the new user turn.
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out.slice(-8);
}
