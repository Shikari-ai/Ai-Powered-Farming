/**
 * When to augment internal (orchestrator + heuristics) answers with a small **public** lookup.
 * Selective: no web for micro-social, casual, clarify, or very short non-technical turns.
 */
import { shouldDeferDiagnosis, shouldFrameActionsProvisional } from "./epistemic-policy.js?v=2";

/** @typedef {"micro_social"|"casual"|"clarify"|"operations_quick"|"weather_quick"|"full"} AssistantRoutingMode */

const NO_WEB_MODES = /** @type {const} */ ([
    "micro_social",
    "casual",
    "clarify",
    "operations_quick",
]);

/**
 * @param {{ question: string, routingMode: AssistantRoutingMode, orch?: any }} args
 * @returns {{ use: boolean, reasons: string[], query: string }}
 */
export function shouldUseWebAssistedResearch({ question, routingMode, orch }) {
    const q = String(question || "").trim();
    if (!q || q.length < 18) return { use: false, reasons: [], query: "" };
    if (NO_WEB_MODES.includes(routingMode)) return { use: false, reasons: [], query: "" };
    if (/^(hi|hello|hey|thanks|thank\s+you|thx|bye|goodbye)\b/i.test(q) && q.length < 56) {
        return { use: false, reasons: [], query: "" };
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

    if (reasons.length === 0) return { use: false, reasons: [], query: "" };

    return {
        use: true,
        reasons,
        query: buildResearchQuery(q),
    };
}

/** @param {string} q */
function buildResearchQuery(q) {
    let s = q.replace(/\s+/g, " ").trim().slice(0, 220);
    if (!/\b(agricultur|agri|crop|farm|plant|soil|pest|disease|pathogen|irrigation|fertil|harvest)\b/i.test(s)) {
        s = `agriculture ${s}`;
    }
    return s;
}
