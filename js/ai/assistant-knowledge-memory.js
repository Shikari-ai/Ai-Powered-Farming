/**
 * Continuous learning memory for the assistant: structured, bounded, honest.
 * Stores compact summaries from trusted-style public lookups (never raw pages).
 * Retrieval uses lightweight token overlap — no embeddings (keeps latency + cost low).
 */

import { pickRotated } from "./conversation-naturals.js?v=48";

const STOP = new Set(
    `a an the is are was were be been being to of in on at for and or nor but if so as by
    we you they it this that these those what which who how when why with from than then
    about into over after before out up down can could should would may might must will
    just also very some any each every both few such same than into onto per via`.split(/\s+/),
);

const MAX_SUMMARY = 520;
const MAX_REASONING = 360;
const MAX_GUIDANCE = 200;
const MAX_TOPIC = 160;

/** @param {string} s */
export function tokenizeForMemory(s) {
    const t = String(s || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ");
    const parts = t.split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
    return new Set(parts);
}

/** @param {Set<string>} a @param {Set<string>} b */
function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) {
        if (b.has(x)) inter++;
    }
    return inter / (a.size + b.size - inter);
}

/**
 * Heuristic epistemic load on the orchestrator (no LLM).
 * @param {any} orch
 * @returns {{ stress01: number, lowConfidence: boolean }}
 */
export function orchestratorEpistemicStress(orch) {
    if (!orch) return { stress01: 0, lowConfidence: false };
    let stress = 0;
    const cv = orch.cognitiveVerification || {};
    if (cv.softenStrongClaims) stress += 0.34;
    const checks = cv.checks || [];
    stress += Math.min(0.22, checks.length * 0.055);
    const wx = orch.results?.weatherIntelligence;
    if (wx?.error) stress += 0.18;
    const vis = orch.results?.diseaseVision;
    if (vis?.status === "ok" && typeof vis.confidence === "number" && vis.confidence < 0.4) stress += 0.2;
    const intents = orch.intents || {};
    const rec = orch.results?.recommendations;
    if ((intents.disease || intents.pest) && Array.isArray(rec?.actions) && rec.actions.length === 0) stress += 0.1;
    stress = Math.min(1, stress);
    return { stress01: stress, lowConfidence: stress >= 0.38 };
}

/**
 * @param {{ url?: string, source?: string }} brief
 * @returns {number} 0–1 prior for how much to trust a short public extract.
 */
export function sourceReliabilityPrior(brief) {
    const u = String(brief?.url || "").toLowerCase();
    const src = String(brief?.source || "").toLowerCase();
    if (/wikimedia|wikipedia\.org/.test(u) || src.includes("wikipedia")) return 0.64;
    if (src.includes("duckduckgo")) return 0.56;
    if (/\.gov\.in|icar\.|imd\.|nic\.in|\.edu/.test(u)) return 0.82;
    return 0.52;
}

/** @param {string} text */
export function extractAgriMemoryTags(text) {
    const lower = String(text || "").toLowerCase();
    /** @type {string[]} */
    const tags = [];
    const add = (x) => tags.push(x);
    if (/\b(icar|imd|msp|mandi|fertiliz|subsidy|policy|mrl|pesticide|government|circular)\b/i.test(lower))
        add("policy_market");
    if (/\b(wheat|rice|maize|cotton|soy|pulses|sugarcane|potato|tomato|mustard|bajra|jowar)\b/i.test(lower)) add("crop");
    if (/\b(pest|pathogen|disease|virus|fungus|blight|mildew|rust|nematode)\b/i.test(lower)) add("bio_stress");
    if (/\b(irrigation|water|moisture|rain|humidity|drought)\b/i.test(lower)) add("water");
    if (/\b(soil|ph\b|ec\b|nutrient|npk|deficien)\b/i.test(lower)) add("soil_nutrition");
    return [...new Set(tags)];
}

/**
 * @param {string} q
 * @returns {string} stable fingerprint for merge (same intent → one row).
 */
export function topicFingerprint(q) {
    const n = String(q || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[?!.,;:]+/g, "")
        .trim()
        .slice(0, 200);
    let h = 2166136261;
    for (let i = 0; i < n.length; i++) h = Math.imul(h ^ n.charCodeAt(i), 16777619);
    return `fp_${(h >>> 0).toString(16)}`;
}

/**
 * @param {Set<string>} questionTokens
 * @param {{ topicTokens?: string[], tags?: string[] }} entry
 */
export function similarityToEntry(questionTokens, entry) {
    const t2 = new Set(Array.isArray(entry.topicTokens) ? entry.topicTokens : []);
    let base = jaccard(questionTokens, t2);
    const tags = entry.tags || [];
    for (const tag of tags) {
        const slug = String(tag || "").replace(/_/g, "");
        if (slug.length > 3 && questionTokens.has(slug)) base += 0.05;
    }
    return Math.min(1, base);
}

/**
 * @param {any[]} entries normalized in-memory rows
 * @param {string} question
 * @param {{ limit?: number, minScore?: number }} [opts]
 * @returns {{ entry: any, score: number }[]}
 */
export function findRelevantKnowledgeMemory(entries, question, opts = {}) {
    const limit = typeof opts.limit === "number" ? opts.limit : 2;
    const minScore = typeof opts.minScore === "number" ? opts.minScore : 0.17;
    const qt = tokenizeForMemory(question);
    if (!qt.size) return [];
    const scored = (entries || [])
        .map((entry) => ({ entry, score: similarityToEntry(qt, entry) }))
        .filter((x) => x.score >= minScore)
        .sort((a, b) => b.score - a.score || (b.entry.lastUsedAtMs || 0) - (a.entry.lastUsedAtMs || 0))
        .slice(0, limit);
    return scored;
}

/**
 * Confidence decay from age (read-time only; does not mutate Firestore).
 * @param {any} entry
 * @param {number} nowMs
 */
export function effectiveConfidence(entry, nowMs) {
    const base = typeof entry.confidence === "number" ? entry.confidence : 0.55;
    const t = entry.lastReinforcedAtMs || entry.createdAtMs || nowMs;
    const ageDays = Math.max(0, (nowMs - t) / 86400000);
    const decay = Math.exp(-ageDays / 120);
    return Math.max(0.22, Math.min(0.94, base * decay));
}

/**
 * @param {{ entry: any, score: number }[]} hits
 * @returns {string[]}
 */
export function formatLearnedMemoryLines(hits) {
    if (!hits?.length) return [];
    const lead = pickRotated("learned_mem_lead", [
        "From your earlier saved research notes on a similar angle (still verify anything time-sensitive):",
        "I’m borrowing a short, earlier-learned note from your account — advisory only, not a live circular:",
        "Lightweight recall from past public summaries you triggered — cross-check if policy or prices moved:",
    ]);
    const lines = [lead];
    for (const { entry, score } of hits) {
        const ec = effectiveConfidence(entry, Date.now());
        const rel = typeof entry.sourceReliability === "number" ? entry.sourceReliability : 0.55;
        const lab = String(entry.topic || "topic").slice(0, MAX_TOPIC);
        const sum = String(entry.summary || "").replace(/\s+/g, " ").trim().slice(0, 280);
        lines.push(
            `• **${lab}** — retained confidence ~${Math.round(ec * 100)}% (match ${Math.round(
                score * 100,
            )}%; source prior ~${Math.round(rel * 100)}%): ${sum}${sum.length >= 280 ? "…" : ""}`,
        );
    }
    lines.push(
        "These are compressed memories from Wikipedia / DDG-style lookups — not extension pathology or official orders.",
    );
    return lines;
}

/**
 * @param {string} reply
 */
function firstGuidanceLine(reply) {
    const t = String(reply || "")
        .split(/\n+/)
        .map((s) => s.trim())
        .find((s) => s.length > 24);
    return (t || "").slice(0, MAX_GUIDANCE);
}

/**
 * @param {{
 *   userId: string,
 *   question: string,
 *   researchQuery: string,
 *   brief: { source?: string, title?: string, url?: string, summary?: string },
 *   webReasons: string[],
 *   intents: Record<string, boolean>,
 *   assistantReply: string,
 * }} args
 */
export function buildKnowledgeDocPayload(args) {
    const {
        userId,
        question,
        researchQuery,
        brief,
        webReasons = [],
        intents = {},
        assistantReply = "",
    } = args;
    const topic = String(question || "").replace(/\s+/g, " ").trim().slice(0, MAX_TOPIC);
    const summary = String(brief?.summary || "").replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY);
    const reasoning = `Summarized from ${brief?.source || "public reference"} for orientation only. Triggers: ${webReasons.join(
        ", ",
    )}.`.slice(0, MAX_REASONING);
    const guidanceStructure = firstGuidanceLine(assistantReply);
    const rel = sourceReliabilityPrior(brief);
    const baseConf = Math.min(0.78, 0.42 + rel * 0.38);
    const tags = extractAgriMemoryTags(`${question}\n${researchQuery}\n${summary}`);
    const related = [];
    if (intents.disease) related.push("disease");
    if (intents.pest) related.push("pest");
    if (intents.weather) related.push("weather");
    if (intents.field) related.push("field");
    const topicTokens = [...tokenizeForMemory(`${question} ${researchQuery} ${summary}`)].slice(0, 48);
    return {
        userId,
        schemaVersion: 1,
        topic,
        topicFingerprint: topicFingerprint(question),
        summary,
        reasoning,
        guidanceStructure,
        confidence: baseConf,
        sourceReliability: rel,
        sources: [
            {
                label: String(brief?.title || brief?.source || "source").slice(0, 120),
                url: String(brief?.url || "").slice(0, 500),
            },
        ].filter((s) => s.url),
        tags,
        relatedCropsIssues: related,
        webReasons: webReasons.slice(0, 8),
        topicTokens,
        reinforcementCount: 1,
        contradictionFlag: false,
        conversationalExample: guidanceStructure.slice(0, 160),
    };
}

/**
 * Merge incoming web-learned payload into an existing entry (client-side shape).
 * @param {any} existing
 * @param {ReturnType<typeof buildKnowledgeDocPayload>} incoming
 */
export function mergeKnowledgeEntries(existing, incoming) {
    const rCount = (typeof existing.reinforcementCount === "number" ? existing.reinforcementCount : 1) + 1;
    const prevConf = typeof existing.confidence === "number" ? existing.confidence : 0.55;
    const nextConf = Math.min(0.9, prevConf + 0.035);
    const oldSum = String(existing.summary || "");
    const newSum = String(incoming.summary || "");
    let summary = oldSum;
    if (newSum && newSum !== oldSum) {
        const a = tokenizeForMemory(oldSum);
        const b = tokenizeForMemory(newSum);
        const sim = jaccard(a, b);
        if (sim < 0.35) {
            summary = `${oldSum.slice(0, 240)} … / … ${newSum.slice(0, 240)}`.slice(0, MAX_SUMMARY);
        } else {
            summary = oldSum.length >= newSum.length ? oldSum : newSum;
        }
    }
    const oldUrl = String(existing.sources?.[0]?.url || "");
    const newUrl = String(incoming.sources?.[0]?.url || "");
    const contradictionFlag =
        !!existing.contradictionFlag ||
        (!!oldUrl &&
            !!newUrl &&
            oldUrl.replace(/^https?:\/\/(www\.)?/i, "") !== newUrl.replace(/^https?:\/\/(www\.)?/i, "") &&
            jaccard(tokenizeForMemory(oldSum), tokenizeForMemory(newSum)) < 0.25);
    const topicTokens = [
        ...new Set([...(existing.topicTokens || []), ...(incoming.topicTokens || [])]),
    ].slice(0, 56);
    const tags = [...new Set([...(existing.tags || []), ...(incoming.tags || [])])].slice(0, 12);
    return {
        ...existing,
        summary: summary.slice(0, MAX_SUMMARY),
        reasoning: incoming.reasoning.slice(0, MAX_REASONING),
        guidanceStructure: incoming.guidanceStructure || existing.guidanceStructure,
        conversationalExample: incoming.conversationalExample || existing.conversationalExample,
        confidence: contradictionFlag ? Math.max(0.28, nextConf - 0.12) : nextConf,
        sourceReliability: Math.max(existing.sourceReliability || 0, incoming.sourceReliability || 0),
        sources: incoming.sources?.length ? incoming.sources : existing.sources,
        tags,
        relatedCropsIssues: [...new Set([...(existing.relatedCropsIssues || []), ...incoming.relatedCropsIssues])].slice(
            0,
            8,
        ),
        webReasons: [...new Set([...(existing.webReasons || []), ...incoming.webReasons])].slice(0, 10),
        topicTokens,
        reinforcementCount: rCount,
        contradictionFlag,
    };
}

/**
 * @param {any[]} entries
 * @param {string} question
 * @returns {any | null}
 */
export function findMergeTargetEntry(entries, question) {
    const fp = topicFingerprint(question);
    const hit = (entries || []).find((e) => e.topicFingerprint === fp);
    if (hit) return hit;
    const mem = findRelevantKnowledgeMemory(entries, question, { limit: 1, minScore: 0.52 });
    return mem[0]?.entry || null;
}

/** Max documents per user before LRU-style deletes. */
export const KNOWLEDGE_MEMORY_CAP = 38;
