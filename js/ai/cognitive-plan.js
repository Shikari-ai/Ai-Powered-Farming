/**
 * Cognitive layering: reasoning depth, staged retrieval, and LLM budget (heuristic, explainObject).
 * Complements routing (casual/clarify/weather_quick/full) — only shapes work inside full / weather paths.
 */

/** Same family as assistant-intent-router “deep” cues. */
const DEEP_PIPELINE =
    /\b(simulat|simulation|digital\s*twin|\btwin\b|counterfactual|scenario|stress\s*test|forecast|outbreak|epidemic|regional\s*network|\bgeo\b|geo-?intel|stress\s*map|learning\s*engine|calibration|deep\s*dive|full\s*analysis|risk\s*report|audit\s*trail|compare\s*scenarios|what\s*if)\b/i;

const OPS_PRIORITIZE =
    /\b(priorit|what\s+should\s+i\s+do\s+first|order\s+of\s+work|sequence\s+my|tackle\s+first)\b/i;

const SUBSTANTIVE = /\b(why|how\s+(do|does|can|should|much|long)|explain|what\s+(causes|is\s+the\s+best|should\s+i)|recommend|priorit|troubleshoot|diagnos|symptom|treatment|dose|rate\s*of)\b/i;

/**
 * @typedef {'fast'|'analytical'|'deep'} CognitiveLayer
 * @typedef {'off'|'standard'|'rich'} LlmTier
 *
 * @typedef {Object} CognitiveStages
 * @property {boolean} environmental
 * @property {boolean} yieldOutlook
 * @property {'none'|'threats_only'|'full'} recommendations
 * @property {boolean} twinBrief
 * @property {boolean} learningDigest
 * @property {number} regionalBriefMaxChars — cap passed into LLM bundle (snapshot text already loaded; trim at bundle time)
 *
 * @typedef {Object} CognitivePlan
 * @property {CognitiveLayer} layer
 * @property {0|1|2|3} reasoningDepth — 0 = weather_quick style; 1 = light farm pass; 2 = analytical; 3 = deep
 * @property {CognitiveStages} stages
 * @property {LlmTier} llmTier
 * @property {boolean} verificationPass
 */

/** @returns {CognitivePlan} */
export function planForWeatherQuick() {
    return {
        layer: "fast",
        reasoningDepth: 0,
        stages: {
            environmental: false,
            yieldOutlook: false,
            recommendations: "none",
            twinBrief: false,
            learningDigest: false,
            regionalBriefMaxChars: 0,
        },
        llmTier: "off",
        verificationPass: false,
    };
}

const INTENT_KEYS = ["weather", "pest", "disease", "yellow", "yield", "field", "scan", "operations"];

/**
 * @param {object} opts
 * @param {string} opts.question
 * @param {'full'|'weather_quick'} opts.routingMode
 * @param {Record<string, boolean>} opts.intents
 * @param {boolean} [opts.hasImage]
 * @param {import('./conversation-flow.js').FlowSnapshot | null} [opts.flowSnapshot]
 * @returns {CognitivePlan}
 */
export function buildCognitivePlan(opts) {
    const qRaw = String(opts.question || "");
    const q = qRaw.trim();
    const routingMode = opts.routingMode || "full";
    const intents = opts.intents || {};
    const flow = opts.flowSnapshot || null;

    if (routingMode === "weather_quick") {
        return planForWeatherQuick();
    }

    const hasImage = !!opts.hasImage;
    const intentCount = INTENT_KEYS.filter((k) => intents[k]).length;

    let depth = 1;
    if (hasImage) depth = 2;

    const deepQ = DEEP_PIPELINE.test(q) || /\b(regional|outbreak|network|epidemic\s+curve)\b/i.test(q);
    const substantive = SUBSTANTIVE.test(q.toLowerCase());
    const opsPrioritize = OPS_PRIORITIZE.test(q) && (intents.operations || /\b(task|intervention|spray|scout)\b/i.test(q));

    if (deepQ) depth = 3;
    else if (opsPrioritize) depth = Math.max(depth, 2);
    else if (substantive && (intents.disease || intents.pest || intents.yield)) depth = Math.max(depth, 2);
    else if (intents.yield && q.length > 40) depth = Math.max(depth, 2);
    else if ((intents.disease || intents.pest) && q.length > 72) depth = Math.max(depth, 2);
    else if (substantive && q.length > 50) depth = Math.max(depth, 2);
    else if (intentCount >= 3 && q.length > 60) depth = Math.max(depth, 2);

    if (flow?.prefersDepth && depth < 3) depth = Math.min(3, depth + 1);
    if (flow?.prefersConcise && !substantive && !deepQ && depth > 1) depth = Math.max(1, depth - 1);

    if (hasImage && depth < 2) depth = 2;

    /** @type {CognitiveLayer} */
    let layer = "analytical";
    if (depth <= 1) layer = "fast";
    if (depth >= 3) layer = "deep";

    const stages = {
        environmental: depth >= 2,
        yieldOutlook: depth >= 3 || !!(intents.yield && depth >= 2),
        recommendations: /** @type {'none'|'threats_only'|'full'} */ (
            depth <= 0 ? "none" : depth === 1 ? "threats_only" : "full"
        ),
        twinBrief: depth >= 2,
        learningDigest: depth >= 2,
        regionalBriefMaxChars: depth >= 3 ? 1400 : depth >= 2 ? 720 : 360,
    };

    if (opsPrioritize && !deepQ) {
        stages.twinBrief = false;
    }

    /** @type {LlmTier} */
    let llmTier = "off";
    if (depth >= 3) llmTier = "rich";
    else if (depth === 2) llmTier = "standard";
    /* depth 1: deterministic engines only — avoids overthinking simple farm pings */

    const verificationPass = depth >= 2 || !!(flow && flow.thinkingAloudBias);

    return {
        layer,
        reasoningDepth: /** @type {0|1|2|3} */ (Math.max(0, Math.min(3, depth))),
        stages,
        llmTier,
        verificationPass,
    };
}

/**
 * Compact, JSON-safe summary for logs / Firestore (no functions).
 * @param {CognitivePlan} plan
 */
export function summarizeCognitivePlan(plan) {
    if (!plan) return null;
    return {
        layer: plan.layer,
        reasoningDepth: plan.reasoningDepth,
        llmTier: plan.llmTier,
        verificationPass: plan.verificationPass,
        stages: { ...plan.stages },
    };
}
