/**
 * Universal self-learning intelligence layer (client-side, heuristic).
 * Unifies confidence scoring, web-augmentation gating, and memory-aware reuse
 * without duplicating orchestrator engines or replacing the assistant shell.
 */

import {
    effectiveConfidence,
    orchestratorEpistemicStress,
    topicFingerprint,
} from "./assistant-knowledge-memory.js?v=1";
import { shouldDeferDiagnosis, shouldFrameActionsProvisional } from "./epistemic-policy.js?v=3";

/** @typedef {"micro_social"|"casual"|"clarify"|"operations_quick"|"weather_quick"|"full"} AssistantRoutingMode */

const NO_WEB_MODES = /** @type {const} */ ([
    "micro_social",
    "casual",
    "clarify",
    "operations_quick",
]);

/**
 * Heuristic confidence dimensions for this turn (no LLM, no user-visible “scores” in UI).
 * @param {{
 *   question: string,
 *   routingMode: AssistantRoutingMode,
 *   orch?: any,
 *   memoryHits?: { score: number, entry?: any }[],
 * }} args
 */
export function computeTurnConfidence({ question, routingMode, orch, memoryHits = [] }) {
    const q = String(question || "");
    const now = Date.now();
    const intents = orch?.intents || {};
    const snap = orch?.snapshot || {};
    const fields = snap.fields?.length || 0;
    const scans = snap.scans?.length || 0;
    const results = orch?.results || {};

    let famParts = 0;
    const famMax = 7;
    if (intents.weather && results.weatherIntelligence && !results.weatherIntelligence.error) famParts++;
    if (intents.pest && results.pestPrediction) famParts++;
    if (intents.disease && (results.diseaseVision?.status === "ok" || scans > 0)) famParts++;
    if (intents.field && fields > 0) famParts++;
    if (intents.operations || intents.yield) famParts++;
    if (Object.values(intents).filter(Boolean).length >= 2) famParts++;
    if (results.recommendations?.actions?.length) famParts++;
    const familiarity01 = famMax ? Math.min(1, famParts / famMax) : 0.35;

    let evidence01 = 0.32;
    if (scans > 0) evidence01 += 0.22;
    if (fields > 0) evidence01 += 0.12;
    if (results.diseaseVision?.status === "ok") evidence01 += 0.16;
    if (results.weatherIntelligence && !results.weatherIntelligence.error) evidence01 += 0.12;
    if (results.environmental?.sensorDocCount > 0) evidence01 += 0.06;
    evidence01 = Math.min(1, evidence01);

    const wf = typeof orch?.weatherFresh01 === "number" ? orch.weatherFresh01 : 0.72;
    const freshness01 = Math.max(0, Math.min(1, wf));

    const { stress01 } = orchestratorEpistemicStress(orch);
    const uncertainty01 = stress01;

    let memoryBoost01 = 0;
    const top = memoryHits[0];
    if (top?.entry) {
        const ec = effectiveConfidence(top.entry, now);
        memoryBoost01 = Math.min(0.38, (top.score || 0) * ec * 0.55);
    }

    const overallConfidence01 = Math.max(
        0.06,
        Math.min(
            0.94,
            familiarity01 * 0.26 + evidence01 * 0.28 + freshness01 * 0.14 + (1 - uncertainty01) * 0.2 + memoryBoost01,
        ),
    );

    return {
        familiarity01,
        evidence01,
        freshness01,
        uncertainty01,
        memoryBoost01,
        overallConfidence01,
    };
}

/** @param {string} q */
function buildResearchQuery(q) {
    let s = q.replace(/\s+/g, " ").trim().slice(0, 220);
    if (
        !/\b(agricultur|agri|crop|farm|farmers?|plant|soil|pest|disease|pathogen|irrigation|fertiliz|fertiliser|harvest|wheat|rice|maize|subsidy|policy|outbreak|market|mandi|variety)\b/i.test(
            s,
        )
    ) {
        s = `agriculture ${s}`;
    }
    return s;
}

/**
 * Strong learned row for same intent → skip fresh web fetch.
 * @param {string} question
 * @param {{ score: number, entry?: any }[]} memoryHits
 */
function reinforcedMemoryCoversQuestion(question, memoryHits) {
    const fp = topicFingerprint(question);
    const hit = (memoryHits || []).find((h) => h?.entry?.topicFingerprint === fp);
    if (!hit?.entry) return false;
    const rc = typeof hit.entry.reinforcementCount === "number" ? hit.entry.reinforcementCount : 1;
    const ec = effectiveConfidence(hit.entry, Date.now());
    return rc >= 3 && ec >= 0.52;
}

/**
 * Substantive “open” questions where a short public extract helps more than farm engines alone.
 */
function wantsSubstantivePublicContext(question, orch, memoryHits, confidence) {
    const q = String(question || "").trim();
    if (confidence.overallConfidence01 >= 0.7) return false;
    if (q.length < 40) return false;
    if (reinforcedMemoryCoversQuestion(q, memoryHits)) return false;

    const top = memoryHits[0];
    if (top?.entry) {
        const ec = effectiveConfidence(top.entry, Date.now());
        if ((top.score || 0) >= 0.42 && ec >= 0.62) return false;
    }

    const substantive =
        /\b(why|how\s+does|how\s+do|explain|what\s+is\s+the\s+(history|difference|relationship)|compare|versus|vs\.|pros\s+and\s+cons|statistics|definition\s+of|background\s+on|overview\s+of|research\s+on)\b/i.test(
            q,
        );
    const policyish =
        /\b(sustainability|climate\s+change|carbon|export|import|trade|food\s+security|rural\s+economy|credit|subsidy|organic\s+cert|supply\s+chain)\b/i.test(
            q,
        );
    const agriAnchor = /\b(farm|agricultur|crop|food|rural|farmer|harvest|soil|irrigation)\b/i.test(q);
    return substantive || (policyish && agriAnchor);
}

/**
 * @param {{
 *   question: string,
 *   routingMode: AssistantRoutingMode,
 *   orch?: any,
 *   memoryHits?: { score: number, entry?: any }[],
 *   precomputedConfidence?: ReturnType<typeof computeTurnConfidence>,
 * }} args
 * @returns {{ use: boolean, reasons: string[], query: string, skippedForMemory?: boolean, turnConfidence?: ReturnType<typeof computeTurnConfidence> }}
 */
export function evaluateWebResearchGate({
    question,
    routingMode,
    orch,
    memoryHits = [],
    precomputedConfidence,
}) {
    const q = String(question || "").trim();
    const turnConfidence =
        precomputedConfidence && typeof precomputedConfidence.overallConfidence01 === "number"
            ? precomputedConfidence
            : computeTurnConfidence({ question: q, routingMode, orch, memoryHits });

    if (!q || q.length < 18) return { use: false, reasons: [], query: "", turnConfidence };
    if (NO_WEB_MODES.includes(routingMode)) return { use: false, reasons: [], query: "", turnConfidence };
    if (/^(hi|hello|hey|thanks|thank\s+you|thx|bye|goodbye)\b/i.test(q) && q.length < 56) {
        return { use: false, reasons: [], query: "", turnConfidence };
    }

    const intents = orch?.intents || {};
    /** @type {string[]} */
    const reasons = [];

    const wantsDiseaseId =
        /\b(identify|what\s+disease|which\s+disease|name\s+the|pathogen|scientific\s+name|latin\s+name|diagnos(e|is))\b/i.test(
            q,
        );
    if (intents.disease && wantsDiseaseId && shouldDeferDiagnosis(orch)) {
        reasons.push("thin_diagnosis");
    }

    if (
        /\b(newly\s+emerging|emerging\s+disease|novel\s+pest|rare\s+pest|outbreak\s+in|epidemic\s+in|government\s+(order|notification|circular)|MSP\b|minimum\s+support|commodity\s+prices?|fertilizer\s+(law|ban|subsidy|policy)|ICAR\b|APEDA|FSSAI|import\s+duty|mandi\s+price)\b/i.test(
            q,
        )
    ) {
        reasons.push("policy_market_or_outbreak");
    }

    if (/\b(latest\s+(research|paper|news)|pubmed|arxiv|doi:|clinical\s+trial)\b/i.test(q)) {
        reasons.push("time_sensitive_science");
    }

    if (
        shouldFrameActionsProvisional(orch, orch?.snapshot) &&
        /\b(regulation|label|restricted|banned|approved|re-registration|maximum\s+residue|mrl)\b/i.test(q)
    ) {
        reasons.push("provisional_plus_regulatory");
    }

    if (/\b(obscure|rare|unusual)\b.*\b(disease|pathogen|pest|virus)\b|\b(never\s+heard\s+of)\b.*\b(pest|disease)/i.test(q)) {
        reasons.push("obscure_taxon");
    }

    const agriCue =
        intents.disease ||
        intents.pest ||
        intents.weather ||
        intents.field ||
        /\b(crop|farm|soil|harvest|irrigation|fertiliz|pesticide|pathogen|variety|seed|msp|mandi|icar|imd)\b/i.test(q);
    const { lowConfidence } = orchestratorEpistemicStress(orch);
    if (reasons.length === 0 && lowConfidence && agriCue) {
        reasons.push("engine_epistemic_stress");
    }

    if (
        reasons.length === 0 &&
        routingMode === "full" &&
        wantsSubstantivePublicContext(q, orch, memoryHits, turnConfidence)
    ) {
        reasons.push("substantive_context_gap");
    }

    const topMem = memoryHits[0];
    const memScore = typeof topMem?.score === "number" ? topMem.score : 0;
    const memEntry = topMem?.entry;
    const memConf = memEntry ? effectiveConfidence(memEntry, Date.now()) : 0;
    const memRc = typeof memEntry?.reinforcementCount === "number" ? memEntry.reinforcementCount : 1;

    if (
        reasons.length === 1 &&
        reasons[0] === "engine_epistemic_stress" &&
        memScore >= 0.48 &&
        memConf >= 0.6
    ) {
        return { use: false, reasons: [], query: "", skippedForMemory: true, turnConfidence };
    }

    if (
        reasons.length === 1 &&
        reasons[0] === "substantive_context_gap" &&
        memScore >= 0.4 &&
        memConf >= 0.58 &&
        memRc >= 2
    ) {
        return { use: false, reasons: [], query: "", skippedForMemory: true, turnConfidence };
    }

    if (
        reasons.includes("substantive_context_gap") &&
        turnConfidence.overallConfidence01 >= 0.74 &&
        memScore >= 0.36
    ) {
        const idx = reasons.indexOf("substantive_context_gap");
        if (idx >= 0) reasons.splice(idx, 1);
    }

    if (reasons.length === 0) return { use: false, reasons: [], query: "", turnConfidence };

    return {
        use: true,
        reasons,
        query: buildResearchQuery(q),
        turnConfidence,
    };
}
