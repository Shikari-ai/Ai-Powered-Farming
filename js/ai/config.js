/**
 * Central config for the agricultural AI ecosystem.
 * Default: local FastAPI (`server/main.py`) exposes POST /v1/chat/grounded with GEMINI_API_KEY from server/.env.
 * Override with meta `agri-ai-base` / `agri-llm-proxy` or a Cloud Function URL when you deploy without the Python API.
 */

/** Default backend when running `uvicorn` locally (see server/.env for GEMINI_API_KEY). */
const DEFAULT_LOCAL_AI_BASE = "http://127.0.0.1:8000";

function readMeta(name) {
    const el = typeof document !== "undefined" ? document.querySelector(`meta[name="${name}"]`) : null;
    return el ? String(el.getAttribute("content") || "").trim() : "";
}

/**
 * Google AI Studio key for browser-direct Gemini (`agri-llm-proxy` = "direct").
 * Prefer localStorage or window global — avoid shipping keys in static HTML.
 */
export function getGeminiDirectApiKey() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const fromGlobal = String(g.__AGRI_GEMINI_API_KEY__ || "").trim();
    if (fromGlobal) return fromGlobal;
    const fromMeta = readMeta("agri-gemini-api-key");
    if (fromMeta) return fromMeta;
    try {
        if (typeof localStorage !== "undefined") {
            const v = localStorage.getItem("agri_gemini_api_key");
            if (v && String(v).trim()) return String(v).trim();
        }
    } catch {
        /* private mode */
    }
    return "";
}

function isDirectLlmMode(url) {
    return String(url || "").trim().toLowerCase() === "direct";
}

/** @returns {{ inferenceBaseUrl: string, llmProxyUrl: string, imdApiBaseUrl: string, enginePackVersion: string, geminiDirectModel: string }} */
export function getAiConfig() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const aiBase = String(g.__AGRI_AI_BASE__ || readMeta("agri-ai-base") || "").replace(/\/$/, "");
    const inferExplicit = String(g.__AGRI_INFERENCE_URL__ || readMeta("agri-inference-url") || "").replace(/\/$/, "");
    const llmExplicit = String(g.__AGRI_LLM_PROXY__ || readMeta("agri-llm-proxy") || "").replace(/\/$/, "");
    const llmFallback = String(g.__AGRI_LLM_CLOUD_FN__ || readMeta("agri-llm-cloud-fn") || "").replace(/\/$/, "");
    const local = DEFAULT_LOCAL_AI_BASE.replace(/\/$/, "");
    const llmDefault = local;
    const geminiDirectModel = String(readMeta("agri-gemini-model") || "gemini-1.5-flash").trim() || "gemini-1.5-flash";
    return {
        inferenceBaseUrl: inferExplicit || aiBase || local,
        llmProxyUrl: llmExplicit || aiBase || llmFallback || llmDefault,
        imdApiBaseUrl: String(g.__AGRI_IMD_API__ || readMeta("agri-imd-api") || "").replace(/\/$/, ""),
        enginePackVersion: "ecosystem-2026-05-reliability-v1",
        geminiDirectModel,
    };
}

export function isInferenceConfigured() {
    return !!getAiConfig().inferenceBaseUrl;
}

export function isLlmProxyConfigured() {
    const cfg = getAiConfig();
    if (isDirectLlmMode(cfg.llmProxyUrl)) return !!getGeminiDirectApiKey();
    return !!cfg.llmProxyUrl;
}
