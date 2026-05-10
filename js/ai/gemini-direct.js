/**
 * Browser-side Gemini (Google AI Studio key). Use only with API key restrictions (e.g. HTTP referrers)
 * for your hosting domain — keys are still visible in DevTools.
 *
 * Prompt contract kept in line with functions/index.js (buildSystemInstruction).
 */

const MAX_BUNDLE_CHARS = 120_000;

function truncateJson(obj) {
    let s;
    try {
        s = JSON.stringify(obj, null, 0);
    } catch {
        s = String(obj);
    }
    if (s.length <= MAX_BUNDLE_CHARS) return s;
    return `${s.slice(0, MAX_BUNDLE_CHARS - 80)}\n…[truncated for model context]…`;
}

function buildSystemInstruction(locale, evidenceBundle) {
    const loc = (locale || "en").trim() || "en";
    const bundle = evidenceBundle && typeof evidenceBundle === "object" ? evidenceBundle : {};

    let depthHint = "";
    const d = bundle.reasoningDepth;
    if (typeof d === "number") {
        if (d >= 3) {
            depthHint =
                "The client requested deep reasoning: connect signals, state uncertainties, separate observed vs predicted.";
        } else if (d >= 2) {
            depthHint = "Use clear, structured reasoning; moderate length.";
        }
    }

    const turnKind = bundle.turnKind;
    let turnHint = "";
    if (turnKind === "casual") {
        turnHint =
            "Turn type: CASUAL or greeting — keep it short, warm, human; no farm brief unless the user asked.";
    } else if (turnKind === "clarify") {
        turnHint =
            "Turn type: CLARIFY — user was vague about symptoms; prefer 1–2 sharp questions over conclusions.";
    }

    let directives = "";
    const companion = bundle.companion;
    if (companion && typeof companion === "object") {
        const dir = companion.directives;
        if (typeof dir === "string" && dir.trim()) {
            directives = `\n\nPERSONALIZATION (from stored profile; do not contradict evidence):\n${dir.trim().slice(0, 8000)}\n`;
        }
    }

    const bundleJson = truncateJson(bundle);

    const parts = [
        "You are the agricultural copilot for Smart Agri / AgriTech AI. You must ground every claim in EVIDENCE_JSON below.",
        "Rules:",
        "- Only cite or imply facts that appear in EVIDENCE_JSON. If something is absent, say data is not available.",
        "- Prefer short paragraphs; no markdown tables unless the user explicitly asks.",
        "- State uncertainty when confidence is low or data is stale (see degradedMode / verification flags).",
        "- Never guarantee yields, disease outcomes, or autonomous field actions. Humans execute all field work.",
        "- Avoid alarmist language; prefer 'elevated risk' and early verification.",
        `- Preferred locale for this turn: ${loc}. Use it when natural.`,
        depthHint,
        turnHint,
        directives,
        "\nEVIDENCE_JSON:\n",
        bundleJson,
    ];

    return parts.filter(Boolean).join("\n");
}

/**
 * @param {{ question: string, locale?: string, bundle: object, apiKey: string, modelId?: string }} p
 */
export async function callGeminiDirect({ question, locale, bundle, apiKey, modelId }) {
    const q = String(question || "").trim() || "Summarize the farm evidence briefly.";
    const loc = String(locale || "en").trim() || "en";
    const model = String(modelId || "gemini-1.5-flash").trim() || "gemini-1.5-flash";
    const key = String(apiKey || "").trim();
    if (!key) throw new Error("Gemini API key missing (browser direct mode)");

    const systemText = buildSystemInstruction(loc, bundle && typeof bundle === "object" ? bundle : {});
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;

    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemText }] },
            contents: [{ role: "user", parts: [{ text: q }] }],
            generationConfig: {
                temperature: 0.35,
                maxOutputTokens: 2048,
            },
        }),
    });

    const raw = await res.text();
    if (!res.ok) {
        let detail = raw.slice(0, 400);
        try {
            const j = JSON.parse(raw);
            if (j.error?.message) detail = String(j.error.message);
        } catch {
            /* use slice */
        }
        throw new Error(`Gemini ${res.status}: ${detail}`);
    }

    let data;
    try {
        data = JSON.parse(raw);
    } catch {
        throw new Error("Gemini: invalid JSON response");
    }

    let text = "";
    const cand = data.candidates && data.candidates[0];
    const partsOut = cand?.content?.parts || [];
    text = partsOut
        .map((p) => (typeof p.text === "string" ? p.text : ""))
        .join("\n")
        .trim();

    if (!text) {
        text =
            "I could not produce a reply from Gemini. Check model name, API quota, and request size.";
    }

    return {
        engine: "llm",
        text,
        citations: [],
        model,
    };
}
