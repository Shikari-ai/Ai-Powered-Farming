/**
 * Conversational polish: phrase rotation (session-scoped), mood hints, and soft de-rigor of report-like prose.
 * Keeps agricultural intelligence intact while sounding more human in the UI layer.
 */

const ROT_KEY = "agri_conv_phrase_rot_v1";

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
 * @param {{ mood?: string, routingMode?: string }} [opts]
 */
export function polishFarmReportProse(text, opts = {}) {
    let s = String(text || "");
    if (!s.trim()) return s;

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

    const mood = opts.mood || "neutral";
    if (mood === "worry" && !/^I hear you|take this step by step/i.test(s)) {
        s = pickRotated("worry_prefix", ["Let’s take this calmly — ", "We can work through this — ", "Staying practical: "]) + s.replace(/^\s+/, "");
    }

    return s.trim();
}
