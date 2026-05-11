/**
 * Central config for the agricultural AI ecosystem.
 * Conversational assistant: fully client-orchestrated — no external LLM / chat-API calls.
 * Optional: inferenceBaseUrl for self-hosted YOLO / disease vision only.
 */

/** Default backend when running `uvicorn` locally (vision + tools). */
const DEFAULT_LOCAL_AI_BASE = "http://127.0.0.1:8000";

function readMeta(name) {
    const el = typeof document !== "undefined" ? document.querySelector(`meta[name="${name}"]`) : null;
    return el ? String(el.getAttribute("content") || "").trim() : "";
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(String(s || "").trim());
}

/** @returns {{ inferenceBaseUrl: string, imdApiBaseUrl: string, enginePackVersion: string }} */
export function getAiConfig() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const aiBase = String(g.__AGRI_AI_BASE__ || readMeta("agri-ai-base") || "").replace(/\/$/, "");
    const inferExplicit = String(g.__AGRI_INFERENCE_URL__ || readMeta("agri-inference-url") || "").replace(/\/$/, "");
    const local = DEFAULT_LOCAL_AI_BASE.replace(/\/$/, "");

    return {
        inferenceBaseUrl: inferExplicit || aiBase || local,
        imdApiBaseUrl: String(g.__AGRI_IMD_API__ || readMeta("agri-imd-api") || "").replace(/\/$/, ""),
        enginePackVersion: "ecosystem-2026-05-reliability-v1",
    };
}

export function isInferenceConfigured() {
    return !!getAiConfig().inferenceBaseUrl;
}
