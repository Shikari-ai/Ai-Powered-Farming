/**
 * Optional same-origin proxy for Gemini grounded chat. POST JSON: { question, locale, evidenceBundle }
 */
import { getAiConfig } from "./config.js";

export async function callLlmProxy({ question, locale, bundle }) {
    const url = getAiConfig().llmProxyUrl;
    if (!url) throw new Error("LLM proxy not configured");
    const res = await fetch(`${url}/v1/chat/grounded`, {
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
