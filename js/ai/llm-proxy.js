/**
 * Optional same-origin proxy for Gemini grounded chat. POST JSON: { question, locale, evidenceBundle }
 */

import { getAiConfig } from "./config.js";

/** Full URL for the grounded chat request (FastAPI path or bare Cloud Function URL). */
export function resolveLlmChatUrl() {
    const raw = String(getAiConfig().llmProxyUrl || "").replace(/\/$/, "");
    if (!raw) return "";
    if (/\.cloudfunctions\.net\/.+/i.test(raw)) return raw;
    if (/\/v1\/chat\/grounded\/?$/i.test(raw)) return raw;
    return `${raw}/v1/chat/grounded`;
}

export async function callLlmProxy({ question, locale, bundle }) {
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
