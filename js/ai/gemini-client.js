// Local-server chat client — calls POST /v1/chat on the self-hosted FastAPI server.
// No Val Town, no external proxy. The Gemini API key lives in server/.env only.
//
// Interface is identical to the old Val Town version so assistant.js needs no changes:
//   tryGeminiReply(question, snapshot, chatMessages) → Promise<string|null>

import { getAiConfig } from "./config.js?v=71";

const REQUEST_TIMEOUT_MS = 12000;

/**
 * @param {string} question
 * @param {object} snapshot — orchestrator snapshot (fields, scans, weatherLogs)
 * @param {Array<{senderRole?:string, role?:string, text?:string}>} chatMessages
 * @returns {Promise<string|null>}
 */
export async function tryGeminiReply(question, snapshot, chatMessages) {
  const q = String(question || "").trim();
  if (!q) return null;

  const { inferenceBaseUrl } = getAiConfig();
  if (!inferenceBaseUrl) {
    console.warn("[chat] inferenceBaseUrl not configured — skipping LLM call");
    return null;
  }

  const farmContext = _buildFarmContext(snapshot);
  const history     = _buildHistory(chatMessages);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${inferenceBaseUrl}/v1/chat`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ question: q, farmContext, history }),
      signal:  ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.warn("[chat] server returned", res.status);
      return null;
    }
    const data  = await res.json();
    const reply = typeof data?.reply === "string" ? data.reply.trim() : "";
    return reply || null;
  } catch (e) {
    clearTimeout(t);
    console.warn("[chat] call failed:", e?.message || e);
    return null;
  }
}

function _buildFarmContext(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const out = {};

  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : [];
  if (fields.length) {
    out.fields = fields.slice(0, 6).map((f) => ({
      name:        f?.name        || null,
      cropType:    f?.cropType    || null,
      cropVariety: f?.cropVariety || null,
      areaAcres:   typeof f?.areaAcres === "number" ? Number(f.areaAcres.toFixed(2)) : null,
    }));
  }

  const scans = Array.isArray(snapshot.scans) ? snapshot.scans : [];
  if (scans.length) {
    const s = scans[0];
    out.latestScan = {
      healthScore:      typeof s?.healthScore === "number" ? Math.round(s.healthScore) : null,
      diagnosis:        s?.diagnosis || null,
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
      tempC:          _pickNum(c?.temperature_2m, c?.temperature, c?.tempC, w?.tempC),
      rhPct:          _pickNum(c?.relative_humidity_2m, c?.humidity, c?.rhPct, w?.rhPct),
      city:           w.city || w.location?.city || null,
      rainTomorrowMm: _pickNum(w?.derived?.rainTomorrowMm, w?.rainTomorrowMm),
    };
  }

  if (snapshot.location?.city) out.location = { city: snapshot.location.city };
  return Object.keys(out).length ? out : null;
}

function _pickNum(...vals) {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return null;
}

function _buildHistory(chatMessages) {
  if (!Array.isArray(chatMessages)) return [];
  const out = [];
  for (const m of chatMessages.slice(-10)) {
    const text = typeof m?.text === "string" ? m.text.trim() : "";
    if (!text) continue;
    const senderRole = m.senderRole || m.role || (m.from === "user" ? "user" : "assistant");
    out.push({ role: senderRole === "user" ? "user" : "assistant", text: text.slice(0, 2000) });
  }
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out.slice(-8);
}
