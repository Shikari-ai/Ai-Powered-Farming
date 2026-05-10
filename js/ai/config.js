/**
 * Central config for the agricultural AI ecosystem.
 * LLM: local FastAPI by default, or one shared browser-direct Gemini key (see AGRI_SHARED_GEMINI_KEY /
 * meta agri-public-gemini-key). Optional HTTP override: meta agri-llm-proxy with an https URL.
 */

/** Default backend when running `uvicorn` locally (see server/.env for GEMINI_API_KEY). */
const DEFAULT_LOCAL_AI_BASE = "http://127.0.0.1:8000";

/**
 * Shared Gemini key for static hosting (visible to anyone). Restrict usage in Google AI Studio
 * (HTTP referrer) to your real site origins; rotate if abused.
 */
const AGRI_SHARED_GEMINI_KEY = "AIzaSyBWq81IiIIblEZahWUtFRnUukdtX7tQnv8";

function readMeta(name) {
    const el = typeof document !== "undefined" ? document.querySelector(`meta[name="${name}"]`) : null;
    return el ? String(el.getAttribute("content") || "").trim() : "";
}

/** Org-wide key: JS constant, then optional meta (never commit real secrets to public repos). */
export function getSharedGeminiKey() {
    const fromConst = String(AGRI_SHARED_GEMINI_KEY || "").trim();
    if (fromConst) return fromConst;
    return readMeta("agri-public-gemini-key");
}

/**
 * Key for browser-direct Gemini. Shared org key first, then window/meta/localStorage fallbacks.
 */
export function getGeminiDirectApiKey() {
    const shared = getSharedGeminiKey();
    if (shared) return shared;
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

function isHttpUrl(s) {
    return /^https?:\/\//i.test(String(s || "").trim());
}

/** @returns {{ inferenceBaseUrl: string, llmProxyUrl: string, imdApiBaseUrl: string, enginePackVersion: string, geminiDirectModel: string }} */
export function getAiConfig() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const aiBase = String(g.__AGRI_AI_BASE__ || readMeta("agri-ai-base") || "").replace(/\/$/, "");
    const inferExplicit = String(g.__AGRI_INFERENCE_URL__ || readMeta("agri-inference-url") || "").replace(/\/$/, "");
    const llmExplicit = String(g.__AGRI_LLM_PROXY__ || readMeta("agri-llm-proxy") || "").replace(/\/$/, "");
    const llmFallback = String(g.__AGRI_LLM_CLOUD_FN__ || readMeta("agri-llm-cloud-fn") || "").replace(/\/$/, "");
    const local = DEFAULT_LOCAL_AI_BASE.replace(/\/$/, "");
    const geminiDirectModel = String(readMeta("agri-gemini-model") || "gemini-1.5-flash").trim() || "gemini-1.5-flash";

    const hasSharedGemini = !!getSharedGeminiKey();
    let llmProxyUrl;
    if (isHttpUrl(llmExplicit)) {
        llmProxyUrl = llmExplicit;
    } else if (hasSharedGemini) {
        llmProxyUrl = "direct";
    } else {
        llmProxyUrl = llmExplicit || aiBase || llmFallback || local;
    }

    return {
        inferenceBaseUrl: inferExplicit || aiBase || local,
        llmProxyUrl,
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
