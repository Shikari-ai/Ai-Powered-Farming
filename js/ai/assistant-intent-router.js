/**
 * Lightweight intent / complexity router for the assistant (heuristics only — no LLM).
 * Gates full agricultural orchestration so greetings stay human and cheap.
 */
import { detectIntents } from "./detect-intents.js";

const AGRI_TOKEN =
    /\b(field|fields|crop|crops|scans?|pest|pests|disease|diseases|fungal|blight|rust|mildew|rot|aphid|thrips|nematode|irrigation|irrigat|spray|fungicide|pesticide|herbicide|rain|humidity|soil|moisture|yield|harvest|acre|hectare|nitrogen|fertil|deficien|tomato|potato|wheat|rice|corn|maize|cotton|soy|canopy|ndvi|scouting)\b/i;

const DEEP_PIPELINE =
    /\b(simulat|simulation|digital\s*twin|\btwin\b|forecast|outbreak|epidemic|regional\s*network|\bgeo\b|geo-?intel|stress\s*map|learning\s*engine|calibration|deep\s*dive|full\s*analysis|risk\s*report|audit\s*trail|compare\s*scenarios|what\s*if)\b/i;

/** User is asking for substantive reasoning, not a wave. */
const SUBSTANTIVE =
    /\b(why|how\s+(do|does|can|should|much|long)|explain|what\s+(causes|is\s+the\s+best|should\s+i)|recommend|priorit|troubleshoot|diagnos|symptom|treatment|dose|rate\s*of)\b/i;

/**
 * @param {string} rawText
 * @param {{ hasImage?: boolean }} opts
 * @returns {{ mode: "casual" | "weather_quick" | "full", reason: string }}
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
    const fc = typeof ctx.fieldCount === "number" ? ctx.fieldCount : 0;
    const sc = typeof ctx.scanCount === "number" ? ctx.scanCount : 0;

    if (/^(bye|goodbye|cya|see\s*you)/.test(t)) {
        return "Take care out in the field. Ping me when you’re back.";
    }
    if (/^(thanks|thank|thx|ty)\b/.test(t) || t.includes("🙏")) {
        return "Glad to help. If anything shifts in the weather or the crop, just ask.";
    }
    if (/^how\s*(are|r)\s*(you|u)/.test(t)) {
        return "Doing well — ready to help with your farm when you need it. How are things looking for you today?";
    }
    if (/^good\s*(morning|afternoon|evening|night|day)\b/.test(t)) {
        return "Good day — how’s the farm? Ask about weather, pests, or irrigation whenever you want specifics.";
    }
    if (/^(lol|haha|ha)/.test(t)) {
        return "Ha — I’m here when you want to get practical. Anything on your mind for the crop?";
    }

    const onboard =
        fc === 0 && sc === 0
            ? " When you add a field and save a scan, I can tie answers to your real data."
            : sc === 0
              ? " Your next scan will make weather and pest tips much more specific."
              : "";

    return `Hey! How’s your farm looking today?${onboard} Ask about weather, irrigation, pests, or a field anytime — I’ll keep it concise unless you want the full breakdown.`;
}
