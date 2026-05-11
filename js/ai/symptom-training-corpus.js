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
    v(
        "light_green_leaves",
        /\b(light\s+green|turning\s+light\s+green|pale\s+green)\b.*\bleaves?|\bleaves?\b.*\b(light\s+green|pale\s+green)\b/i,
        "Light green coloration can sometimes suggest nutrient stress or weakened growth activity.",
        "A washed-out green often tracks with N or general vigor dips — any recent fert change or wet/cold roots?",
    ),
    v(
        "tired_after_heatwave",
        /\b(tired|exhausted|beat)\b.*\bheat\s*wave|heatwave|after\s+the\s+heat|\bheat\s+wave\b.*\b(crop|plants?|field)\b/i,
        "Heat stress alone can slow recovery and weaken plant appearance for several days.",
        "After a big heat push, canopies can look flat for a while even as nights cool — are nights still warm?",
    ),
    v(
        "serious_or_normal",
        /\b(serious|normal)\b.*\b(or|vs)\b.*\b(serious|normal)\b|\bdon'?t\s+know\s+if\s+this\s+is\s+serious/i,
        "We’d need a bit more context before judging confidently. What symptoms are standing out most?",
        "Hard to label serious vs normal from one line — which symptom worries you first, and how fast did it move?",
    ),
    v(
        "field_unhealthy_overall",
        /\bfield\b.*\b(unhealthy|doesn'?t\s+feel\s+healthy|feels?\s+unhealthy|off)\b.*\b(overall|whole)|\bunhealthy\b.*\bfield\b.*\boverall/i,
        "Is the issue spreading evenly across the field or concentrated in patches?",
        "When the whole block feels off, I look for patch vs uniform — does it follow rows, lows, or edges?",
    ),
    v(
        "better_last_week",
        /\b(better|looked\s+better)\s+last\s+week|\blast\s+week\b.*\b(better|healthier)\b|\bworse\s+than\s+last\s+week/i,
        "Changes in weather, moisture, or environmental stress can shift field health fairly quickly.",
        "Week-to-week swings usually tie to water, heat, or something you changed — any irrigation or spray in between?",
    ),
    v(
        "dry_rough_leaves",
        /\b(leaves?|leaf)\b.*\b(dry|rough)\b|\b(dry|rough)\b.*\btexture\b.*\bleaf/i,
        "Dry leaf texture sometimes appears during heat or moisture stress conditions.",
        "Rough, papery leaves often stack with heat load or low humidity days — is the soil surface dry too?",
    ),
    v(
        "plants_bending",
        /\b(plants?|stems?)\b.*\b(bending|bent)\b|\bbending\b.*\b(plants?|stalks?)\b/i,
        "Bending can happen from wind, weak stems, water imbalance, or environmental stress.",
        "Lodging-ish bends can be wind, root slip, or uneven water — any gusty days or saturated soil?",
    ),
    v(
        "slower_recovery_expected",
        /\b(recover(ing|y))\b.*\b(slower|slow)\b.*\b(than\s+)?expected|\bslow(er)?\s+recovery\b.*\bexpect/i,
        "Slow recovery can happen when stress conditions are still partially active.",
        "If the stressor hasn’t fully eased (heat, wet feet, low energy), recovery lags — what’s still “on” in the field?",
    ),
    v(
        "soil_wet_too_long",
        /\bsoil\b.*\b(stays?|staying|remains)\b.*\b(wet|soggy)\b.*\b(long|too\s+long|days)|\bwet\b.*\btoo\s+long\b.*\bsoil/i,
        "Prolonged moisture can reduce root oxygen and increase environmental pressure.",
        "When soil hangs wet, roots gasp and disease pressure climbs — any compaction or low spots holding water?",
    ),
    v(
        "roots_unhealthy",
        /\broots?\b.*\b(unhealthy|bad|rotten|sick|not\s+healthy)|\b(unhealthy|weak)\b.*\broots?\b/i,
        "Are you noticing discoloration, odor, or weak plant anchoring near the roots?",
        "Root issues often show as stunting, off-color crowns, or easy pull — any smell or dark mush when you dig?",
    ),
    v(
        "tiny_yellow_spots",
        /\b(tiny|small)\s+yellow\s+spots?|\byellow\s+spots?\b.*\b(tiny|small|appearing)\b/i,
        "Small yellow spotting can come from several causes, including environmental or biological stress.",
        "Pinpoint yellow flecks can be many things — I wouldn’t name a pathogen from chat alone; a photo helps narrow.",
    ),
    v(
        "stress_after_fertilizer",
        /\b(stress|stressed|burn|yellow)\b.*\b(fertil|fert\b|nitrogen|urea)|\b(fertil|fert\b)\b.*\b(stress|after)/i,
        "Excessive or uneven fertilizer exposure can sometimes stress crops temporarily.",
        "A fert pulse can scorch or stall roots if rate or moisture was off — what product and rate, and any rain after?",
    ),
    v(
        "weather_sudden_change",
        /\bweather\b.*\b(sudden|changed\s+suddenly|shifted\s+suddenly)|\b(sudden|abrupt)\b.*\bweather\b/i,
        "Sudden environmental shifts can affect crop stability quite noticeably.",
        "Sharp swings in temp or humidity load the canopy fast — what flipped: heat, cold snap, or humidity?",
    ),
    v(
        "leaning_sideways",
        /\b(leaning|tilted)\b.*\b(sideways|side)|\bplants?\b.*\blean(ing)?\b.*\b(side|over)\b/i,
        "Wind exposure, weak rooting, or uneven moisture conditions can contribute to leaning.",
        "Side lean often pairs with shallow roots or wet/loose soil — any recent wind or irrigation blast?",
    ),
    v(
        "leaves_shrinking",
        /\bleaves?\b.*\b(shrink|shrinking|smaller)\b|\bshrink(ing)?\b.*\bleaves?\b/i,
        "Reduced leaf growth may happen during environmental or developmental stress.",
        "When leaves pull back, think energy: heat, drought, root constraint, or pest drain — which fits your week?",
    ),
    v(
        "insects_increasing",
        /\b(insects?|bugs?|pest)\b.*\b(increas|more|population|rising)\b|\bmore\s+insects?\b/i,
        "Are you seeing visible feeding damage or mostly insect presence around the field?",
        "More flyers don’t always mean damage — chewed tissue, mines, or honeydew would confirm pressure.",
    ),
    v(
        "crop_looks_dull",
        /\b(crop|plants?|canopy)\b.*\b(dull|muted|lackluster|flat)\b|\bdull\b.*\b(crop|plants?)\b/i,
        "Dull coloration sometimes appears when plant vigor is reduced.",
        "A tired sheen can be moisture, nutrition, or disease load — is it uniform or patchy across rows?",
    ),
    v(
        "improved_cooler_nights",
        /\b(improved|better)\b.*\b(cooler\s+nights|cool\s+nights)|\b(cooler|cool)\s+nights?\b.*\b(improved|helped|field)\b/i,
        "Lower nighttime temperatures can sometimes reduce accumulated stress.",
        "Cooler nights cut respiration load — did dew hours drop and leaves look perkier by morning?",
    ),
    v(
        "irrigation_schedule_wrong",
        /\birrigation\s+schedule\b.*\b(wrong|off|bad)|\b(may\s+be|might\s+be)\s+wrong\b.*\birrigation/i,
        "Timing and consistency can matter a lot. Has watering recently changed?",
        "If timing feels off, compare ET0 feel vs actual sets — any skipped sets, broken heads, or new crop stage?",
    ),
    v(
        "cant_figure_cause",
        /\b(can'?t|cannot)\s+figure\s+(out\s+)?(the\s+)?cause|\bno\s+idea\s+what'?s?\s+causing/i,
        "That’s okay. We can narrow it down step by step instead of jumping to conclusions.",
        "Totally fine — we’ll stack clues slowly: symptom, timing, last weather swing, last field change.",
    ),
    v(
        "partial_recovery",
        /\b(some|part)\b.*\b(recovered|better)\b.*\b(others?|rest|didn'?t)|\b(recovered|better)\b.*\b(some|others?)\b.*\b(didn'?t|not)\b/i,
        "Uneven recovery often points toward localized environmental differences.",
        "Split recovery usually maps to water/N/soil pockets — does the lag follow lows or headlands?",
    ),
    v(
        "leaves_folding_inward",
        /\b(leaves?|leaf)\b.*\b(fold(ing)?|curl)\b.*\b(inward|inwards)|\binward\b.*\bfold/i,
        "Leaf folding can happen during heat stress or moisture imbalance.",
        "Inward roll can conserve water under heat — are afternoons harsh and does it unfold overnight?",
    ),
    v(
        "vein_discoloration",
        /\b(veins?|vein)\b.*\b(discolor|yellow|dark|brown)|\bdiscoloration\b.*\bveins?\b/i,
        "Vein-related discoloration patterns can sometimes help narrow nutrient or stress conditions.",
        "Interveinal vs vein banding hints different issues — is the color change hugging veins or between them?",
    ),
    v(
        "weaker_after_humidity",
        /\b(weaker|stress)\b.*\b(humidity)\b.*\b(increased|rose|high)|\b(humidity)\b.*\b(increased|high)\b.*\b(weaker|stress)\b/i,
        "High humidity can influence stress recovery and fungal pressure.",
        "Sticky nights raise fungal hours — did leaf wetness linger after the humidity bump?",
    ),
    v(
        "dry_and_wet_patches",
        /\b(dry\s+patches?|wet\s+patches?)\b.*\b(together|same\s+field|both)|\bdry\b.*\b(wet|moist)\b.*\b(patch|patches)\b/i,
        "Uneven moisture distribution can create inconsistent plant health patterns.",
        "A wet/dry mosaic screams irrigation uniformity or soil texture — any sand lenses or head pressure issues?",
    ),
    v(
        "wind_stress_field",
        /\b(stress|stressed|beat\s+up)\b.*\b(strong\s+wind|wind)|\bwind\b.*\b(strong|gust|damag|stress)/i,
        "Wind can increase evaporation stress and physically strain crops.",
        "Gusty stretches desiccate margins and rock stems — any sandblast marks on windward rows?",
    ),
    v(
        "spray_or_wait",
        /\b(spray|spraying)\s+or\s+wait|\bwait\s+or\s+spray|\bwhether\s+to\s+spray\b/i,
        "I’d avoid rushing without clearer evidence. What symptoms are progressing most?",
        "Spray vs wait needs a target pest/path and stage — what’s actively getting worse day to day?",
    ),
    v(
        "uneven_recovery",
        /\brecover(ing|y)\b.*\b(very\s+)?uneven|\buneven\b.*\brecover/i,
        "Recovery variability often reflects soil or environmental differences across the field.",
        "Patchy bounce-back usually echoes soil moisture or N — does better ground align with higher ground?",
    ),
    v(
        "thinner_leaves",
        /\b(thinner|thin)\b.*\bleaves?|\bleaves?\b.*\b(thinner|thin)\b.*\b(usual|than)/i,
        "Thin leaf growth can sometimes indicate weakened vigor or developmental stress.",
        "Thin blades can mean low energy or pest drain — any mites or stippling under the leaf?",
    ),
    v(
        "healthier_rain_stopped",
        /\b(healthier|better)\b.*\b(rain|rainfall)\b.*\b(stopped|ended)|\brain\b.*\b(stopped|let\s+up)\b.*\b(better|healthier)/i,
        "Reduced prolonged moisture may have lowered environmental pressure on the plants.",
        "When rain backs off, roots breathe again — did standing water clear before the lift showed?",
    ),
    v(
        "slow_spread",
        /\b(spread(ing)?|spreading)\b.*\b(slow|slowly)|\b(slow|slowly)\b.*\bspread/i,
        "Slow spread patterns can still matter, especially alongside humid conditions.",
        "Slow creep still counts — is humidity high and leaves staying wet into the morning?",
    ),
    v(
        "field_stress_again",
        /\b(field|crop)\b.*\b(under\s+)?stress\s+again|\bstress\s+again\b.*\b(field|crop)\b/i,
        "Has anything changed recently with weather, irrigation, or field conditions?",
        "Another stress wave usually has a trigger — new heat, missed water, or a product pass in the last few days?",
    ),
    v(
        "lost_vigor_sudden",
        /\b(lost|lose|losing)\s+vigor|\bvigor\b.*\b(lost|sudden)|\bsudden(ly)?\b.*\b(vigor|energy)\b/i,
        "Sudden vigor loss usually points toward an environmental or biological stress trigger.",
        "A sharp vigor cliff often tracks a weather hit, chem stress, or root choke — what changed in 48–72h?",
    ),
    v(
        "plants_dehydrated",
        /\b(dehydrated|looks?\s+dehydrated)\b|\bplants?\b.*\b(dry\s+looking|parched)\b/i,
        "Does the soil also feel dry, or are the plants stressed despite moisture being present?",
        "Wilting with wet soil points to roots/oxygen; wilting with dry soil points to water — quick finger test?",
    ),
    v(
        "more_leaf_damage",
        /\b(more|increasing)\b.*\b(leaf\s+)?damage|\b(leaf\s+)?damage\b.*\b(more|than\s+before|worse)\b/i,
        "Is the damage concentrated in one area or appearing across the field?",
        "Spread pattern matters — edges vs center vs rows tells different stories; which pattern do you see?",
    ),
    v(
        "airflow_improved",
        /\b(improved|better)\b.*\b(airflow|air\s+flow|ventilation)|\b(airflow|air\s+flow)\b.*\b(increased|better)\b/i,
        "Better airflow can sometimes reduce moisture-related stress around leaves.",
        "Moving air dries canopies faster — did humidity drop or did you open canopy spacing?",
    ),
    v(
        "no_guesses_wanted",
        /\b(don'?t|do\s+not)\s+want\s+guess|\bno\s+guesses\b|\bwithout\s+guess/i,
        "Fair enough. It’s better to reason from actual field evidence than assume causes too early.",
        "Solid — we’ll label unknowns, use what you can verify, and only tighten claims when evidence supports it.",
    ),
    v(
        "inconsistent_color",
        /\b(inconsistent|uneven)\b.*\b(color|colour)\b.*\b(pattern|field)|\b(color|colour)\b.*\b(patterns?)\b.*\b(inconsistent|uneven)\b/i,
        "Uneven coloration can reflect moisture, nutrients, or localized stress conditions.",
        "Zebra color often maps to water/N stripes — any pivot overlap or fert overlap lines?",
    ),
    v(
        "weather_causing",
        /\b(think|guess)\b.*\bweather\b.*\b(causing|cause)|\bweather\b.*\b(causing|behind)\s+this/i,
        "Weather absolutely can influence crop stress patterns significantly.",
        "Weather is a legit prime suspect for rapid shifts — which variable moved most: heat, rain, or wind?",
    ),
    v(
        "crop_unstable",
        /\b(crop|field|plants?)\b.*\b(unstable|shaky|volatile|all\s+over\s+the\s+place)\b/i,
        "Environmental instability alone can create fluctuating stress symptoms.",
        "When the field feels jumpy day to day, look for unstable water or rolling weather — any of that lately?",
    ),
    v(
        "darker_leaves_mixed",
        /\b(some\s+)?leaves?\b.*\b(darker|darker\s+than)|\b(dark(er)?)\b.*\b(than\s+others|mixed)\b/i,
        "Mixed coloration can happen when plant stress affects sections unevenly.",
        "Dark patches beside pale can be moisture, N, or disease pockets — random or row-structured?",
    ),
    v(
        "simplest_explanation",
        /\b(simplest|simple)\b.*\b(explanation|answer)|\bkeep\s+it\s+simple\b/i,
        "Right now the field appears stressed, but the exact cause still needs clearer evidence.",
        "Short take: stress is visible, cause isn’t locked — crop + symptom photo would sharpen the next step.",
    ),
    v(
        "no_response_after_treatment",
        /\b(stopped|no)\s+responding\b.*\b(treatment|spray|product)|\b(after\s+treatment)\b.*\b(still|no\s+improve|worse)/i,
        "Some interventions take time, but persistent decline may need reevaluation of the root issue.",
        "If there’s zero response after a reasonable window, revisit diagnosis, rate, coverage, and timing vs stressor.",
    ),
    v(
        "weak_for_days",
        /\b(weak|stressed)\b.*\b(for\s+days|days\s+now|several\s+days)|\b(days)\b.*\b(weak|looking\s+bad)\b/i,
        "Long-lasting stress often points toward unresolved environmental or root-zone conditions.",
        "Multi-day slumps usually mean the stressor is still present — water, heat, or pathogen load still elevated?",
    ),
    v(
        "corners_differ",
        /\b(corners?|sections?|parts?)\b.*\b(different|differently)|\b(react|looks?)\b.*\b(different|differently)\b.*\b(corner|area)/i,
        "Microclimate and soil variation can create noticeable differences across the same field.",
        "Corner-to-corner differences love slope, shade, and soil texture — any map of wet/dry in your head?",
    ),
    v(
        "midday_stress",
        /\b(stress|wilt|looks?\s+bad)\b.*\b(mostly\s+)?(after\s+midday|midday|afternoon)\b|\b(after\s+midday)\b.*\b(stress|worse)\b/i,
        "Heat load and evaporation stress tend to peak around that time.",
        "Afternoon sag is often transpiration vs roots — does it recover after sunset?",
    ),
    v(
        "recovery_started",
        /\b(recovery|recovering)\b.*\b(started|begun|kicking\s+in)|\bthink\b.*\brecovery\b.*\bstarted/i,
        "That’s encouraging. Stable recovery trends are usually a positive sign.",
        "Good sign if the slide slowed — any new growth color or firmer leaves showing up?",
    ),
    v(
        "still_not_normal",
        /\b(still|doesn'?t)\b.*\b(normal|look\s+normal|back\s+to\s+normal)|\bnot\s+normal\s+yet\b/i,
        "Recovery often happens gradually rather than instantly after stress reduction.",
        "Canopies rarely snap back overnight — are you seeing small daily gains or a flat line?",
    ),
    v(
        "narrowing_help",
        /\b(need\s+help|help\s+me)\b.*\b(narrow|narrowing|figure\s+out)|\bnarrow(ing)?\s+this\s+down\b/i,
        "Let’s start with the basics:\n\n• crop type\n• recent weather\n• irrigation pattern\n• visible symptoms",
        "We can tighten this fast with four anchors: crop, last weather swing, irrigation habit, and the top 1–2 symptoms you see.",
    ),
    v(
        "condition_changes_daily",
        /\b(condition|field)\b.*\b(chang(e|ing)|shifts?)\b.*\b(every\s+day|daily)|\bdaily\b.*\b(chang|shift)\b/i,
        "Rapid environmental shifts can create fluctuating stress behavior across crops.",
        "Day-to-day whiplash usually means unstable moisture or weather — any irrigation or rain yo-yo pattern?",
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
