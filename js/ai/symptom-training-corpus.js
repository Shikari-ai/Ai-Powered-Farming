/**
 * Internal symptom / stress Q&A — heuristic match only (no external LLM).
 * Used for clarify-style turns; hedged copy only. More specific rules first.
 */
import { farmContextEmptyLead } from "./epistemic-policy.js?v=2";

/** @typedef {{ re: RegExp, reply: string }} SymptomRule */

/** @type {SymptomRule[]} */
const SYMPTOM_RULES = [
    {
        re: /\b(leaves?|leaf)\b.*\bcurl(ing)?\b.*\bupward\b|\bcurl(ing)?\b.*\bupward\b.*\bleaf/i,
        reply:
            "Upward curling can happen from heat stress, moisture imbalance, or pest pressure. Are temperatures unusually high lately?",
    },
    {
        re: /\bsoil\b.*\b(feel|feels|felt)\b.*\bdry\b.*\bwater|\bdry\b.*\b(after|even\s+after)\s+watering/i,
        reply:
            "That could mean poor water retention or uneven absorption. Does the water drain too quickly from the field?",
    },
    {
        re: /\b(stopped\s+growing|growth\s+slowed|not\s+growing|sudden(ly)?\s+slow)\b/i,
        reply:
            "Sudden growth slowdown can come from root stress, nutrient imbalance, or weather shock. What crop are you growing?",
    },
    {
        re: /\bsprayed?\b.*\b(yesterday|last\s+night)\b.*\b(nothing|no\s+change|changed)\b|\b(nothing|no\s+change)\b.*\bspray/i,
        reply:
            "Some treatments take time to show visible improvement. What symptoms were you targeting with the spray?",
    },
    {
        re: /\b(smell|smells|smelling)\b.*\b(strange|odd|weird)\b.*\b(rain|after\s+rain)|\b(strange|odd)\b.*\b(smell|odor)\b.*\b(rain|wet)/i,
        reply:
            "A strong smell after rainfall can sometimes point to waterlogging or root-zone stress. Are parts of the field staying wet too long?",
    },
    {
        re: /\b(tiny|small)\s+holes\b.*\bleaves?|\bholes\b.*\bleaves?|\bleaves?\b.*\bholes\b/i,
        reply:
            "Small holes often suggest insect feeding. Are you noticing pests underneath the leaves as well?",
    },
    {
        re: /\b(plants?|crop)\b.*\b(look\s+weak|weak|feeble)\b|\bweak\b.*\b(plants?|growth)\b/i,
        reply: "Weak growth can come from several causes. Are the stems thin, discolored, or wilting?",
    },
    {
        re: /\b(pale|paler|pallid)\b.*\b(color|colour|crop)|\b(color|colour)\b.*\b(pale|off|faded)\b/i,
        reply:
            "Pale coloration may indicate nutrient stress or poor root activity. Is the issue spreading evenly across the field?",
    },
    {
        re: /\blower\s+leaves?\b.*\b(yellow|yellowing)\b.*\bfirst\b|\b(yellow|yellowing)\b.*\blower\s+leaves?/i,
        reply:
            "Lower-leaf yellowing often relates to nutrient movement or aging stress, but field conditions matter too.",
    },
    {
        re: /\b(something|wrong)\b.*\birrigation\b|\birrigation\b.*\b(wrong|issue|problem|off)\b/i,
        reply:
            "What are you noticing — uneven wetness, runoff, weak flow, or dry patches?",
    },
    {
        re: /\b(recovered|recovering|bounced\s+back)\b.*\b(after\s+)?rain\b|\brain\b.*\b(recovered|better|improved)\b/i,
        reply: "That suggests moisture stress may have been contributing to the issue.",
    },
    {
        re: /\bcan\s+weather\s+alone\b.*\b(damage|hurt|harm)\b|\bweather\s+alone\b.*\b(crop|plant)/i,
        reply: "Yes, especially heat waves, heavy humidity, sudden cold, or prolonged rainfall.",
    },
    {
        re: /\b(afternoon|mid-?day|midday)\b.*\b(stress|stressed|wilt)\b|\b(stress|stressed)\b.*\b(afternoon|only)\b/i,
        reply:
            "Midday stress sometimes points to heat load or moisture imbalance. Does it recover by evening?",
    },
    {
        re: /\b(don'?t|do\s+not)\s+understand\b.*\b(what'?s?\s+happening|going\s+on|this)\b|\bconfus(ed|ing)?\b.*\b(what'?s?\s+happening|going\s+on)\b/i,
        reply: "No problem — we can narrow it down gradually. Start with what symptoms you noticed first.",
    },
    {
        re: /\b(is\s+this\s+serious|how\s+serious|should\s+i\s+worry)\b/i,
        reply:
            "Hard to judge confidently without more field details, but we can work through the symptoms step by step.",
    },
    {
        re: /\b(dark|browning?)\s+edges?\b|\bedges?\b.*\b(dark|brown)\b/i,
        reply:
            "Darkened edges can appear from environmental stress, nutrient imbalance, or leaf damage.",
    },
    {
        re: /\buneven\s+growth\b|\bgrowth\b.*\buneven\b|\bpatchy\s+growth\b/i,
        reply:
            "Uneven growth may suggest irrigation inconsistency, soil variation, or localized stress zones.",
    },
    {
        re: /\bdroop(ing|ed|y)?\b|\bwilting?\b/i,
        reply:
            "Drooping can happen from both underwatering and overwatering. How wet is the soil right now?",
    },
    {
        re: /\bwhite\s+powder\b|\bpowdery\s+white\b|\bwhite\s+coating\b/i,
        reply:
            "White powder-like growth can sometimes indicate fungal activity, especially in humid conditions.",
    },
    {
        re: /\b(improved|better|helped)\b.*\birrigation\b|\birrigation\b.*\b(improved|better|helped)\b/i,
        reply: "That points toward moisture-related stress being part of the problem.",
    },
    {
        re: /\b(too\s+wet|waterlogged|soggy)\b.*\b(rain|rainfall)|\b(rain|rainfall)\b.*\b(too\s+wet|wet)\b/i,
        reply: "Prolonged wetness can increase root stress and fungal pressure.",
    },
    {
        re: /\bcan\s+wind\b.*\b(damage|hurt|harm)\b|\bwind\b.*\b(damage|stress)\b.*\b(crop|plant)/i,
        reply: "Strong wind can physically stress plants and also increase moisture loss.",
    },
    {
        re: /\b(worried|worry|anxious)\s+again\b|\bgetting\s+worried\s+again\b/i,
        reply:
            "Understandable. Farming conditions can change quickly, but we can assess things calmly step by step.",
    },
    {
        re: /\bstems?\b.*\b(feel\s+)?weak\b|\bweak\b.*\bstems?\b/i,
        reply: "Weak stems can result from environmental stress, nutrient issues, or excessive moisture.",
    },
    {
        re: /\b(patches?)\b.*\bspread(ing)?\b|\bspread(ing)?\b.*\b(patches?|across\s+the\s+field)\b/i,
        reply:
            "Spreading patches may indicate environmental spread patterns, irrigation issues, or disease pressure.",
    },
    {
        re: /\buneven\s+heights?\b|\b(heights?|height)\b.*\buneven\b|\bgrowing\s+at\s+different\s+heights?\b/i,
        reply:
            "Height inconsistency sometimes reflects uneven nutrients, moisture, or soil conditions.",
    },
    {
        re: /\brain(ed)?\s+heavily\b.*\b(three|3)\s+days\b|\b(three|3)\s+days\b.*\brain/i,
        reply: "Extended rainfall can raise fungal pressure and reduce oxygen availability near roots.",
    },
    {
        re: /\b(fine|okay|good)\s+yesterday\b|\byesterday\b.*\b(fine|okay|good)\b/i,
        reply: "Rapid changes often happen after weather shifts or irrigation changes.",
    },
    {
        re: /\b(dry(ing)?|dryness)\b.*\b(from\s+)?(the\s+)?tips?\b|\btips?\b.*\bdry/i,
        reply: "Tip drying can relate to heat stress, moisture imbalance, or nutrient-related stress.",
    },
    {
        re: /\b(don'?t|not)\s+have\s+enough\s+(info|information|data)\b|\bnot\s+enough\s+information\b/i,
        reply:
            "That’s okay. Even basic details like crop type, weather conditions, and visible symptoms can help narrow possibilities.",
    },
    {
        re: /\b(same\s+problem|keeps?\s+(coming|getting|happening)|recurring\s+issue)\b/i,
        reply:
            "Repeated stress patterns may suggest recurring environmental conditions or unresolved field issues.",
    },
    {
        re: /\bhumidity\b.*\b(affect|impact|matter|this\s+much)\b|\b(affect|impact)\b.*\bhumidity\b/i,
        reply: "Yes. High humidity can strongly influence fungal pressure and leaf surface conditions.",
    },
    {
        re: /\b(watered|watering)\s+more\b.*\b(worse|bad)\b|\bmore\s+water\b.*\b(worse|bad)\b/i,
        reply: "Excess watering can sometimes increase root stress depending on drainage conditions.",
    },
    {
        re: /\b(dries?\s+too\s+fast|dry(ing)?\s+too\s+quickly|too\s+fast\s+to\s+dry)\b/i,
        reply: "Fast drying may indicate heat exposure, soil texture issues, or high evaporation rates.",
    },
    {
        re: /\bsticky\b.*\bleaves?|\bleaves?\b.*\bsticky\b/i,
        reply: "Sticky residue can sometimes appear alongside insect activity.",
    },
    {
        re: /\b(healthier|better)\s+today\b|\btoday\b.*\b(healthier|looking\s+good)\b/i,
        reply: "That’s encouraging. Environmental recovery or successful intervention may be helping.",
    },
    {
        re: /\bconfus(ed|ing)?\b.*\b(what\s+to\s+do\s+next|next\s+step)|\bwhat\s+to\s+do\s+next\b|\b(don'?t|do\s+not)\s+know\s+what\s+to\s+do\b/i,
        reply:
            "Let’s simplify it. Focus first on visible symptoms, weather conditions, and irrigation behavior.",
    },
    {
        re: /\bstanding\s+water\b|\b(puddles?|ponding)\b.*\b(field|plot)\b/i,
        reply: "Standing water can stress roots and increase environmental disease pressure.",
    },
    {
        re: /\b(insects?|bugs?)\b.*\b(flying|around)\b|\bflying\s+around\b.*\b(plants?|crop)\b/i,
        reply:
            "Insect presence alone doesn’t confirm damage, but it’s worth checking leaf surfaces closely.",
    },
    {
        re: /\brecover(ing|y)\s+slowly\b|\bslow\s+recovery\b/i,
        reply: "Gradual recovery is common after environmental or biological stress.",
    },
    {
        re: /\bshould\s+i\s+panic\b|\bpanic\b.*\b(should|need)\b/i,
        reply: "No — it’s better to assess the situation carefully before making major decisions.",
    },
    {
        re: /\b(temperature|temp)\s+swings?\b|\b(swing|swings)\b.*\b(temp|temperature)\b|\bsudden\s+temp/i,
        reply: "Sudden temperature changes can definitely stress plant growth and recovery.",
    },
    {
        re: /\bcompacted\b.*\bsoil\b|\bsoil\b.*\bcompacted\b|\bhard\s+soil\b/i,
        reply: "Compacted soil can reduce root oxygen and affect water movement.",
    },
    {
        re: /\b(burnt|burned|scorch)\b.*\b(places?|spots?|patches?)|\b(looks?\s+)?burnt\b/i,
        reply: "Burn-like symptoms can come from heat, chemical stress, or environmental exposure.",
    },
    {
        re: /\b(need|want|give\s+me)\s+a\s+quick\s+answer\b|\bquick\s+answer\b/i,
        reply:
            "Based on the symptoms so far, the field appears stressed, but more context would improve accuracy.",
    },
    {
        re: /\b(smaller|stunted|short(er)?)\s+than\s+usual\b|\bplants?\b.*\b(smaller|stunted)\b/i,
        reply: "Reduced growth may reflect stress during earlier development stages.",
    },
    {
        re: /\brecover(ing|y)\b.*\b(cooler|cool)\s+weather\b|\bcool(er)?\s+weather\b.*\brecover/i,
        reply: "Lower temperatures sometimes reduce environmental stress and help recovery.",
    },
    {
        re: /\b(don'?t|do\s+not)\s+trust\b.*\b(random\s+)?guess|\bno\s+random\s+guess/i,
        reply: "Good — decisions should be based on evidence and field context whenever possible.",
    },
    {
        re: /\b(humidity)\b.*\b(increased|rose|went\s+up|higher)\b|\b(after|since)\b.*\b(humidity)\b/i,
        reply:
            "That timing could matter because humidity can influence fungal and leaf-surface conditions.",
    },
    {
        re: /\b(some|few)\s+plants?\b.*\b(healthy|fine)\b.*\b(others?|rest)\b|\b(mixed|patchy)\s+health\b/i,
        reply:
            "Mixed health patterns often suggest uneven environmental or soil conditions.",
    },
    {
        re: /\b(upload|send)\b.*\b(image|photo|picture)\b.*\b(later)?\b|\b(image|photo)\s+later\b/i,
        reply: "Absolutely. Visual evidence can help narrow possibilities much more accurately.",
    },
    {
        re: /\b(feel|feels|feeling)\s+weaker\b.*\b(this\s+week|week)\b|\bweaker\s+this\s+week\b/i,
        reply:
            "Has the weather changed significantly or has irrigation behavior shifted recently?",
    },
];

/**
 * @param {string} text
 * @param {{ fieldCount?: number, scanCount?: number }} [ctx]
 * @returns {string|null}
 */
export function matchSymptomTrainingReply(text, ctx = {}) {
    const q = String(text || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, " ");
    if (q.length < 6) return null;
    for (const { re, reply } of SYMPTOM_RULES) {
        if (re.test(q)) {
            const lead = farmContextEmptyLead(ctx);
            return lead ? `${lead}${reply}` : reply;
        }
    }
    return null;
}
