/**
 * Central config for the agricultural AI ecosystem.
 * Gemini chat defaults to the Firebase Cloud Function deployed for this project
 * unless you override with meta / window globals (or agri-ai-base for a custom FastAPI host).
 */

/** Default HTTPS Cloud Function — same contract as POST /v1/chat/grounded on FastAPI. */
const DEFAULT_CLOUD_GEMINI_URL =
    "https://us-central1-agritech-4d1ba.cloudfunctions.net/agriGeminiChat";

function readMeta(name) {
    const el = typeof document !== "undefined" ? document.querySelector(`meta[name="${name}"]`) : null;
    return el ? String(el.getAttribute("content") || "").trim() : "";
}

/** @returns {{ inferenceBaseUrl: string, llmProxyUrl: string, imdApiBaseUrl: string, enginePackVersion: string }} */
export function getAiConfig() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const aiBase = String(g.__AGRI_AI_BASE__ || readMeta("agri-ai-base") || "").replace(/\/$/, "");
    const inferExplicit = String(g.__AGRI_INFERENCE_URL__ || readMeta("agri-inference-url") || "").replace(/\/$/, "");
    const llmExplicit = String(g.__AGRI_LLM_PROXY__ || readMeta("agri-llm-proxy") || "").replace(/\/$/, "");
    const llmFallback = String(g.__AGRI_LLM_CLOUD_FN__ || readMeta("agri-llm-cloud-fn") || "").replace(/\/$/, "");
    const llmDefault = DEFAULT_CLOUD_GEMINI_URL.replace(/\/$/, "");
    return {
        inferenceBaseUrl: inferExplicit || aiBase,
        llmProxyUrl: llmExplicit || aiBase || llmFallback || llmDefault,
        imdApiBaseUrl: String(g.__AGRI_IMD_API__ || readMeta("agri-imd-api") || "").replace(/\/$/, ""),
        enginePackVersion: "ecosystem-2026-05-reliability-v1",
    };
}

export function isInferenceConfigured() {
    return !!getAiConfig().inferenceBaseUrl;
}

export function isLlmProxyConfigured() {
    return !!getAiConfig().llmProxyUrl;
}
