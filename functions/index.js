/**
 * HTTPS Gemini endpoint compatible with js/ai/llm-proxy.js (POST JSON body).
 *
 * Deploy from repo root (PowerShell, key NOT stored in git):
 *   $env:GEMINI_API_KEY = "<Google AI Studio key>"
 *   .\\scripts\\deploy-gemini.ps1
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const geminiApiKey = defineSecret("GEMINI_API_KEY");

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

exports.agriGeminiChat = onRequest(
    {
        region: "us-central1",
        secrets: [geminiApiKey],
        cors: true,
        invoker: "public",
        timeoutSeconds: 120,
        memory: "512MiB",
    },
    async (req, res) => {
        if (req.method === "OPTIONS") {
            res.status(204).send("");
            return;
        }
        if (req.method !== "POST") {
            res.status(405).json({ detail: "Method not allowed" });
            return;
        }

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey || !String(apiKey).trim()) {
            res.status(503).json({
                detail: "GEMINI_API_KEY secret is not configured. Run: firebase functions:secrets:set GEMINI_API_KEY",
            });
            return;
        }

        let body = req.body;
        if (typeof body === "string") {
            try {
                body = JSON.parse(body);
            } catch {
                res.status(400).json({ detail: "Invalid JSON body" });
                return;
            }
        }
        if (!body || typeof body !== "object") {
            res.status(400).json({ detail: "Expected JSON object" });
            return;
        }

        const question = String(body.question || "").trim() || "Summarize the farm evidence briefly.";
        const locale = String(body.locale || "en").trim() || "en";
        const evidenceBundle =
            body.evidenceBundle && typeof body.evidenceBundle === "object" ? body.evidenceBundle : {};

        const modelId =
            (process.env.GEMINI_MODEL && String(process.env.GEMINI_MODEL).trim()) || "gemini-1.5-flash";

        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const systemInstruction = buildSystemInstruction(locale, evidenceBundle);
            const model = genAI.getGenerativeModel({
                model: modelId,
                systemInstruction,
            });

            const result = await model.generateContent({
                contents: [{ role: "user", parts: [{ text: question }] }],
                generationConfig: {
                    temperature: parseFloat(process.env.GEMINI_TEMPERATURE || "0.35") || 0.35,
                    maxOutputTokens: parseInt(process.env.GEMINI_MAX_OUTPUT_TOKENS || "2048", 10) || 2048,
                },
            });

            let text = "";
            try {
                text = (result.response.text() || "").trim();
            } catch {
                const c = result.response?.candidates?.[0];
                const partsOut = c?.content?.parts || [];
                text = partsOut
                    .map((p) => (typeof p.text === "string" ? p.text : ""))
                    .join("\n")
                    .trim();
            }

            if (!text) {
                text =
                    "I could not produce a reply from Gemini. Check GEMINI_MODEL, API quota, and request size.";
            }

            res.status(200).json({
                reply: text,
                text,
                model: modelId,
                citations: [],
            });
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e);
            res.status(502).json({ detail: `Gemini request failed: ${msg.slice(0, 500)}` });
        }
    },
);
