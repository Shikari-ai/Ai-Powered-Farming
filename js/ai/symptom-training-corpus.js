/**
 * Symptom / stress heuristics — **behavioral intent**, not fixed scripts.
 * Each rule keeps 2+ paraphrases; `pickRotated` reduces word-for-word repetition.
 * See `assistant-training-principles.js` for goals (uncertainty, follow-ups, tone).
 */
import { pickRotated } from "./conversation-naturals.js?v=48";
import { farmContextEmptyLead } from "./epistemic-policy.js?v=2";

/**
 * @param {string} id stable key for rotation bucket
 * @param {RegExp} re
 * @param {string} a
 * @param {string} [b]
 * @returns {{ id: string, re: RegExp, variants: string[] }}
 */
function v(id, re, a, b) {
    const variants = b ? [a, b] : [a, a];
    return { id, re, variants };
}

/** @type {{ id: string, re: RegExp, variants: string[] }[]} */
const SYMPTOM_RULES = [
    v(
        "curl_up",
        /\b(leaves?|leaf)\b.*\bcurl(ing)?\b.*\bupward\b|\bcurl(ing)?\b.*\bupward\b.*\bleaf/i,
        "Upward curling can happen from heat stress, moisture imbalance, or pest pressure. Are temperatures unusually high lately?",
        "Leaf cupping upward often tracks with heat, water stress, or occasional pests — has it been hot or very dry recently?",
    ),
    v(
        "soil_dry_after_water",
        /\bsoil\b.*\b(feel|feels|felt)\b.*\bdry\b.*\bwater|\bdry\b.*\b(after|even\s+after)\s+watering/i,
        "That could mean poor water retention or uneven absorption. Does the water drain too quickly from the field?",
        "Dry soil right after watering can mean runoff, compaction, or uneven wetting — does water pool anywhere or vanish fast?",
    ),
    v(
        "growth_stall",
        /\b(stopped\s+growing|growth\s+slowed|not\s+growing|sudden(ly)?\s+slow)\b/i,
        "Sudden growth slowdown can come from root stress, nutrient imbalance, or weather shock. What crop are you growing?",
        "When growth brakes hard, I look at roots, nutrients, and a recent weather jolt — what crop is it, and did anything change in the last week?",
    ),
    v(
        "spray_no_change",
        /\bsprayed?\b.*\b(yesterday|last\s+night)\b.*\b(nothing|no\s+change|changed)\b|\b(nothing|no\s+change)\b.*\bspray/i,
        "Some treatments take time to show visible improvement. What symptoms were you targeting with the spray?",
        "Sprays often need days and the right conditions — which pest or symptom were you aiming at, and what rate did you use?",
    ),
    v(
        "smell_after_rain",
        /\b(smell|smells|smelling)\b.*\b(strange|odd|weird)\b.*\b(rain|after\s+rain)|\b(strange|odd)\b.*\b(smell|odor)\b.*\b(rain|wet)/i,
        "A strong smell after rainfall can sometimes point to waterlogging or root-zone stress. Are parts of the field staying wet too long?",
        "Odd odors after rain can tie to anaerobic spots or residue — any low spots that hold water for days?",
    ),
    v(
        "tiny_holes",
        /\b(tiny|small)\s+holes\b.*\bleaves?|\bholes\b.*\bleaves?|\bleaves?\b.*\bholes\b/i,
        "Small holes often suggest insect feeding. Are you noticing pests underneath the leaves as well?",
        "Pinholes usually mean chewing pests — any silvery trails, sticky spots, or bugs on the leaf undersides?",
    ),
    v(
        "weak_plants",
        /\b(plants?|crop)\b.*\b(look\s+weak|weak|feeble)\b|\bweak\b.*\b(plants?|growth)\b/i,
        "Weak growth can come from several causes. Are the stems thin, discolored, or wilting?",
        "When everything looks tired, I’d check stems, color, and soil moisture together — what stands out most to you?",
    ),
    v(
        "pale_color",
        /\b(pale|paler|pallid)\b.*\b(color|colour|crop)|\b(color|colour)\b.*\b(pale|off|faded)\b/i,
        "Pale coloration may indicate nutrient stress or poor root activity. Is the issue spreading evenly across the field?",
        "Paleness can be nutritional or root-related — is it uniform, or worse in certain rows or wet spots?",
    ),
    v(
        "lower_yellow",
        /\blower\s+leaves?\b.*\b(yellow|yellowing)\b.*\bfirst\b|\b(yellow|yellowing)\b.*\blower\s+leaves?/i,
        "Lower-leaf yellowing often relates to nutrient movement or aging stress, but field conditions matter too.",
        "Yellowing that climbs from the bottom can be nutrient or senescence patterns — any N history or waterlogging to mention?",
    ),
    v(
        "irrigation_wrong",
        /\b(something|wrong)\b.*\birrigation\b|\birrigation\b.*\b(wrong|issue|problem|off)\b/i,
        "What are you noticing — uneven wetness, runoff, weak flow, or dry patches?",
        "Tell me which irrigation signal you’re seeing: dry strips, ponding, low pressure, or timing that feels off?",
    ),
    v(
        "recover_after_rain",
        /\b(recovered|recovering|bounced\s+back)\b.*\b(after\s+)?rain\b|\brain\b.*\b(recovered|better|improved)\b/i,
        "That suggests moisture stress may have been contributing to the issue.",
        "A bounce after rain often hints moisture was part of the story — was it looking tight before the wet spell?",
    ),
    v(
        "weather_damage",
        /\bcan\s+weather\s+alone\b.*\b(damage|hurt|harm)\b|\bweather\s+alone\b.*\b(crop|plant)/i,
        "Yes, especially heat waves, heavy humidity, sudden cold, or prolonged rainfall.",
        "Weather can absolutely stress crops on its own — think heat spikes, long wet spells, frost, or sharp swings.",
    ),
    v(
        "afternoon_stress",
        /\b(afternoon|mid-?day|midday)\b.*\b(stress|stressed|wilt)\b|\b(stress|stressed)\b.*\b(afternoon|only)\b/i,
        "Midday stress sometimes points to heat load or moisture imbalance. Does it recover by evening?",
        "If it only looks rough in the afternoon, heat and transpiration load are prime suspects — does it perk up overnight?",
    ),
    v(
        "dont_understand",
        /\b(don'?t|do\s+not)\s+understand\b.*\b(what'?s?\s+happening|going\s+on|this)\b|\bconfus(ed|ing)?\b.*\b(what'?s?\s+happening|going\s+on)\b/i,
        "No problem — we can narrow it down gradually. Start with what symptoms you noticed first.",
        "Totally fair — walk me through what you saw first, even if it’s vague, and we’ll tighten from there.",
    ),
    v(
        "is_serious",
        /\b(is\s+this\s+serious|how\s+serious|should\s+i\s+worry)\b/i,
        "Hard to judge confidently without more field details, but we can work through the symptoms step by step.",
        "I can’t call it serious from here alone — share crop, spread pattern, and anything that changed in the last few days.",
    ),
    v(
        "dark_edges",
        /\b(dark|browning?)\s+edges?\b|\bedges?\b.*\b(dark|brown)\b/i,
        "Darkened edges can appear from environmental stress, nutrient imbalance, or leaf damage.",
        "Browning margins can be environmental, nutritional, or physical damage — any spray, heat, or salt stress lately?",
    ),
    v(
        "uneven_growth",
        /\buneven\s+growth\b|\bgrowth\b.*\buneven\b|\bpatchy\s+growth\b/i,
        "Uneven growth may suggest irrigation inconsistency, soil variation, or localized stress zones.",
        "Patchy vigor often maps to water, soil differences, or past traffic — does it follow rows or low spots?",
    ),
    v(
        "drooping",
        /\bdroop(ing|ed|y)?\b|\bwilting?\b/i,
        "Drooping can happen from both underwatering and overwatering. How wet is the soil right now?",
        "Wilting is ambiguous — a quick finger test for moisture (and drainage) usually splits too dry vs too wet.",
    ),
    v(
        "white_powder",
        /\bwhite\s+powder\b|\bpowdery\s+white\b|\bwhite\s+coating\b/i,
        "White powder-like growth can sometimes indicate fungal activity, especially in humid conditions.",
        "A powdery white film can be fungal in humid air — I wouldn’t name a pathogen from text alone; good photos help.",
    ),
    v(
        "better_after_irrigation",
        /\b(improved|better|helped)\b.*\birrigation\b|\birrigation\b.*\b(improved|better|helped)\b/i,
        "That points toward moisture-related stress being part of the problem.",
        "If irrigation clearly helped, moisture stress was likely in the mix — any dry windows before you watered?",
    ),
    v(
        "too_wet",
        /\b(too\s+wet|waterlogged|soggy)\b.*\b(rain|rainfall)|\b(rain|rainfall)\b.*\b(too\s+wet|wet)\b/i,
        "Prolonged wetness can increase root stress and fungal pressure.",
        "Sitting wet raises root and fungal risk — how long do the low spots stay saturated after rain?",
    ),
    v(
        "wind_damage",
        /\bcan\s+wind\b.*\b(damage|hurt|harm)\b|\bwind\b.*\b(damage|stress)\b.*\b(crop|plant)/i,
        "Strong wind can physically stress plants and also increase moisture loss.",
        "Wind can sandblast leaves, desiccate edges, and rock young plants — was there a blowy period recently?",
    ),
    v(
        "worried_again",
        /\b(worried|worry|anxious)\s+again\b|\bgetting\s+worried\s+again\b/i,
        "Understandable. Farming conditions can change quickly, but we can assess things calmly step by step.",
        "That’s a lot to carry — we’ll go slow: symptoms first, then weather and water, then what you changed last.",
    ),
    v(
        "weak_stems",
        /\bstems?\b.*\b(feel\s+)?weak\b|\bweak\b.*\bstems?\b/i,
        "Weak stems can result from environmental stress, nutrient issues, or excessive moisture.",
        "Soft stems often stack with lodging risk — are stems thin, shaded, or in very wet soil?",
    ),
    v(
        "spreading_patches",
        /\b(patches?)\b.*\bspread(ing)?\b|\bspread(ing)?\b.*\b(patches?|across\s+the\s+field)\b/i,
        "Spreading patches may indicate environmental spread patterns, irrigation issues, or disease pressure.",
        "Spreading zones deserve a map in your head: along rows (water), random (soil), or from edges (drift) — which fits?",
    ),
    v(
        "uneven_heights",
        /\buneven\s+heights?\b|\b(heights?|height)\b.*\buneven\b|\bgrowing\s+at\s+different\s+heights?\b/i,
        "Height inconsistency sometimes reflects uneven nutrients, moisture, or soil conditions.",
        "Uneven canopies often echo uneven N, water, or emergence — any replant strips or compaction lines?",
    ),
    v(
        "heavy_rain_3d",
        /\brain(ed)?\s+heavily\b.*\b(three|3)\s+days\b|\b(three|3)\s+days\b.*\brain/i,
        "Extended rainfall can raise fungal pressure and reduce oxygen availability near roots.",
        "Multi-day rain loads leaf wetness hours and can starve roots in tight soils — any standing water after?",
    ),
    v(
        "fine_yesterday",
        /\b(fine|okay|good)\s+yesterday\b|\byesterday\b.*\b(fine|okay|good)\b/i,
        "Rapid changes often happen after weather shifts or irrigation changes.",
        "Fast flips usually tie to a weather swing, irrigation change, or spray — anything like that in the last 48h?",
    ),
    v(
        "tip_dry",
        /\b(dry(ing)?|dryness)\b.*\b(from\s+)?(the\s+)?tips?\b|\btips?\b.*\bdry/i,
        "Tip drying can relate to heat stress, moisture imbalance, or nutrient-related stress.",
        "Burn from the tips can be moisture, salinity, or nutrient transport — is it uniform on older leaves first?",
    ),
    v(
        "not_enough_info",
        /\b(don'?t|not)\s+have\s+enough\s+(info|information|data)\b|\bnot\s+enough\s+information\b/i,
        "That’s okay. Even basic details like crop type, weather conditions, and visible symptoms can help narrow possibilities.",
        "No stress — crop, rough weather, and what you see (even one sentence) already tightens the picture a lot.",
    ),
    v(
        "same_problem",
        /\b(same\s+problem|keeps?\s+(coming|getting|happening)|recurring\s+issue)\b/i,
        "Repeated stress patterns may suggest recurring environmental conditions or unresolved field issues.",
        "When the same symptom returns, I look for a repeating weather or water story — does it follow wet spells or heat?",
    ),
    v(
        "humidity_effect",
        /\bhumidity\b.*\b(affect|impact|matter|this\s+much)\b|\b(affect|impact)\b.*\bhumidity\b/i,
        "Yes. High humidity can strongly influence fungal pressure and leaf surface conditions.",
        "Humidity absolutely moves fungal risk and leaf wetness — long humid nights are the usual red flag.",
    ),
    v(
        "more_water_worse",
        /\b(watered|watering)\s+more\b.*\b(worse|bad)\b|\bmore\s+water\b.*\b(worse|bad)\b/i,
        "Excess watering can sometimes increase root stress depending on drainage conditions.",
        "More water hurting can mean poor drainage or hypoxia — do low spots stay spongy for days?",
    ),
    v(
        "dries_fast",
        /\b(dries?\s+too\s+fast|dry(ing)?\s+too\s+quickly|too\s+fast\s+to\s+dry)\b/i,
        "Fast drying may indicate heat exposure, soil texture issues, or high evaporation rates.",
        "If the surface dries in hours, think heat, wind, sandy texture, or shallow roots — which matches your field?",
    ),
    v(
        "sticky_leaves",
        /\bsticky\b.*\bleaves?|\bleaves?\b.*\bsticky\b/i,
        "Sticky residue can sometimes appear alongside insect activity.",
        "Stickiness often pairs with honeydew-producing pests — any ants tending aphids or shiny leaf film?",
    ),
    v(
        "healthier_today",
        /\b(healthier|better)\s+today\b|\btoday\b.*\b(healthier|looking\s+good)\b/i,
        "That’s encouraging. Environmental recovery or successful intervention may be helping.",
        "Glad to hear a lift — weather easing or a timely irrigation pass often shows up first in the canopy.",
    ),
    v(
        "confused_next",
        /\bconfus(ed|ing)?\b.*\b(what\s+to\s+do\s+next|next\s+step)|\bwhat\s+to\s+do\s+next\b|\b(don'?t|do\s+not)\s+know\s+what\s+to\s+do\b/i,
        "Let’s simplify it. Focus first on visible symptoms, weather conditions, and irrigation behavior.",
        "We can keep it small: one symptom, last rain/irrigation change, and crop — then we stack the next step.",
    ),
    v(
        "standing_water",
        /\bstanding\s+water\b|\b(puddles?|ponding)\b.*\b(field|plot)\b/i,
        "Standing water can stress roots and increase environmental disease pressure.",
        "Ponded areas choke roots and invite issues — how deep and how long after rain do they stay?",
    ),
    v(
        "insects_flying",
        /\b(insects?|bugs?)\b.*\b(flying|around)\b|\bflying\s+around\b.*\b(plants?|crop)\b/i,
        "Insect presence alone doesn’t confirm damage, but it’s worth checking leaf surfaces closely.",
        "Flying insects might be benign visitors — flip a few leaves and look for eggs, chewed tissue, or honeydew.",
    ),
    v(
        "slow_recovery",
        /\brecover(ing|y)\s+slowly\b|\bslow\s+recovery\b/i,
        "Gradual recovery is common after environmental or biological stress.",
        "Slow bounce-back happens after big stress — are green shoots returning, even if unevenly?",
    ),
    v(
        "panic",
        /\bshould\s+i\s+panic\b|\bpanic\b.*\b(should|need)\b/i,
        "No — it’s better to assess the situation carefully before making major decisions.",
        "Panic rarely helps — small, verified steps beat a rushed big swing. What’s the most urgent symptom right now?",
    ),
    v(
        "temp_swings",
        /\b(temperature|temp)\s+swings?\b|\b(swing|swings)\b.*\b(temp|temperature)\b|\bsudden\s+temp/i,
        "Sudden temperature changes can definitely stress plant growth and recovery.",
        "Sharp temp swings shock growth — any frost/fry window or greenhouse door effects to mention?",
    ),
    v(
        "compacted_soil",
        /\bcompacted\b.*\bsoil\b|\bsoil\b.*\bcompacted\b|\bhard\s+soil\b/i,
        "Compacted soil can reduce root oxygen and affect water movement.",
        "Tight soil limits roots and percolation — any heavy traffic, tillage gaps, or clay layers?",
    ),
    v(
        "burnt_look",
        /\b(burnt|burned|scorch)\b.*\b(places?|spots?|patches?)|\b(looks?\s+)?burnt\b/i,
        "Burn-like symptoms can come from heat, chemical stress, or environmental exposure.",
        "Scorchy patches can be chemical, heat, or salinity — any recent spray, fert, or road dust drift?",
    ),
    v(
        "quick_answer",
        /\b(need|want|give\s+me)\s+a\s+quick\s+answer\b|\bquick\s+answer\b/i,
        "Based on the symptoms so far, the field appears stressed, but more context would improve accuracy.",
        "Short version: it reads like stress, but I’d want crop + a symptom photo before tightening the call.",
    ),
    v(
        "smaller_plants",
        /\b(smaller|stunted|short(er)?)\s+than\s+usual\b|\bplants?\b.*\b(smaller|stunted)\b/i,
        "Reduced growth may reflect stress during earlier development stages.",
        "Stunting often ties to an early-season pinch — cold, wet, herbicide timing, or fertility — any of those ring a bell?",
    ),
    v(
        "recover_cool",
        /\brecover(ing|y)\b.*\b(cooler|cool)\s+weather\b|\bcool(er)?\s+weather\b.*\brecover/i,
        "Lower temperatures sometimes reduce environmental stress and help recovery.",
        "Cooler nights can ease transpiration load — did the improvement track with a break in heat?",
    ),
    v(
        "no_random_guess",
        /\b(don'?t|do\s+not)\s+trust\b.*\b(random\s+)?guess|\bno\s+random\s+guess/i,
        "Good — decisions should be based on evidence and field context whenever possible.",
        "Agreed — we’ll stick to what you can see, measure, or photograph, and label guesses as guesses.",
    ),
    v(
        "humidity_up",
        /\b(humidity)\b.*\b(increased|rose|went\s+up|higher)\b|\b(after|since)\b.*\b(humidity)\b/i,
        "That timing could matter because humidity can influence fungal and leaf-surface conditions.",
        "A humidity step-up matters for leaf wetness hours — did nights stay warm and muggy right before symptoms?",
    ),
    v(
        "mixed_health",
        /\b(some|few)\s+plants?\b.*\b(healthy|fine)\b.*\b(others?|rest)\b|\b(mixed|patchy)\s+health\b/i,
        "Mixed health patterns often suggest uneven environmental or soil conditions.",
        "A split canopy usually screams uneven water, N, or soil — does the healthy strip follow equipment paths?",
    ),
    v(
        "image_later",
        /\b(upload|send)\b.*\b(image|photo|picture)\b.*\b(later)?\b|\b(image|photo)\s+later\b/i,
        "Absolutely. Visual evidence can help narrow possibilities much more accurately.",
        "Yes — even a few clear phone shots (top and underside of leaves) sharpen the next step a lot.",
    ),
    v(
        "weaker_week",
        /\b(feel|feels|feeling)\s+weaker\b.*\b(this\s+week|week)\b|\bweaker\s+this\s+week\b/i,
        "Has the weather changed significantly or has irrigation behavior shifted recently?",
        "A weekly fade often tracks weather or water — any heat spike, skipped irrigation, or new stressor this week?",
    ),
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
    for (const { id, re, variants } of SYMPTOM_RULES) {
        if (re.test(q)) {
            const body = pickRotated(`sympt_train_${id}`, variants);
            const lead = farmContextEmptyLead(ctx);
            return lead ? `${lead}${body}` : body;
        }
    }
    return null;
}
