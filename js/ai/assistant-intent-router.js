/**
 * Lightweight intent / complexity router for the assistant (heuristics only — no LLM).
 * Gates full agricultural orchestration so greetings stay human and cheap.
 */
import { detectIntents } from "./detect-intents.js";
import { pickRotated } from "./conversation-naturals.js?v=48";

const AGRI_TOKEN =
    /\b(field|fields|crop|crops|scans?|pest|pests|disease|diseases|fungal|blight|rust|mildew|rot|aphid|thrips|nematode|irrigation|irrigat|spray|fungicide|pesticide|herbicide|rain|humidity|soil|moisture|yield|harvest|acre|hectare|nitrogen|fertil|deficien|tomato|potato|wheat|rice|corn|maize|cotton|soy|canopy|ndvi|scouting)\b/i;

const DEEP_PIPELINE =
    /\b(simulat|simulation|digital\s*twin|\btwin\b|forecast|outbreak|epidemic|regional\s*network|\bgeo\b|geo-?intel|stress\s*map|learning\s*engine|calibration|deep\s*dive|full\s*analysis|risk\s*report|audit\s*trail|compare\s*scenarios|what\s*if)\b/i;

/** User is asking for substantive reasoning, not a wave. */
const SUBSTANTIVE =
    /\b(why|how\s+(do|does|can|should|much|long)|explain|what\s+(causes|is\s+the\s+best|should\s+i)|recommend|priorit|troubleshoot|diagnos|symptom|treatment|dose|rate\s*of)\b/i;

const POSITIVE_CHECKIN =
    /\b(looks?\s+better|finally(\s+\w+){0,3}\s+better|recover|recovering|bouncing\s+back|picking\s+up|improved|much\s+better|turning\s+(around|a\s+corner)|on\s+the\s+mend)\b/i;

/** Short “it worked” / relief — micro-ack, not a farm briefing. */
const OUTCOME_AFFIRM =
    /\b(that\s+)?(actually\s+)?worked|it\s+worked|that\s+did\s+it|that\s+helped|fixed(\s+it)?|sorted|resolved|all\s+good(\s+now)?|made\s+a\s+difference|good\s+call|paid\s+off\b/i;

const VAGUE_WORRY = /\b(weird|off|wrong|looks?\s+bad|not\s+right|something['’]s?\s+off|strange|funny\s+(looking)?)\b/i;

/** “Weather in Mumbai” needs full orchestration; weather_quick is farm-anchor only and felt like a broken reply. */
function isNamedPlaceWeatherQuery(text) {
    const t = String(text || "");
    if (!/\bweather\b/i.test(t)) return false;
    return /\b(in|at|near|for)\s+[A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s.-]{2,40}\b/.test(t);
}

const SPECIFIC_SYMPTOM =
    /\b(yellow|chloros|spot|spots|mold|mildew|rust|blight|wilt|hole|chew|aphid|thrips|mite|bug|larvae|worm|rot|canker|curl|necrosis|stunt|stem\s+bore)\b/i;

function isOutcomeAffirmMicro(text) {
    const t = String(text || "").trim();
    if (t.length > 100) return false;
    if (DEEP_PIPELINE.test(t) || SUBSTANTIVE.test(t)) return false;
    return OUTCOME_AFFIRM.test(t);
}

function isPositiveFarmShort(text) {
    const t = String(text || "").trim();
    if (t.length > 200) return false;
    if (!AGRI_TOKEN.test(t)) return false;
    if (SUBSTANTIVE.test(t) || DEEP_PIPELINE.test(t)) return false;
    if (!POSITIVE_CHECKIN.test(t)) return false;
    return true;
}

function isVagueSymptomClarify(text) {
    const t = String(text || "").trim();
    if (t.length > 220) return false;
    if (!AGRI_TOKEN.test(t)) return false;
    if (!VAGUE_WORRY.test(t)) return false;
    if (SUBSTANTIVE.test(t) || SPECIFIC_SYMPTOM.test(t)) return false;
    const intents = detectIntents(t);
    const onlyWeatherShort =
        t.length <= 100 &&
        intents.weather &&
        !intents.disease &&
        !intents.pest &&
        !intents.yield &&
        !intents.scan &&
        !intents.field;
    if (onlyWeatherShort) return false;
    return true;
}

/**
 * @param {string} rawText
 * @param {{ hasImage?: boolean }} opts
 * @returns {{ mode: "casual" | "clarify" | "weather_quick" | "full", reason: string }}
 */
export function classifyAssistantRouting(rawText, opts = {}) {
    const hasImage = !!opts.hasImage;
    const text = String(rawText || "").trim();

    if (hasImage) {
        return { mode: "full", reason: "attachment_requires_vision_path" };
    }
    if (!text) {
        return { mode: "casual", reason: "empty_text" };
    }

    if (DEEP_PIPELINE.test(text) || SUBSTANTIVE.test(text)) {
        return { mode: "full", reason: "deep_or_substantive" };
    }

    if (isNamedPlaceWeatherQuery(text)) {
        return { mode: "full", reason: "named_place_weather_needs_full_context" };
    }

    if (isOutcomeAffirmMicro(text)) {
        return { mode: "casual", reason: "outcome_affirm" };
    }

    if (isPositiveFarmShort(text)) {
        return { mode: "casual", reason: "positive_farm_checkin" };
    }

    if (isVagueSymptomClarify(text)) {
        return { mode: "clarify", reason: "vague_symptom" };
    }

    if (AGRI_TOKEN.test(text) && !isCasualAgriculturalPleasantry(text)) {
        const intents = detectIntents(text);
        const short = text.length <= 100;
        if (
            short &&
            intents.weather &&
            !intents.disease &&
            !intents.pest &&
            !intents.yield &&
            !intents.scan &&
            !intents.field
        ) {
            return { mode: "weather_quick", reason: "short_weather_only" };
        }
        return { mode: "full", reason: "farm_content" };
    }

    if (isCasualMessage(text)) {
        return { mode: "casual", reason: "greeting_or_ack" };
    }

    if (text.length <= 140 && !AGRI_TOKEN.test(text)) {
        return { mode: "casual", reason: "short_non_farm" };
    }

    return { mode: "full", reason: "default" };
}

/** “Thanks — weather looks good” still has agri token; keep conversational. */
function isCasualAgriculturalPleasantry(text) {
    const t = text.toLowerCase();
    return /^(thanks|thank\s*you|thx|ty)\b/.test(t) && t.length < 72;
}

function isCasualMessage(raw) {
    const t = raw.trim().replace(/[!.?…]+$/u, "").replace(/\s+/g, " ").trim();
    if (t.length > 88) return false;
    if (AGRI_TOKEN.test(t) && !isCasualAgriculturalPleasantry(raw)) return false;

    if (/^(hi|hello|hey|yo|hiya|howdy|greetings)\b/i.test(t)) return true;
    if (/^good\s*(morning|afternoon|evening|night|day)\b/i.test(t)) return true;
    if (/^(thanks|thank\s*you|thx|ty|much\s*appreciated)\b/i.test(t)) return true;
    if (/^(ok{1,3}|okay|k\b|cool|nice|great|perfect|awesome|sweet)\b/i.test(t)) return true;
    if (/^(sure|yep|yeah|yup|righto|alright)\b/i.test(t)) return true;
    if (/^(sounds?\s*good|got\s*it|makes\s+sense)\b/i.test(t)) return true;
    if (/^no\s*(problem|worries)|\bnp\b|^cheers\b/i.test(t)) return true;
    if (/^how\s*(are|r)\s*(you|u)\b/i.test(t)) return true;
    if (/^(what'?s\s*up|wassup|sup\b)\b/i.test(t)) return true;
    if (/^(bye|goodbye|cya|see\s*you|later)\b/i.test(t)) return true;
    if (/^(lol|lmao|haha|ha{2,})\b/i.test(t)) return true;

    return false;
}

/**
 * Short, warm reply for casual turns (no orchestration).
 * @param {string} text
 * @param {{ fieldCount?: number, scanCount?: number }} ctx
 */
export function buildCasualAssistantReply(text, ctx = {}) {
    const t = String(text || "").trim().toLowerCase();
    const raw = String(text || "").trim();
    const fc = typeof ctx.fieldCount === "number" ? ctx.fieldCount : 0;
    const sc = typeof ctx.scanCount === "number" ? ctx.scanCount : 0;

    if (isOutcomeAffirmMicro(raw)) {
        return pickRotated("outcome_micro", [
            "Nice.",
            "That’s good to hear.",
            "Glad it helped.",
            "Good — glad that landed.",
            "Sounds like you’re in a better spot.",
            "Worth a quiet win.",
            "Good to know it paid off.",
            "Happy that worked out.",
        ]);
    }

    if (POSITIVE_CHECKIN.test(t) && AGRI_TOKEN.test(t) && t.length < 200) {
        return pickRotated("pos_farm", [
            "That’s great to hear — sounds like things are moving in a good direction.",
            "Nice — glad it’s looking better out there.",
            "Love hearing that. If anything slips again, send a quick note or a photo.",
            "That’s a relief. Keep an eye on humidity and any new spots, but enjoy the win.",
        ]);
    }

    if (/^(bye|goodbye|cya|see\s*you)/.test(t)) {
        return pickRotated("bye", [
            "Take care out there — tap me when you’re back.",
            "Later — good luck in the field today.",
            "All the best — I’m around when you need a second read on things.",
        ]);
    }
    if (/^(thanks|thank|thx|ty)\b/.test(t) || t.includes("🙏")) {
        return pickRotated("thanks", [
            "Anytime.",
            "Glad I could help.",
            "You’re welcome — shout if something changes.",
        ]);
    }
    if (/^how\s*(are|r)\s*(you|u)/.test(t)) {
        return pickRotated("howru", [
            "Doing well, thanks — how are things on your side?",
            "All good here. What’s the farm looking like for you today?",
            "I’m ready when you are — what’s on your mind?",
        ]);
    }
    if (/^good\s*(morning|afternoon|evening|night|day)\b/.test(t)) {
        return pickRotated("greet_day", [
            "Hey — how’s it going out there?",
            "Hi there. Want weather, pests, or something else today?",
            "Morning/afternoon — what do you want to tackle first?",
        ]);
    }
    if (/^(lol|haha|ha)/.test(t)) {
        return pickRotated("lol", [
            "Ha — okay. Farm stuff whenever you’re ready.",
            "Fair enough. Need anything practical on the crop?",
        ]);
    }

    const onboard =
        fc === 0 && sc === 0
            ? " Add a field and save a scan when you can — I’ll hook answers to your real numbers."
            : sc === 0
              ? " A fresh scan will make tips a lot sharper."
              : "";

    return (
        pickRotated("open_chat", [
            `Hey! How’s the farm today?${onboard}`,
            `Hi — what do you want to look at?${onboard}`,
            `What’s up? I can go light or deep on weather, pests, irrigation, or fields.${onboard}`,
        ]) + pickRotated("open_tail", ["", " Keep it to one sentence if you like; I’ll match your pace."])
    );
}

/**
 * Clarifying turn for “something looks off” without enough detail — no orchestration.
 * @param {string} text
 * @param {{ fieldCount?: number, scanCount?: number }} ctx
 */
export function buildVagueSymptomReply(text, ctx = {}) {
    const sc = typeof ctx.scanCount === "number" ? ctx.scanCount : 0;
    const photoHint = sc ? "If you have a clear leaf photo, attach it next — that helps a lot." : "A saved scan or a clear leaf photo makes the next step much easier.";
    return pickRotated("vague_sym", [
        `Hmm — what are you noticing exactly? Yellowing, spots, wilting, holes, or something else? ${photoHint}`,
        `Got it. Can you narrow it down — color change, texture, pattern on the leaf, or spread in the row? ${photoHint}`,
        `Tell me a bit more about “off”: where on the plant, how fast it showed up, and the crop? ${photoHint}`,
    ]);
}
