/**
 * Conversational presence: adaptive pre-stream timing, anti-mechanical pacing,
 * optional light memory nudges (no “as we discussed”), voice/copilot hints.
 */

const PACING_KEY = "agri_presence_pacing_v1";
const NUDGE_KEY = "agri_presence_nudge_v1";

function pacingState() {
    try {
        return JSON.parse(sessionStorage.getItem(PACING_KEY) || "{}");
    } catch {
        return {};
    }
}

function pacingSave(state) {
    try {
        sessionStorage.setItem(PACING_KEY, JSON.stringify(state));
    } catch {
        /* private mode */
    }
}

function nudgeState() {
    try {
        return JSON.parse(sessionStorage.getItem(NUDGE_KEY) || "{}");
    } catch {
        return {};
    }
}

function nudgeSave(state) {
    try {
        sessionStorage.setItem(NUDGE_KEY, JSON.stringify(state));
    } catch {
        /* private mode */
    }
}

/** @param {number} a @param {number} b */
function randBetween(a, b) {
    return a + Math.random() * (b - a);
}

/**
 * @typedef {Object} PresencePlan
 * @property {number} preStreamMs pause while typing indicator shows (after reply ready, before stream shell)
 * @property {number} streamLeadInMs extra beat before first streamed token
 * @property {'light'|'steady'|'deliberate'} voiceEnergy hint for future TTS / copilot
 */

/**
 * @param {{
 *   routingMode: string,
 *   userText: string,
 *   replyLength?: number,
 *   mood?: string,
 *   flowSnapshot?: import('./conversation-flow.js').FlowSnapshot | null,
 * }} opts
 * @returns {PresencePlan}
 */
export function computePresencePlan(opts) {
    const routingMode = opts.routingMode || "full";
    const userText = String(opts.userText || "");
    const replyLength = typeof opts.replyLength === "number" ? opts.replyLength : 0;
    const mood = opts.mood || "neutral";
    const flow = opts.flowSnapshot || null;

    let base = 200;
    let voiceEnergy = "steady";

    if (routingMode === "casual" || routingMode === "clarify") {
        voiceEnergy = "light";
        const brief = userText.trim().length < 42;
        if (/^(hi|hello|hey|yo|hiya|good\s+(morning|afternoon|evening))\b/i.test(userText.trim())) {
            base = randBetween(25, 95);
        } else if (mood === "gratitude" || /^(thanks|thx|ty)\b/i.test(userText.trim())) {
            base = randBetween(35, 110);
        } else if (brief && /\b(worked|helped|nice|cool|great)\b/i.test(userText.toLowerCase())) {
            base = randBetween(55, 160);
        } else {
            base = randBetween(90, 240);
        }
    } else if (routingMode === "weather_quick") {
        voiceEnergy = "steady";
        base = randBetween(130, 300);
    } else {
        voiceEnergy = "deliberate";
        base = randBetween(320, 640);
        if (replyLength > 900) base += randBetween(90, 260);
        if (replyLength > 1800) base += randBetween(70, 180);
        if (mood === "worry") base = Math.max(220, base * 0.88);
        if (/\b(urgent|asap|now|quick)\b/i.test(userText)) base = Math.min(base, randBetween(200, 380));
        if (flow?.energy === "brisk") base *= randBetween(0.78, 0.92);
        if (flow?.energy === "settled") base *= randBetween(1.04, 1.14);
    }

    const st = pacingState();
    const last = typeof st.lastPreMs === "number" ? st.lastPreMs : null;
    if (last != null && Math.abs(last - base) < 65) {
        base += randBetween(45, 160);
    }
    st.lastPreMs = Math.round(base);
    st.lastAt = Date.now();
    pacingSave(st);

    let streamLeadInMs = 0;
    if (routingMode === "full") {
        streamLeadInMs = randBetween(40, 160);
        if (mood === "worry") streamLeadInMs *= 0.75;
        if (flow?.energy === "brisk") streamLeadInMs *= randBetween(0.62, 0.88);
        if (flow?.energy === "settled") streamLeadInMs *= randBetween(1.05, 1.28);
    } else if (routingMode === "weather_quick") {
        streamLeadInMs = randBetween(18, 85);
    } else if (routingMode === "casual" || routingMode === "clarify") {
        streamLeadInMs = randBetween(0, 45);
    }

    return {
        preStreamMs: Math.min(1200, Math.max(0, Math.round(base))),
        streamLeadInMs: Math.min(320, Math.max(0, Math.round(streamLeadInMs))),
        voiceEnergy,
    };
}

export function sleep(ms) {
    const n = Math.max(0, Math.round(ms));
    if (!n) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * Very short clause tied to existing memory — rare, avoid “as we discussed”.
 * @param {object | null} profile normalized companion profile
 * @param {{ routingMode: string, userText: string, replyLength: number, fields?: object[], flowSnapshot?: import('./conversation-flow.js').FlowSnapshot | null }} ctx
 */
export function maybePresenceMemoryNudge(profile, ctx) {
    const routingMode = ctx.routingMode || "";
    if (routingMode !== "full" && routingMode !== "weather_quick") return "";
    if (ctx.flowSnapshot?.suppressAuxiliary && Math.random() < 0.72) return "";
    if ((ctx.replyLength || 0) < 120) return "";
    if (Math.random() > 0.36) return "";

    const p = profile || {};
    const topics = Array.isArray(p.lastTopics) ? p.lastTopics.filter(Boolean) : [];
    const episodes = Array.isArray(p.episodeArchive) ? p.episodeArchive : [];
    const recentEp = episodes.length ? episodes[episodes.length - 1] : null;

    if (!topics.length && !recentEp?.summary) return "";

    const ns = nudgeState();
    const lastKind = ns.kind || "";
    const now = Date.now();
    if (lastKind && typeof ns.at === "number" && now - ns.at < 45000 && Math.random() < 0.7) return "";

    const topic = topics[0] ? String(topics[0]).replace(/_/g, " ") : "";
    const field = (ctx.fields || []).find((f) => f && f.name)?.name || "";

    /** @type {{ kind: string, text: string }[]} */
    const pool = [];

    if (topic && field) {
        pool.push({
            kind: "tf",
            text: `If ${field} is still tilting toward ${topic} pressure, a dry-leaf scan usually tells the story quickly.`,
        });
    }
    if (topic) {
        pool.push({
            kind: "t",
            text: `Still on ${topic} — when you next scout, glance at lower canopy first; that’s where it often shows first.`,
        });
    }
    if (recentEp?.summary && String(recentEp.summary).length > 12) {
        const tail = String(recentEp.summary).replace(/\s+/g, " ").trim().slice(0, 72);
        pool.push({
            kind: "e",
            text: `Related to something you had open recently (${tail}) — only matters if that block is still on your mind.`,
        });
    }

    const filtered = pool.filter((x) => x.kind !== lastKind || pool.length === 1);
    if (!filtered.length) return "";

    const pick = filtered[Math.floor(Math.random() * filtered.length)];
    ns.kind = pick.kind;
    ns.at = now;
    nudgeSave(ns);

    return pick.text;
}

/**
 * For future voice / copilot runtimes (timing only, no audio here).
 * @param {PresencePlan} plan
 */
export function presenceVoiceHints(plan) {
    return {
        prePauseMs: plan.preStreamMs + plan.streamLeadInMs,
        energy: plan.voiceEnergy,
    };
}
