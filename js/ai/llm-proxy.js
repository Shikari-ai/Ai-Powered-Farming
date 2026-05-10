/**
 * Optional HTTP proxy for Gemini grounded chat, or browser-direct mode (`agri-llm-proxy` = direct).
 * POST JSON: { question, locale, evidenceBundle }
 */

import { getAiConfig, getGeminiDirectApiKey } from "./config.js?v=59";
import { callGeminiDirect } from "./gemini-direct.js?v=59";

/** Full URL for the grounded chat request (FastAPI path or bare Cloud Function URL). */
export function resolveLlmChatUrl() {
    const raw = String(getAiConfig().llmProxyUrl || "").replace(/\/$/, "");
    if (!raw || raw.toLowerCase() === "direct") return "";
    if (/\.cloudfunctions\.net\/.+/i.test(raw)) return raw;
    if (/\/v1\/chat\/grounded\/?$/i.test(raw)) return raw;
    return `${raw}/v1/chat/grounded`;
}

export async function callLlmProxy({ question, locale, bundle }) {
    const cfg = getAiConfig();
    const mode = String(cfg.llmProxyUrl || "").trim().toLowerCase();
    if (mode === "direct") {
        const apiKey = getGeminiDirectApiKey();
        if (!apiKey) {
            throw new Error(
                "Browser Gemini (direct): set localStorage agri_gemini_api_key, window.__AGRI_GEMINI_API_KEY__, or meta agri-gemini-api-key",
            );
        }
        return callGeminiDirect({
            question,
            locale,
            bundle,
            apiKey,
            modelId: cfg.geminiDirectModel,
        });
    }

    const url = resolveLlmChatUrl();
    if (!url) throw new Error("LLM proxy not configured");
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            question,
            locale: locale || "en",
            evidenceBundle: bundle,
        }),
    });
    if (!res.ok) {
        let t = "";
        try {
            t = await res.text();
        } catch {
            t = "";
        }
        let detail = t.slice(0, 240);
        try {
            const j = JSON.parse(t);
            if (j.detail != null) {
                detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
            }
        } catch {
            /* plain text body */
        }
        throw new Error(`LLM proxy ${res.status}: ${detail}`);
    }
    const data = await res.json();
    return {
        engine: "llm",
        text: data.reply || data.text || "",
        citations: data.citations || [],
        model: data.model || "proxy",
    };
}
