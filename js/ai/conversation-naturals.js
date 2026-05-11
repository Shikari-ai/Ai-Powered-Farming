/**
 * Conversational polish: phrase rotation (session-scoped), mood hints, and soft de-rigor of report-like prose.
 * Keeps agricultural intelligence intact while sounding more human in the UI layer.
 */

const ROT_KEY = "agri_conv_phrase_rot_v1";

/** Last-N assistant opener fingerprints (bridge / first spoken line rotation). No PII. */
const OPENERS_RING_KEY = "agri_conv_reply_openings_v1";
const OPENERS_MAX = 12;

/** @returns {string} */
function normalizeOpenerKey(line) {
    return String(line || "")
        .trim()
        .replace(/\*\*/g, "")
        .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 88);
}

/**
 * Fingerprints opening text for avoidance matching.
 * @param {string} line
 */
export function openerFingerprint(line) {
    const k = normalizeOpenerKey(line);
    return k.length >= 12 ? k : "";
}

/**
 * Plain strings matched against `peekRecentAssistantOpenings()`.
 */
export function peekRecentAssistantOpenings(max = OPENERS_MAX) {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(OPENERS_RING_KEY) || "[]");
        if (!Array.isArray(parsed)) return [];
        const out = parsed.filter((x) => typeof x === "string" && x.length > 10);
        return out.slice(Math.max(0, out.length - max));
    } catch {
        return [];
    }
}

/**
 * @param {string} fullReply assistant text after assemble (often multi-line).
 */
export function pushRecentAssistantOpening(fullReply) {
    const flat = String(fullReply || "").split(/\n/).map((s) => s.trim()).find(Boolean);
    if (!flat) return;
    const fp = openerFingerprint(flat.slice(0, 140));
    if (!fp) return;
    const prev = peekRecentAssistantOpenings(OPENERS_MAX * 2);
    const merged = [...prev.filter((x) => x !== fp), fp];
    const next = merged.slice(Math.max(0, merged.length - OPENERS_MAX));
    try {
        sessionStorage.setItem(OPENERS_RING_KEY, JSON.stringify(next));
    } catch {
        /* private mode */
    }
}

/**
 * @returns {boolean}
 */
export function openerWasRecentlyUsed(sentenceVariant) {
    const fp = openerFingerprint(sentenceVariant);
    if (!fp) return false;
    const recent = new Set(peekRecentAssistantOpenings());
    return recent.has(fp);
}

function rotState() {
    try {
        return JSON.parse(sessionStorage.getItem(ROT_KEY) || "{}");
    } catch {
        return {};
    }
}

function rotSave(state) {
    try {
        sessionStorage.setItem(ROT_KEY, JSON.stringify(state));
    } catch {
        /* private mode */
    }
}

/**
 * @param {string} category
 * @param {string[]} variants
 */
export function pickRotated(category, variants) {
    const arr = variants.filter((v) => typeof v === "string" && v.length);
    if (!arr.length) return "";
    const st = rotState();
    const recent = st[category] || [];
    const avoid = new Set(recent.slice(-6));
    const pool = arr.filter((v) => !avoid.has(v));
    const choices = pool.length ? pool : arr;
    const pick = choices[Math.floor(Math.random() * choices.length)];
    recent.push(pick);
    st[category] = recent.slice(-14);
    rotSave(st);
    return pick;
}

/**
 * @param {string} text
 */
export function detectConversationMood(text) {
    const t = String(text || "").toLowerCase();
    if (/thank|thx|ty\b|appreciat|grateful/.test(t)) return "gratitude";
    if (/\b(worried|scared|panic|urgent|help|dying|disaster|freaking)\b/.test(t)) return "worry";
    if (/\b(better|great|good news|relieved|finally|recover|improved|bounce|progress)\b/.test(t)) return "positive";
    if (/^(lol|lmao|haha)/.test(t)) return "joking";
    return "neutral";
}

const HDR_REPLACERS = [
    [/^Weather intelligence:\s*/gim, ["Weather-wise:\n", "Here’s the weather readout:\n", "On weather:\n"]],
    [/^Pest outlook:\s*/gim, ["Pest side:\n", "On pests:\n", "Scouting/pests:\n"]],
    [/^Prioritized actions:\s*/gim, ["Worth doing next:\n", "Practical next steps:\n", "If you prioritize:\n"]],
    [
        /^Farm operations \(you execute all field work[^\n]*\):\s*/gim,
        ["Quick ops snapshot:\n", "What’s moving on-farm:\n", "Chores and operations:\n"],
    ],
    [/^Digital twin \(simulated week[^\n]*\):\s*/gim, ["Digital twin sketch (not certainty):\n", "Quick twin contrast:\n", "Twin simulation (illustrative):\n"]],
    [/^Learning \/ knowledge evolution:\s*/gim, ["Learning notes from your timeline:\n", "What the app has learned (bounded):\n", "Adaptive notes:\n"]],
    [/^Regional network context[^\n]*:\s*/gim, ["Regional backdrop (coarse):\n", "Wider area context:\n", "Neighborhood signal:\n"]],
];

const VOICEY_REPLACERS = [
    [/\bBased on current data,?\s*/gi, ["From what’s in your account, ", "From your latest saved signals, ", "Given what we have on file, "]],
    [/\bIt appears that\s+/gi, ["It looks like ", "Seems like ", "Sounds like "]],
    [/\bAccording to analysis,?\s*/gi, ["From the engines, ", "From the analysis pass, ", ""]],
    [/\bRecovery metrics indicate\b/gi, ["Things seem to be trending", "Reads like progress", "Signals suggest"]],
    [/\bModerate probability detected\b/gi, ["There’s a moderate chance", "Moderate odds", "Somewhere in the middle of the risk range"]],
    [/\bStatus:\s+/gi, ["Heads-up: ", "Note: ", "Quick status: "]],
];

/**
 * @param {string} text
 * @param {{ mood?: string, routingMode?: string, naturalMicro?: boolean }} [opts]
 */
export function polishFarmReportProse(text, opts = {}) {
    let s = String(text || "");
    if (!s.trim()) return s;

    if (
        opts.naturalMicro ||
        opts.routingMode === "micro_social" ||
        opts.routingMode === "casual" ||
        opts.routingMode === "clarify" ||
        opts.routingMode === "operations_quick"
    ) {
        return s.trim();
    }

    for (let i = 0; i < HDR_REPLACERS.length; i++) {
        const [re, list] = HDR_REPLACERS[i];
        s = s.replace(re, () => pickRotated(`hdr_${i}`, list));
    }

    for (let i = 0; i < VOICEY_REPLACERS.length; i++) {
        const [re, variants] = VOICEY_REPLACERS[i];
        s = s.replace(re, () => {
            const picks = variants.filter(Boolean);
            if (!picks.length) return "";
            return pickRotated(`voc_${i}`, picks);
        });
    }

    // Soften the hard separator when an LLM preface exists
    s = s.replace(
        /\n— Grounded engine summary \(verified inputs\) —\n/g,
        () => `\n${pickRotated("ground_sep", ["\n— Details from your saved farm inputs —\n", "\n— Under the hood (your data) —\n", "\n— Engine detail —\n"])}`,
    );

    // Trim accidental double spaces from replacements
    s = s.replace(/ {2,}/g, " ");

    // Thanks after a substantive answer: lighten the headline register slightly.
    if (opts.mood === "gratitude" && !opts.naturalMicro) {
        const softStatus = ["Note: ", "Quick note: ", "Heads-up: "];
        s = s.replace(/\b(Status|Quick\s+status|Heads-up):\s+/gi, () => `${pickRotated("gratitude_status", softStatus)}`);
    }

    const mood = opts.mood || "neutral";
    if (mood === "worry" && !/^I hear you|take this step by step/i.test(s)) {
        s = pickRotated("worry_prefix", ["Let’s take this calmly — ", "We can work through this — ", "Staying practical: "]) + s.replace(/^\s+/, "");
    }

    return s.trim();
}
