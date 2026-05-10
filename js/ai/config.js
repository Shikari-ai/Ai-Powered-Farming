/**
 * Central config for the agricultural AI ecosystem.
 * LLM: always via HTTPS backend — Firebase Cloud Function `agriGeminiChat` (default), FastAPI
 * `/v1/chat/grounded`, or override with meta / window (see getAiConfig).
 */

/** Default backend when running `uvicorn` locally (see server/.env for GEMINI_API_KEY). */
const DEFAULT_LOCAL_AI_BASE = "http://127.0.0.1:8000";

/**
 * Default production Gemini endpoint. Key lives in Secret Manager (`firebase functions:secrets:set GEMINI_API_KEY`).
 * Override per page: <meta name="agri-llm-proxy" content="https://..."> or window.__AGRI_LLM_PROXY__.
 */
const DEFAULT_FIREBASE_LLM_PROXY = "https://us-central1-agritech-4d1ba.cloudfunctions.net/agriGeminiChat";

function readMeta(name) {
    const el = typeof document !== "undefined" ? document.querySelector(`meta[name="${name}"]`) : null;
    return el ? String(el.getAttribute("content") || "").trim() : "";
}

function isHttpUrl(s) {
    return /^https?:\/\//i.test(String(s || "").trim());
}

/**
 * Full URL for POST grounded chat.
 * Cloud Function: use function URL as-is. FastAPI/other: base URL gets /v1/chat/grounded appended.
 */
export function resolveLlmProxyHttpUrl(llmProxyUrl) {
    const raw = String(llmProxyUrl || "").replace(/\/$/, "");
    if (!raw) return "";
    if (/\.cloudfunctions\.net\/.+/i.test(raw)) return raw;
    if (/\/v1\/chat\/grounded\/?$/i.test(raw)) return raw;
    return `${raw}/v1/chat/grounded`;
}

/** @returns {{ inferenceBaseUrl: string, llmProxyUrl: string, imdApiBaseUrl: string, enginePackVersion: string }} */
export function getAiConfig() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const aiBase = String(g.__AGRI_AI_BASE__ || readMeta("agri-ai-base") || "").replace(/\/$/, "");
    const inferExplicit = String(g.__AGRI_INFERENCE_URL__ || readMeta("agri-inference-url") || "").replace(/\/$/, "");
    const llmExplicit = String(g.__AGRI_LLM_PROXY__ || readMeta("agri-llm-proxy") || "").replace(/\/$/, "");
    const llmFallback = String(g.__AGRI_LLM_CLOUD_FN__ || readMeta("agri-llm-cloud-fn") || "").replace(/\/$/, "");
    const local = DEFAULT_LOCAL_AI_BASE.replace(/\/$/, "");

    let llmProxyUrl = "";
    if (isHttpUrl(llmExplicit)) {
        llmProxyUrl = llmExplicit;
    } else if (isHttpUrl(llmFallback)) {
        llmProxyUrl = llmFallback;
    } else if (isHttpUrl(aiBase)) {
        llmProxyUrl = aiBase;
    } else {
        llmProxyUrl = DEFAULT_FIREBASE_LLM_PROXY;
    }

    return {
        inferenceBaseUrl: inferExplicit || aiBase || local,
        llmProxyUrl,
        imdApiBaseUrl: String(g.__AGRI_IMD_API__ || readMeta("agri-imd-api") || "").replace(/\/$/, ""),
        enginePackVersion: "ecosystem-2026-05-reliability-v1",
    };
}

export function isInferenceConfigured() {
    return !!getAiConfig().inferenceBaseUrl;
}

export function isLlmProxyConfigured() {
    return !!resolveLlmProxyHttpUrl(getAiConfig().llmProxyUrl);
}
