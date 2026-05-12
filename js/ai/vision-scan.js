// AI vision client — sends a captured crop photo to the Val Town proxy and
// gets back a structured Gemini-vision diagnosis. Used by the Scan Field
// page after capture/upload so the result card auto-fills with a real
// AI-driven verdict instead of waiting for manual symptom entry.
//
// Wire path:
//   blob → resized JPEG (≤1024px, ≤0.85 quality) → base64
//        → POST /val.run { image, farmContext, question }
//        → Gemini 2.5 Flash multimodal with vision system prompt
//        → JSON { diseaseName, scientificName, riskLevel, confidence, summary, recommendations }
//        → parsed object the scanner UI can render directly.

// Vision-aware val (multimodal Gemini + structured JSON output). Distinct
// from the chat val used by js/ai/gemini-client.js — that one continues to
// run the text-only cascade.
const VISION_PROXY_URL =
  "https://harshwardhanparganiha--2d3f804c4d5911f1b7baee650bb23af1.web.val.run";

const REQUEST_TIMEOUT_MS = 30000;
const MAX_DIM = 1024;
const JPEG_QUALITY = 0.85;

/**
 * Resize a Blob/File to a JPEG capped at MAX_DIM on the longest side.
 * Keeps the payload small enough for fast Gemini calls and predictable
 * costs even on big phone-camera photos.
 *
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
async function resizeImageBlob(blob) {
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return blob; // fall back: send original
  const { width, height } = bmp;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b || blob), "image/jpeg", JPEG_QUALITY);
  });
}

/**
 * Convert a Blob to base64 (without the data: prefix).
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const result = String(fr.result || "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    fr.onerror = () => reject(fr.error || new Error("FileReader failed"));
    fr.readAsDataURL(blob);
  });
}

/**
 * Attempt to extract a JSON object from a model reply. Gemini sometimes
 * wraps JSON in ```json fences or adds a stray sentence even when asked
 * not to, so we strip those defensively.
 *
 * @param {string} text
 * @returns {object|null}
 */
function extractJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();
  // Strip ```json … ``` or ``` … ``` fences if present
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) s = fenceMatch[1].trim();
  // Find the first { and last } (handles stray prose around the JSON)
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  const candidate = s.slice(first, last + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    // Try once more after very loose cleanup (trailing commas, smart quotes)
    const cleaned = candidate
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(cleaned); } catch { return null; }
  }
}

/**
 * Normalize the parsed Gemini response into the shape the scanner UI
 * expects. Defensive defaults so any missing field falls back to a
 * reasonable value instead of NaN / undefined.
 *
 * @param {object} obj
 * @returns {{
 *   diseaseName: string,
 *   scientificName: string,
 *   riskLevel: 'low'|'medium'|'high'|'healthy',
 *   confidence: number,
 *   summary: string,
 *   recommendations: string[],
 * }}
 */
function normalizeDiagnosis(obj) {
  const out = {
    diseaseName: "Unknown",
    scientificName: "",
    riskLevel: "medium",
    confidence: 60,
    summary: "",
    recommendations: [],
  };
  if (!obj || typeof obj !== "object") return out;
  if (typeof obj.diseaseName === "string" && obj.diseaseName.trim()) out.diseaseName = obj.diseaseName.trim();
  if (typeof obj.scientificName === "string") out.scientificName = obj.scientificName.trim();
  const lvl = String(obj.riskLevel || "").toLowerCase();
  if (["low", "medium", "high", "healthy"].includes(lvl)) out.riskLevel = lvl;
  const c = Number(obj.confidence);
  if (Number.isFinite(c)) out.confidence = Math.max(0, Math.min(100, Math.round(c)));
  if (typeof obj.summary === "string") out.summary = obj.summary.trim();
  if (Array.isArray(obj.recommendations)) {
    out.recommendations = obj.recommendations
      .filter((r) => typeof r === "string" && r.trim())
      .map((r) => r.trim())
      .slice(0, 6);
  }
  return out;
}

/**
 * Run AI vision analysis on a crop photo.
 *
 * @param {Blob|File} blob — the raw photo from camera capture or file upload
 * @param {object} [opts]
 * @param {object} [opts.farmContext] — optional snapshot for the AI to reference
 * @param {string} [opts.cropType] — user-selected crop type (sharpens the prompt)
 * @param {string[]} [opts.observedSymptoms] — user-reported symptom labels
 * @returns {Promise<{
 *   ok: true,
 *   diagnosis: ReturnType<typeof normalizeDiagnosis>,
 *   raw: string,
 *   provider: string,
 *   model: string,
 *   tokens: { prompt?: number, completion?: number },
 * } | { ok: false, error: string, status?: number, raw?: string }>}
 */
export async function runAiVisionScan(blob, opts = {}) {
  if (!blob) return { ok: false, error: "no_image" };

  let imageBlob;
  try {
    imageBlob = await resizeImageBlob(blob);
  } catch (e) {
    return { ok: false, error: "resize_failed: " + (e?.message || e) };
  }

  let base64;
  try {
    base64 = await blobToBase64(imageBlob);
  } catch (e) {
    return { ok: false, error: "encode_failed: " + (e?.message || e) };
  }

  // Build the question text. Including crop type + any user-flagged
  // symptoms helps Gemini disambiguate edge cases (e.g. yellowing in
  // wheat vs tomato is very different).
  const hints = [];
  if (opts.cropType) hints.push("Crop: " + opts.cropType);
  if (Array.isArray(opts.observedSymptoms) && opts.observedSymptoms.length) {
    hints.push("User-reported symptoms: " + opts.observedSymptoms.join(", "));
  }
  const question = hints.length
    ? "Diagnose this crop photo as JSON per the spec. " + hints.join(". ") + "."
    : "Diagnose this crop photo as JSON per the spec.";

  const payload = {
    question,
    farmContext: opts.farmContext || null,
    image: { mimeType: "image/jpeg", data: base64 },
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(VISION_PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    return { ok: false, error: "network: " + (e?.message || e) };
  } finally { clearTimeout(t); }

  if (!res.ok) {
    let body = "";
    try { body = await res.text(); } catch {}
    return { ok: false, error: "upstream_status_" + res.status, status: res.status, raw: body.slice(0, 400) };
  }

  let data;
  try { data = await res.json(); }
  catch (e) { return { ok: false, error: "bad_response_json" }; }

  if (data && data.error) {
    return { ok: false, error: data.error, raw: JSON.stringify(data).slice(0, 400) };
  }

  const replyText = typeof data?.reply === "string" ? data.reply : "";
  const parsed = extractJsonObject(replyText);
  if (!parsed) {
    // Fall through: still surface the raw text so the UI can show something.
    return {
      ok: false,
      error: "could_not_parse_json",
      raw: replyText.slice(0, 600),
    };
  }
  const diagnosis = normalizeDiagnosis(parsed);

  return {
    ok: true,
    diagnosis,
    raw: replyText,
    provider: data.provider || "gemini-vision",
    model: data.model || "gemini-2.5-flash",
    tokens: {
      prompt: data.promptTokens,
      completion: data.completionTokens,
    },
  };
}
