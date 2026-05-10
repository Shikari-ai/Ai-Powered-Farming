/**
 * HTTPS LLM endpoint for js/ai/llm-proxy.js (POST JSON body).
 * Uses GitHub Models (see https://docs.github.com/github-models/quickstart).
 *
 * Deploy (PowerShell; token NOT stored in git):
 *   $env:GITHUB_TOKEN = "<fine-grained PAT with models:read>"
 *   .\scripts\deploy-llm.ps1
 */

const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const githubToken = defineSecret("GITHUB_TOKEN");

const MAX_BUNDLE_CHARS = 120_000;
const GITHUB_CHAT_URL = "https://models.github.ai/inference/chat/completions";

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

exports.agriLlmChat = onRequest(
    {
        region: "us-central1",
        secrets: [githubToken],
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

        const token = process.env.GITHUB_TOKEN;
        if (!token || !String(token).trim()) {
            res.status(503).json({
                detail:
                    "GITHUB_TOKEN secret is not configured. Run: firebase functions:secrets:set GITHUB_TOKEN",
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
            (process.env.GITHUB_MODEL && String(process.env.GITHUB_MODEL).trim()) || "openai/gpt-4o";
        const apiVersion =
            (process.env.GITHUB_API_VERSION && String(process.env.GITHUB_API_VERSION).trim()) ||
            "2026-03-10";

        const systemInstruction = buildSystemInstruction(locale, evidenceBundle);

        try {
            const ghRes = await fetch(GITHUB_CHAT_URL, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token.trim()}`,
                    Accept: "application/vnd.github+json",
                    "Content-Type": "application/json",
                    "X-GitHub-Api-Version": apiVersion,
                },
                body: JSON.stringify({
                    model: modelId,
                    messages: [
                        { role: "system", content: systemInstruction },
                        { role: "user", content: question },
                    ],
                    temperature: parseFloat(process.env.GITHUB_TEMPERATURE || "0.35") || 0.35,
                    max_tokens: parseInt(process.env.GITHUB_MAX_TOKENS || "2048", 10) || 2048,
                    stream: false,
                }),
            });

            const rawText = await ghRes.text();
            if (!ghRes.ok) {
                res.status(502).json({
                    detail: `GitHub Models HTTP ${ghRes.status}: ${rawText.slice(0, 500)}`,
                });
                return;
            }

            let data;
            try {
                data = JSON.parse(rawText);
            } catch {
                res.status(502).json({ detail: "Invalid JSON from GitHub Models" });
                return;
            }

            let text = "";
            const choices = data && data.choices;
            if (Array.isArray(choices) && choices[0] && choices[0].message) {
                const c = choices[0].message.content;
                if (typeof c === "string") text = c.trim();
            }

            if (!text) {
                text =
                    "I could not parse a model reply. Check GITHUB_MODEL id, quota, and response shape.";
            }

            res.status(200).json({
                reply: text,
                text,
                model: modelId,
                citations: [],
            });
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e);
            res.status(502).json({ detail: `LLM request failed: ${msg.slice(0, 500)}` });
        }
    },
);
