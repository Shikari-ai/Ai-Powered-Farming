/**
 * Grounded chat via HTTPS backend (Cloud Function or FastAPI POST).
 * Body: { question, locale, evidenceBundle }
 */

import { getAiConfig, resolveLlmProxyHttpUrl } from "./config.js?v=65";

export function resolveLlmChatUrl() {
    return resolveLlmProxyHttpUrl(getAiConfig().llmProxyUrl);
}

export async function callLlmProxy({ question, locale, bundle }) {
    const url = resolveLlmChatUrl();
    if (!url) {
        throw new Error("LLM backend URL not configured (set meta agri-llm-proxy or window.__AGRI_LLM_PROXY__)");
    }
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
        throw new Error(`LLM backend ${res.status}: ${detail}`);
    }
    const data = await res.json();
    return {
        engine: "llm",
        text: data.reply || data.text || "",
        citations: data.citations || [],
        model: data.model || "proxy",
    };
}
