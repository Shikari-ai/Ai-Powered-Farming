/**
 * Lightweight conversational flow state (session + compact persisted hints).
 * Heuristic only — no profiling. Voice/copilot-safe: export plain snapshots.
 */

const FLOW_KEY = "agri_conv_flow_v1";

function load() {
    try {
        return JSON.parse(sessionStorage.getItem(FLOW_KEY) || "{}");
    } catch {
        return {};
    }
}

function save(s) {
    try {
        sessionStorage.setItem(FLOW_KEY, JSON.stringify(s));
    } catch {
        /* private mode */
    }
}

/**
 * Call once per user send (after validation).
 * @param {{ text: string, hadPriorStreamInterrupt?: boolean }} opts
 */
export function recordFlowUserTurn(opts) {
    const text = String(opts.text || "");
    const len = text.length;
    const now = Date.now();
    const s = load();
    const gap = typeof s.lastUserAt === "number" ? now - s.lastUserAt : null;

    s.lastUserAt = now;
    s.turnCount = (s.turnCount || 0) + 1;

    const prevEma = typeof s.emaUserLen === "number" ? s.emaUserLen : len;
    s.emaUserLen = prevEma * 0.62 + len * 0.38;

    if (gap != null && gap < 4000 && len < 120) {
        s.rapidStreak = (s.rapidStreak || 0) + 1;
    } else if (gap != null && gap > 90000) {
        s.rapidStreak = 0;
    }

    if (opts.hadPriorStreamInterrupt) {
        s.interruptCount = (s.interruptCount || 0) + 1;
    }

    const low = text.toLowerCase();
    if (/\b(vpd|rhizosphere|fungicide|calibrat|hectare|deficien|etiolog|ipm|systemic|strobilurin|necrosis)\b/i.test(text)) {
        s.techSignals = (s.techSignals || 0) + 1;
    }
    if (/\b(lol|lmao|haha|heh)\b/i.test(low) || /^🙂|^😅/.test(text.trim())) {
        s.humorHits = (s.humorHits || 0) + 1;
    }
    if (/\b(urgent|asap|now\b|hurry|emergency)\b/i.test(low)) {
        s.urgencyHits = (s.urgencyHits || 0) + 1;
    }
    if (/[.]{3,}|…|umm\b|uh\b|i think|maybe|not sure/i.test(low)) {
        s.thinkingAloud = (s.thinkingAloud || 0) + 1;
    }

    save(s);
}

/** @returns {import('./conversation-flow.js').FlowSnapshot} */
export function getFlowSnapshot() {
    const s = load();
    const tc = s.turnCount || 0;
    const ema = typeof s.emaUserLen === "number" ? s.emaUserLen : 72;
    const tech = s.techSignals || 0;
    const prefersDepth = tc >= 2 && (tech / Math.max(1, tc)) > 0.28;
    const prefersConcise = tc >= 2 && ema < 58 && !prefersDepth;
    const rapidFire = (s.rapidStreak || 0) >= 2;
    const reflective = ema > 128 || (s.thinkingAloud || 0) >= 2;
    /** @type {'brisk'|'settled'|'medium'} */
    let energy = "medium";
    if (rapidFire) energy = "brisk";
    else if (reflective) energy = "settled";

    return {
        emaUserLen: ema,
        turnCount: tc,
        rapidFire,
        reflective,
        prefersDepth,
        prefersConcise,
        interruptProne: (s.interruptCount || 0) >= 2,
        humorOk: (s.humorHits || 0) >= 1,
        urgencyLean: (s.urgencyHits || 0) >= 2,
        thinkingAloudBias: (s.thinkingAloud || 0) >= 2,
        energy,
        suppressAuxiliary:
            (prefersConcise && tc >= 2) || (s.interruptCount || 0) >= 3 || ((s.urgencyHits || 0) >= 1 && rapidFire),
    };
}

/**
 * @typedef {Object} FlowSnapshot
 * @property {number} emaUserLen
 * @property {number} turnCount
 * @property {boolean} rapidFire
 * @property {boolean} reflective
 * @property {boolean} prefersDepth
 * @property {boolean} prefersConcise
 * @property {boolean} interruptProne
 * @property {boolean} humorOk
 * @property {boolean} urgencyLean
 * @property {boolean} thinkingAloudBias
 * @property {'brisk'|'settled'|'medium'} energy
 * @property {boolean} suppressAuxiliary
 */

/**
 * @param {{ routingMode: string, profile?: object | null, flow?: ReturnType<typeof getFlowSnapshot>, userText?: string }} opts
 * @returns {'minimal'|'compact'|'full'}
 */
export function resolveReplyVerbosity(opts) {
    const routingMode = opts.routingMode || "full";
    if (routingMode === "weather_quick") return "minimal";
    if (routingMode === "operations_quick") return "compact";
    if (routingMode !== "full") return "full";

    const profile = opts.profile || {};
    const flow = opts.flow || getFlowSnapshot();
    const hinted = profile.flowHints;

    const userTextTrim = String(opts.userText || "").trim();
    if (userTextTrim) {
        const wc = userTextTrim.split(/\s+/).filter(Boolean).length;
        if (
            userTextTrim.length < 104 &&
            wc <= 12 &&
            !flow.prefersDepth &&
            !/\b(why|how\s+come|explain|simulate|forecast|scenario|digital\s+twin|stress\s+test)\b/i.test(userTextTrim)
        ) {
            return "compact";
        }
    }

    if (profile.explanationStyle === "concise" || hinted?.bias === "concise") return "compact";
    if (profile.explanationStyle === "detailed" || hinted?.bias === "deep") return "full";
    if (flow.prefersConcise && !flow.prefersDepth) return "compact";
    if (flow.prefersDepth) return "full";
    if (flow.emaUserLen < 52 && flow.turnCount >= 3) return "compact";
    return "full";
}

/**
 * Slow-moving explainable prefs merged into companion_profiles.
 * @param {object} profile normalized companion profile (may include prior flowHints)
 * @param {ReturnType<typeof getFlowSnapshot>} flow
 */
export function computeFlowHintsForProfile(profile, flow) {
    if (!flow || (flow.turnCount || 0) < 2) return profile?.flowHints || null;

    const prev = profile?.flowHints;
    const avg = Math.round(flow.emaUserLen || 60);
    let bias = "balanced";
    if (flow.prefersConcise && !flow.prefersDepth) bias = "concise";
    if (flow.prefersDepth || avg > 135) bias = "deep";

    const sampleN = Math.min(72, ((prev && prev.sampleN) || 0) + 1);
    let nextBias = bias;
    if (prev && prev.bias && prev.bias !== bias && sampleN % 3 !== 0) {
        nextBias = prev.bias;
    }

    return {
        avgUserChars: avg,
        bias: nextBias,
        sampleN,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * For voice / copilot: neutral labels only.
 * @param {ReturnType<typeof getFlowSnapshot>} flow
 */
export function flowVoiceHints(flow) {
    if (!flow) return { pace: "normal", depthHint: "balanced" };
    const pace = flow.rapidFire ? "brisk" : flow.reflective ? "settled" : "normal";
    const depthHint = flow.prefersDepth ? "more_detail" : flow.prefersConcise ? "brief" : "balanced";
    return { pace, depthHint };
}

/**
 * Optional streaming rhythm hint (full path). When omitted, assistant-stream uses content-based detection.
 * @param {ReturnType<typeof getFlowSnapshot> | null | undefined} flow
 * @param {string} streamProfile routing mode
 * @returns {"operational"|"thoughtful"|"balanced"|undefined}
 */
export function streamRhythmPreference(flow, streamProfile) {
    if (
        !flow ||
        streamProfile === "casual" ||
        streamProfile === "micro_social" ||
        streamProfile === "clarify" ||
        streamProfile === "weather_quick" ||
        streamProfile === "operations_quick"
    ) {
        return undefined;
    }
    if (flow.urgencyLean || (flow.rapidFire && flow.emaUserLen < 68)) return "operational";
    if (flow.reflective || flow.prefersDepth) return "thoughtful";
    return undefined;
}
