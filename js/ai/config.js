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

/**
 * Only default to local FastAPI on true dev origins. Hosted builds must set
 * `meta agri-inference-url` or `window.__AGRI_INFERENCE_URL__` / `__AGRI_AI_BASE__`.
 * Otherwise `inferenceBaseUrl` stays empty — assistant image path uses on-device engines + clear “unconfigured” copy instead of POSTing to 127.0.0.1.
 */
function defaultLocalInferenceBaseIfDev() {
    if (typeof location === "undefined") return "";
    const h = String(location.hostname || "").toLowerCase();
    if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "") {
        return DEFAULT_LOCAL_AI_BASE.replace(/\/$/, "");
    }
    return "";
}

/** @returns {{ inferenceBaseUrl: string, imdApiBaseUrl: string, enginePackVersion: string }} */
export function getAiConfig() {
    const g = typeof globalThis !== "undefined" ? globalThis : {};
    const aiBase = String(g.__AGRI_AI_BASE__ || readMeta("agri-ai-base") || "").replace(/\/$/, "");
    const inferExplicit = String(g.__AGRI_INFERENCE_URL__ || readMeta("agri-inference-url") || "").replace(/\/$/, "");
    const localFallback = defaultLocalInferenceBaseIfDev();

    /** `<meta name="agri-web-research" content="0">` disables optional client-side public briefs. */
    const webMeta = readMeta("agri-web-research").toLowerCase();
    const webResearchEnabled = webMeta !== "0" && webMeta !== "false" && webMeta !== "off";

    /** `<meta name="agri-knowledge-memory" content="0">` disables Firestore-backed learned summaries. */
    const kmMeta = readMeta("agri-knowledge-memory").toLowerCase();
    const assistantKnowledgeMemoryEnabled = kmMeta !== "0" && kmMeta !== "false" && kmMeta !== "off";

    return {
        inferenceBaseUrl: inferExplicit || aiBase || localFallback,
        imdApiBaseUrl: String(g.__AGRI_IMD_API__ || readMeta("agri-imd-api") || "").replace(/\/$/, ""),
        enginePackVersion: "ecosystem-2026-05-reliability-v1",
        webResearchEnabled,
        assistantKnowledgeMemoryEnabled,
    };
}

export function isInferenceConfigured() {
    return !!getAiConfig().inferenceBaseUrl;
}
