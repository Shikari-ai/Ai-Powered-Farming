/**
 * Central config for the agricultural AI ecosystem.
 * Never embed production API secrets in static files — use a same-origin proxy / Cloud Functions.
 */

function readMeta(name) {
    const el = typeof document !== "undefined" ? document.querySelector(`meta[name="${name}"]`) : null;
    return el ? String(el.getAttribute("content") || "").trim() : "";
}

/** @returns {{ inferenceBaseUrl: string, llmProxyUrl: string, imdApiBaseUrl: string, enginePackVersion: string }} */
export function getAiConfig() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    return {
        inferenceBaseUrl: String(g.__AGRI_INFERENCE_URL__ || readMeta("agri-inference-url") || "").replace(/\/$/, ""),
        llmProxyUrl: String(g.__AGRI_LLM_PROXY__ || readMeta("agri-llm-proxy") || "").replace(/\/$/, ""),
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
