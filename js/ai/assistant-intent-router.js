/**
 * Lightweight intent / complexity router for the assistant (heuristics only — no LLM).
 * Gates full agricultural orchestration so greetings stay human and cheap.
 *
 * Conversational goals (uncertainty, follow-ups, tone): see `assistant-training-principles.js`.
 * Symptom heuristics rotate phrasing: `symptom-training-corpus.js` (behavioral intent, not fixed scripts).
 */
import { detectIntents } from "./detect-intents.js";
import { pickRotated } from "./conversation-naturals.js?v=48";
import { farmContextEmptyLead } from "./epistemic-policy.js?v=2";
import { matchSymptomTrainingReply } from "./symptom-training-corpus.js?v=76";

const AGRI_TOKEN =
    /\b(field|fields|farm|farms|crop|crops|scans?|pest|pests|disease|diseases|fungal|blight|rust|mildew|rot|aphid|thrips|nematode|irrigation|irrigat|spray|fungicide|pesticide|herbicide|rain|humidity|weather|soil|moisture|yield|harvest|acre|hectare|nitrogen|fertil|deficien|tomatoes?|potatoes?|wheat|rice|corn|maize|cotton|soy|canopy|ndvi|scouting)\b/i;

const DEEP_PIPELINE =
    /\b(simulat|simulation|digital\s*twin|\btwin\b|counterfactual|scenario|stress\s*test|forecast|outbreak|epidemic|regional\s*network|\bgeo\b|geo-?intel|stress\s*map|learning\s*engine|calibration|deep\s*dive|full\s*analysis|risk\s*report|audit\s*trail|compare\s*scenarios|what\s*if)\b/i;

/** Tasks / alerts / chores inventory — list-style, not “what should I spray”. */
const OPS_INVENTORY =
    /\b(my\s+)?open\s+tasks?\b|\btask\s+list\b|\bto-?dos?\b|\bwhat\s+tasks\b|\b(show|list)\s+(me\s+)?(my\s+)?tasks?\b|\brecent\s+interventions?\b|\b(my\s+)?interventions?\s+(logged|so\s+far|list|recorded)\b|\bunread\s+alerts?\b|\b(alerts?\s+pending|pending\s+alerts?)\b|\bwhat(?:'s|s|\s+is)\s+on\s+my\s+plate\b|\boperations?\s+snapshot\b|\bchore\s+list\b/i;

/** User is asking for substantive reasoning, not a wave. */
const SUBSTANTIVE =
    /\b(why|how\s+(do|does|can|should|much|long)|explain|what\s+(causes|is\s+the\s+best|should\s+i|i['']d)|recommend|priorit|troubleshoot|diagnos|symptom|treatment|dose|rate\s*of|plausible\s+causes|multi-?section|be\s+thorough)\b/i;

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

function isOperationalSnapshotOnly(text) {
    const t = String(text || "").trim();
    if (t.length > 200) return false;
    if (SUBSTANTIVE.test(t) || DEEP_PIPELINE.test(t)) return false;
    if (!OPS_INVENTORY.test(t)) return false;
    if (/\b(should\s+i|recommend|best\s+way|how\s+do\s+i|optimize|prioritiz|schedule\s+the)\b/i.test(t)) return false;
    const intents = detectIntents(t);
    if (intents.disease || intents.pest || intents.yield) return false;
    if (intents.weather && !/\b(alert|task|intervention|chore)\b/i.test(t)) return false;
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

function normMicroText(raw) {
    return raw
        .trim()
        .replace(/^[uh]+\s*[,.-]?\s*/i, "")
        .replace(/[!.?…]+$/u, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Tiny thanks / ok / bye / nano-acks — no orchestrator, minimal polish only. */
function isMicroSocialTurn(text) {
    const raw = String(text || "").trim();
    const t = normMicroText(raw);
    const lower = raw.toLowerCase();
    if (!t || raw.length > 92) return false;
    if (DEEP_PIPELINE.test(raw) || SUBSTANTIVE.test(raw)) return false;
    if (hasImageAttachedHint(raw)) return false;

    const agriPleasantry =
        (/^(thanks|thank\s*you|thx|ty)\b/.test(lower) && lower.length < 72) ||
        (/^(sure|yeah|yep|yup|ok+)\b/i.test(lower) && !AGRI_TOKEN.test(lower));

    if (AGRI_TOKEN.test(t) && !agriPleasantry && !/^nm\b|^no\s*[,.]?\s*worries|^np\b|^cheers\b/i.test(lower)) return false;

    const oneLine = !/\n/.test(raw) && raw.length <= 92;

    if (/^(thanks|thank\s*you|thx|ty|much\s+appreciated)\b/i.test(t) || t.includes("🙏")) {
        return oneLine;
    }
    if (/^(bye|goodbye|cya|see\s*you|later|ttyl)\b/i.test(t)) return oneLine;
    if (/^(ok{1,3}|okay|\bk\b|^k\.|cool|nice|great|perfect|awesome|sweet|rad)\b/i.test(t)) return oneLine;
    if (/^(sure|righto|\byep\b|\byup\b|^ya\b|alright|roger)\b/i.test(t)) return oneLine;
    if (/^(sounds?\s*good|got\s*it|makes\s+sense|\bi\s*hear\s*you|fair\s+enough|\bfair\b|^word\b)\b/i.test(t)) return oneLine;
    if (/^(no\s+(problem|worries)|^np\b|^cheers\b|^nm\b|not\s+much\b)\b/i.test(t)) return oneLine;

    const ackOnly =
        (/^(thanks|thank|thx|ty)\s*[!.]*$/i.test(t) &&
            (/weather|forecast|farm|crop|rain|spray\b/i.test(lower) === false ||
                (/^(thanks|thank\s*you|thx|ty)\b/i.test(lower) && lower.length < 40))) ||
        /^(yeah|yep)\s*[,.]?\s*(thanks|thx)$/i.test(t);

    return !!ackOnly && oneLine && t.length <= 72;
}

function hasImageAttachedHint(text) {
    return /\[(image|photo)\s+attached\]|\(\s*image\s+attached\s*\)/i.test(String(text || ""));
}

/**
 * @param {string} rawText
 * @param {{ hasImage?: boolean }} opts
 * @returns {{ mode: "micro_social" | "casual" | "clarify" | "operations_quick" | "weather_quick" | "full", reason: string }}
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

    if (isMicroSocialTurn(text)) {
        return { mode: "micro_social", reason: "micro_ack_or_social" };
    }

    if (isVagueSymptomClarify(text)) {
        return { mode: "clarify", reason: "vague_symptom" };
    }

    if (isOperationalSnapshotOnly(text)) {
        return { mode: "operations_quick", reason: "ops_inventory_only" };
    }

    if (AGRI_TOKEN.test(text) && !isCasualAgriculturalPleasantry(text)) {
        const intents = detectIntents(text);
        const short = text.length <= 160;
        if (
            short &&
            intents.weather &&
            !intents.disease &&
            !intents.pest &&
            !intents.yield &&
            !intents.scan &&
            !intents.field &&
            !intents.operations
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
    const t = text.toLowerCase().trim();
    if (!/^(thanks|thank\s*you|thx|ty)\b/.test(t)) return false;
    // Longer thanks still conversational unless they pivot into guidance questions.
    if (/\?/.test(text) || /\b(why|how\s+(do|should|can)|what\s+should\s+i)\b/i.test(t)) return false;
    return t.length < 128;
}

function isCasualMessage(raw) {
    if (isMicroSocialTurn(raw)) return false;

    const t = raw.trim().replace(/[!.?…]+$/u, "").replace(/\s+/g, " ").trim();
    if (t.length > 88) return false;
    if (AGRI_TOKEN.test(t) && !isCasualAgriculturalPleasantry(raw)) return false;

    if (/^(hi|hello|hey|yo|hiya|howdy|greetings)\b/i.test(t)) return true;
    if (/^good\s*(morning|afternoon|evening|night|day)\b/i.test(t)) return true;
    if (/^(thanks|thank\s*you|thx|ty|much\s*appreciated)\b/i.test(t)) return true;
    if (/^(ok{1,3}|okay|k\b|cool|nice|great|perfect|awesome|sweet)\b/i.test(t)) return true;
    if (/^(sure|yep|yeah|yup|righto|alright)\b/i.test(t)) return true;
    if (/^(sounds?\s*good|got\s*it|makes\s+sense)\b/i.test(t)) return true;
    if (/^no\s*(problem|worries)|\bnp\b|^cheers\b|^nm\b|not\s+much\b/i.test(t)) return true;
    if (/^how\s*(are|r)\s*(you|u)\b/i.test(t)) return true;
    if (/^(what'?s\s*up|wassup|sup\b)\b/i.test(t)) return true;
    if (/^(bye|goodbye|cya|see\s*you|later)\b/i.test(t)) return true;
    if (/^(lol|lmao|haha|ha{2,})\b/i.test(t)) return true;

    return false;
}

export function buildMicroSocialAssistantReply(text, ctx = {}) {
    const raw = String(text || "").trim();
    const t = normMicroText(raw).toLowerCase();
    const fc = typeof ctx.fieldCount === "number" ? ctx.fieldCount : 0;
    const sc = typeof ctx.scanCount === "number" ? ctx.scanCount : 0;

    const thinFarmNote = () =>
        fc === 0 && sc === 0 && AGRI_TOKEN.test(raw)
            ? " " +
              pickRotated("micro_thin_data", [
                  "(No fields or scans on file—I’m keeping this generic.)",
                  "(I don’t have saved farm snapshots yet—take that as general reassurance.)",
              ])
            : "";

    if (/^(bye|goodbye|cya|see\s*you|later|ttyl)\b/.test(t)) {
        return (
            pickRotated("micro_bye", [
                "Take care.",
                "Later.",
                "Catch you later.",
                "Sounds good — bye for now.",
                "All right — talk soon.",
            ]) + thinFarmNote()
        );
    }
    if (/^(thanks|thank|thx|ty|much\s+appreciated)\b/.test(t) || t.includes("🙏")) {
        return (
            pickRotated("micro_thanks", [
                "Anytime.",
                "You got it.",
                "Happy to help.",
                "Glad it helped.",
                "Of course.",
                "Sure thing.",
            ]) + thinFarmNote()
        );
    }
    if (/^(ok{1,3}|okay|\bk\b|^k\.|cool|nice|great|perfect|awesome|sweet|rad)\b/.test(t)) {
        return (
            pickRotated("micro_ok", [
                "Sounds good.",
                "Got it.",
                "Cool.",
                "Okay — I’m here.",
                "Nice.",
                "Right on.",
            ]) + thinFarmNote()
        );
    }
    if (/^(sure|righto|yep|yup|ya\b|alright|roger)\b/.test(t)) {
        return pickRotated("micro_sure", ["Got it.", "Okay.", "Roger that.", "Understood.", "On it."]) + thinFarmNote();
    }
    if (/^(sounds?\s*good|makes\s+sense|got\s*it|\bi\s*hear\s*you|fair\s+enough|^fair\b|^word\b)\b/.test(t)) {
        return pickRotated("micro_ack", ["Yep.", "Agreed.", "Makes sense.", "Copy that.", "Noted."]) + thinFarmNote();
    }
    if (/^(no\s+(problem|worries)|^np\b|^cheers\b|^nm\b|not\s+much\b)\b/.test(t)) {
        return (
            pickRotated("micro_np", [
                "Likewise.",
                "All good.",
                "Anytime.",
                "Cheers.",
                "Cool — here if you need anything.",
            ]) + thinFarmNote()
        );
    }
    if (/^(yeah|yep)\s*[,.]?\s*(thanks|thx)\b/.test(t) || /^(thanks|thank|thx|ty)\s*[!.]*$/i.test(t)) {
        return pickRotated("micro_thanks_short", ["Anytime.", "You bet.", "Happy to.", "Sure thing."]) + thinFarmNote();
    }

    return pickRotated("micro_fallback", ["Sure thing.", "I’m here.", "Okay."]) + thinFarmNote();
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
        if (fc === 0 && sc === 0) {
            return pickRotated("pos_farm_thin", [
                "That’s great to hear—I don’t have fields or scans on file yet, so I’m cheering from general patterns only.",
                "Nice progress. Without saved farm snapshots I can’t tie it to your rows, but glad things look better.",
                "Love hearing that. Add a field + scan when you can so follow-ups stay specific.",
            ]);
        }
        return pickRotated("pos_farm", [
            "That’s great to hear — sounds like things are moving in a good direction.",
            "Nice — glad it’s looking better out there.",
            "Love hearing that. If anything slips again, send a quick note or a photo.",
            "That’s a relief. Keep an eye on humidity and any new spots, but enjoy the win.",
        ]);
    }

    if (/^(hi|hello|hey|yo|hiya|howdy|greetings)\b/i.test(t)) {
        return pickRotated("greet_hi", [
            "Hey — how’s it going?",
            "Hi there.",
            "Hey. What’s going on today?",
            "Hello — good to see you here.",
            "Hey — what’s on your mind?",
        ]);
    }

    if (/^(what'?s\s*up|wassup|\bsup\b)\b/i.test(t)) {
        return pickRotated("greet_sup", [
            "Not much on my side — what’s up with you?",
            "Hey — how are you doing?",
            "All good here. What’s happening on your end?",
        ]);
    }

    if (/^good\s*(morning|afternoon|evening|night|day)\b/.test(t)) {
        return pickRotated("greet_day", [
            "Hey — how’s it going?",
            "Morning — hope you’re doing all right.",
            "Hi — nice to connect.",
            "Hey there — how’ve you been?",
        ]);
    }

    if (/^how\s*(are|r)\s*(you|u)\b/.test(t)) {
        return pickRotated("howru", [
            "Doing well — how about you?",
            "I’m good, thanks. What’s on your mind today?",
            "All good here. How are things with you?",
        ]);
    }

    if (/^(bye|goodbye|cya|see\s*you|later)\b/.test(t)) {
        return pickRotated("bye", [
            "Take care — ping me anytime.",
            "Later — talk soon.",
            "Bye for now.",
        ]);
    }
    if (/^(thanks|thank|thx|ty)\b/.test(t) || t.includes("🙏")) {
        return pickRotated("thanks", [
            "Anytime.",
            "Glad I could help.",
            "You’re welcome.",
            "Happy to help.",
        ]);
    }

    if (/^(ok{1,3}|okay|cool|nice|great|perfect|awesome|sweet)\b/.test(t)) {
        return pickRotated("casual_ok", [
            "Glad that works.",
            "Cool — I’m here if you need anything else.",
            "Nice — say the word if you want to go deeper.",
        ]);
    }

    if (/^(lol|lmao|haha|ha{2,})\b/.test(t)) {
        return pickRotated("lol", [
            "Ha — okay.",
            "Ha — fair.",
            "Ha — I needed that.",
        ]);
    }

    const needsOnboard = (fc === 0 && sc === 0) || sc === 0;
    const onboardHint = needsOnboard
        ? pickRotated("casual_onboard", [
              fc === 0 && sc === 0
                  ? " When you add a field + save a scan, I can tie answers to your numbers."
                  : " A quick scan later will make follow-ups sharper.",
              "",
              "",
          ])
        : "";

    return pickRotated("open_chat", [
        `Hey — how’s your day?${onboardHint}`,
        `Hi. What do you want to dig into?${onboardHint}`,
        `What’s up?${onboardHint ? (onboardHint.trim() ? `\n${onboardHint.trim()}` : "") : ""}`,
    ]);
}

/**
 * Clarifying turn for “something looks off” without enough detail — no orchestration.
 * @param {string} text
 * @param {{ fieldCount?: number, scanCount?: number }} ctx
 */
export function buildVagueSymptomReply(text, ctx = {}) {
    const trained = matchSymptomTrainingReply(text, ctx);
    if (trained) return trained;

    const sc = typeof ctx.scanCount === "number" ? ctx.scanCount : 0;
    const photoHint = sc ? "If you have a clear leaf photo, attach it next — that helps a lot." : "A saved scan or a clear leaf photo makes the next step much easier.";
    const lead = farmContextEmptyLead(ctx);
    const body = pickRotated("vague_sym", [
        `Hmm — what are you noticing exactly? Yellowing, spots, wilting, holes, or something else? ${photoHint}`,
        `Got it. Can you narrow it down — color change, texture, pattern on the leaf, or spread in the row? ${photoHint}`,
        `Tell me a bit more about “off”: where on the plant, how fast it showed up, and the crop? ${photoHint}`,
    ]);
    return lead ? `${lead}${body}` : body;
}
