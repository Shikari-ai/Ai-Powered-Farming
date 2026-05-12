// AI vision client — sends a captured crop photo to the Val Town proxy and
// gets back a structured Gemini-vision diagnosis.
//
// Wire path:
//   blob → resized JPEG (≤1280px, ≤0.92 quality) → base64
//        → POST /val.run { image, farmContext, question }
//        → Gemini 2.5 Flash multimodal
//        → JSON diagnosis object
//        → parsed + normalised for the scanner UI

const VISION_PROXY_URL =
  "https://harshwardhanparganiha--2d3f804c4d5911f1b7baee650bb23af1.web.val.run";

const REQUEST_TIMEOUT_MS = 35000;
const MAX_DIM = 1280;   // higher than before → more visual detail preserved
const JPEG_QUALITY = 0.92; // less compression → sharper symptom textures

async function resizeImageBlob(blob) {
  const bmp = await createImageBitmap(blob).catch(() => null);
  if (!bmp) return blob;
  const { width, height } = bmp;
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  return await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b || blob), "image/jpeg", JPEG_QUALITY);
  });
}

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

function extractJsonObject(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fenceMatch = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) s = fenceMatch[1].trim();
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first < 0 || last < first) return null;
  const candidate = s.slice(first, last + 1);
  try { return JSON.parse(candidate); }
  catch {
    const cleaned = candidate
      .replace(/[""]/g, '"').replace(/['']/g, "'")
      .replace(/,\s*([}\]])/g, "$1");
    try { return JSON.parse(cleaned); } catch { return null; }
  }
}

function normalizeDiagnosis(obj) {
  const out = {
    diseaseName: "Unknown",
    scientificName: "",
    riskLevel: "medium",
    confidence: 60,
    summary: "",
    recommendations: [],
    plantType: "",
    partOfPlant: "",
    narrative: "",
    treatments: [],
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
      .map((r) => r.trim()).slice(0, 6);
  }
  if (typeof obj.plantType === "string") out.plantType = obj.plantType.trim();
  if (typeof obj.partOfPlant === "string") out.partOfPlant = obj.partOfPlant.trim().toLowerCase();
  if (typeof obj.narrative === "string") out.narrative = obj.narrative.trim();
  if (Array.isArray(obj.treatments)) {
    out.treatments = obj.treatments
      .filter((t) => t && typeof t === "object" && t.name)
      .map((t) => ({
        type: String(t.type || "general").toLowerCase(),
        name: String(t.name || "").trim(),
        usage: String(t.usage || "").trim(),
      })).slice(0, 5);
  }
  if (!out.narrative) {
    const lead = "It looks like";
    const subject = out.plantType || (out.partOfPlant ? `a ${out.partOfPlant}` : "a plant");
    if (out.riskLevel === "healthy") {
      out.narrative = `${lead} ${subject} that appears healthy. ${out.summary || "No visible disease signs."}`.trim();
    } else if (out.diseaseName && out.diseaseName !== "Unknown") {
      const sci = out.scientificName ? ` (${out.scientificName})` : "";
      out.narrative = `${lead} ${subject} showing ${out.diseaseName.toLowerCase()}${sci}. ${out.summary || ""}`.trim();
    } else {
      out.narrative = `${lead} ${subject}. ${out.summary || "Unable to identify a specific issue from the image."}`.trim();
    }
  }
  return out;
}

// Builds the question sent to the vision val. The val has its own system
// prompt that sets the model role; we just specify the JSON output schema
// and any crop/symptom context. Kept to a single logical line so it works
// identically across Gemini, GPT-4o-mini, and Llama vision models.
function buildQuestion(opts) {
  const hints = [];
  if (opts.cropType) hints.push(`Crop: ${opts.cropType}`);
  if (Array.isArray(opts.observedSymptoms) && opts.observedSymptoms.length) {
    hints.push(`Observed symptoms: ${opts.observedSymptoms.join(", ")}`);
  }
  const ctx = hints.length ? ` ${hints.join(". ")}.` : "";
  return (
    `Diagnose this crop photo and return ONLY valid JSON — no prose, no fences.${ctx} ` +
    `Schema: {"diseaseName":"exact disease or Healthy","scientificName":"latin name or empty",` +
    `"riskLevel":"healthy|low|medium|high","confidence":0,"summary":"2-3 sentences on visible symptoms",` +
    `"recommendations":["field action 1","up to 5 total"],` +
    `"plantType":"e.g. Tomato leaf","partOfPlant":"leaf|fruit|stem|whole plant|root|seed",` +
    `"narrative":"It looks like ... (name the plant, describe symptoms, give verdict in 2-3 sentences)",` +
    `"treatments":[{"type":"chemical|fertilizer|organic|general","name":"exact product e.g. Mancozeb 75% WP","usage":"dose and timing"}]} ` +
    `Set treatments to [] if healthy. Replace 0 in confidence with actual integer 0-100.`
  );
}

export async function runAiVisionScan(blob, opts = {}) {
  if (!blob) return { ok: false, error: "no_image" };

  let imageBlob;
  try { imageBlob = await resizeImageBlob(blob); }
  catch (e) { return { ok: false, error: "resize_failed: " + (e?.message || e) }; }

  let base64;
  try { base64 = await blobToBase64(imageBlob); }
  catch (e) { return { ok: false, error: "encode_failed: " + (e?.message || e) }; }

  const question = buildQuestion(opts);
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
    if (/\b429\b|quota|rate.?limit|exhausted/i.test(body)) {
      return { ok: false, error: "rate_limited", status: res.status, raw: body.slice(0, 400) };
    }
    return { ok: false, error: "upstream_status_" + res.status, status: res.status, raw: body.slice(0, 400) };
  }

  let data;
  try { data = await res.json(); }
  catch (e) { return { ok: false, error: "bad_response_json" }; }

  if (data && data.error) {
    const errStr = JSON.stringify(data);
    if (/\b429\b|quota|rate.?limit|exhausted/i.test(errStr)) {
      return { ok: false, error: "rate_limited", raw: errStr.slice(0, 400) };
    }
    return { ok: false, error: data.error, raw: errStr.slice(0, 400) };
  }

  const replyText = typeof data?.reply === "string" ? data.reply : "";
  const parsed = extractJsonObject(replyText);
  if (!parsed) {
    return { ok: false, error: "could_not_parse_json", raw: replyText.slice(0, 600) };
  }
  const diagnosis = normalizeDiagnosis(parsed);

  return {
    ok: true,
    diagnosis,
    raw: replyText,
    provider: data.provider || "gemini-vision",
    model: data.model || "gemini-2.5-flash",
    tokens: { prompt: data.promptTokens, completion: data.completionTokens },
  };
}
