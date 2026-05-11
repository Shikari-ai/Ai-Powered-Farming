import "./auth-session.js?v=33";
import "./i18n.js?v=6";
import { auth, db } from "./auth.js?v=32";
import { getLang } from "./i18n.js?v=6";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { runAgriOrchestrator } from "./ai/orchestrator.js?v=73";
import { attachSnapshotForReply, composeAssistantReply, composeOperationsSnapshotReply } from "./ai/assistant-reply.js?v=72";
import { getAiConfig } from "./ai/config.js?v=71";
import {
  buildKnowledgeDocPayload,
  findMergeTargetEntry,
  findRelevantKnowledgeMemory,
  KNOWLEDGE_MEMORY_CAP,
  mergeKnowledgeEntries,
} from "./ai/assistant-knowledge-memory.js?v=1";
import { computeTurnConfidence, shouldUseWebAssistedResearch } from "./ai/web-research-policy.js?v=4";
import { fetchPublicAgriBrief, formatWebResearchAppend } from "./ai/web-research-client.js?v=6";
import {
  buildProactiveDigest,
  defaultCompanionProfile,
  mergeCompanionAfterTurn,
  normalizeCompanionProfile,
} from "./ai/companion-memory.js?v=48";
import { fetchRegionalBriefing } from "./network/regional-briefing.js";
import {
  buildCasualAssistantReply,
  buildMicroSocialAssistantReply,
  buildVagueSymptomReply,
  classifyAssistantRouting,
} from "./ai/assistant-intent-router.js?v=66";
import {
  detectConversationMood,
  polishFarmReportProse,
  pushRecentAssistantOpening,
} from "./ai/conversation-naturals.js?v=48";

import { runAssistantTextStream } from "./ai/assistant-stream.js?v=48";
import { computePresencePlan, maybePresenceMemoryNudge, sleep as presenceSleep } from "./ai/conversation-presence.js?v=48";
import { getFlowSnapshot, recordFlowUserTurn, resolveReplyVerbosity, streamRhythmPreference } from "./ai/conversation-flow.js?v=48";

const ROUTING_NO_ENGINE_LOG = /** @type {const} */ (["micro_social", "casual", "clarify", "operations_quick"]);

/** @param {string} text */
function inferReplyFormatNeeds(text) {
  const t = String(text || "");
  const bullet = t.match(/\b(?:only\s+with\s+|exactly\s+)?(\d+)(?:\s+\w+){0,2}\s+(?:bullets?|points?|actions?)\b/i);
  const step = !bullet ? t.match(/\b(?:only\s+with\s+|exactly\s+)?(\d+)\s+steps?\b/i) : null;
  const sentence = t.match(/\b(?:exactly|only)\s+(\d+)\s+sentences?\b/i);
  return {
    bulletCount: Number(bullet?.[1] || step?.[1] || 0) || 0,
    sentenceCount: Number(sentence?.[1] || 0) || 0,
    oneParagraphOnly: /\bone\s+(?:professional\s+)?paragraph\s+only\b/i.test(t),
  };
}

/** @param {string} text */
function splitToPlainLines(text) {
  return String(text || "")
    .split(/\r?\n+/)
    .map((s) => s.replace(/^[-*•]\s+/, "").trim())
    .filter(Boolean);
}

/** @param {string} text */
function compactParagraph(text) {
  return String(text || "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** @param {string} text */
function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || [];
}

/**
 * Enforce explicit response-shape asks like "3 bullets" / "one paragraph only".
 * @param {string} reply
 * @param {{ bulletCount: number, sentenceCount: number, oneParagraphOnly: boolean }} needs
 */
function enforceReplyShape(reply, needs) {
  let out = String(reply || "").trim();
  if (!out) return out;

  if (needs.bulletCount > 0) {
    const lines = splitToPlainLines(out);
    while (lines.length < needs.bulletCount) {
      lines.push("Re-check conditions in 24 hours and adjust the plan based on field observations.");
    }
    const picked = lines.slice(0, needs.bulletCount).map((s) => `- ${s}`);
    if (picked.length) out = picked.join("\n");
  }
  if (needs.sentenceCount > 0) {
    const parts = splitSentences(out);
    while (parts.length < needs.sentenceCount) {
      parts.push("Verify with local advisory guidance before operational rollout.");
    }
    out = parts.slice(0, needs.sentenceCount).join(" ");
  }
  if (needs.oneParagraphOnly) {
    out = compactParagraph(out);
  }
  return out;
}

/** @param {string} text */
function buildNoDataActionFallback(text) {
  const t = String(text || "").toLowerCase();
  if (/\bwheat\b.*\brust\b|\brust\b.*\bwheat\b/.test(t)) {
    return [
      "- Survey representative wheat patches now and mark rust hot-spots; prioritize upper canopy and field edges.",
      "- Reduce leaf wetness immediately (avoid evening irrigation, improve airflow) and prepare a label-compliant fungicide plan if spread is active.",
      "- Recheck within 24 hours with photo notes and escalate to local extension support if pustule spread increases.",
    ].join("\n");
  }
  if (/\bblight|spot|fung|disease|yellow|leaf\b/.test(t)) {
    return [
      "- Scout 20-30 plants now and isolate the worst patches; remove heavily affected leaves and avoid overhead watering tonight.",
      "- Keep canopy dry for 24h (morning-only irrigation, better airflow, no late spray unless label conditions are met).",
      "- Run one tagged scan tomorrow morning and log spread trend; escalate to a local agronomist if incidence is rising.",
    ].join("\n");
  }
  if (/\birrigat|drip|water|schedule\b/.test(t)) {
    return [
      "- Run short early-morning drip cycles (not noon), then verify moisture at 10-15 cm depth before adding another cycle.",
      "- Split total water into 2-3 pulses to reduce stress and runoff; prioritize uniform wetting in root zone.",
      "- Re-check by evening: if leaves still wilt after sunset, increase next-day total by a small increment (about 10-15%).",
    ].join("\n");
  }
  return [
    "- Start with a same-day field check and note the top 3 risks by severity.",
    "- Execute the lowest-risk corrective step first and avoid stacking multiple interventions at once.",
    "- Reassess in 24 hours and adjust using observed change, not assumptions.",
  ].join("\n");
}

/** @param {string} text */
function buildKnownAgriDefinitionReply(text) {
  const t = String(text || "").toLowerCase();
  if (/\b(what\s+is|full\s*form\s+of)\s+icar\b|\bicar\b.*\b(what|full\s*form)\b/.test(t)) {
    return "ICAR stands for Indian Council of Agricultural Research. It is India’s apex public agricultural research and education network under the Department of Agricultural Research and Education, Ministry of Agriculture.";
  }
  if (/\b(what\s+is|full\s*form\s+of)\s+msp\b|\bmsp\b.*\b(what|full\s*form)\b/.test(t)) {
    return "MSP stands for Minimum Support Price. It is a government-announced floor price for selected crops to protect farmers from sharp post-harvest price declines and support predictable farm income.";
  }
  if (/\b(what\s+is|define|full\s*form\s+of)\s+imd\b|\bimd\b.*\b(what|define|full\s*form)\b/.test(t)) {
    return "IMD stands for India Meteorological Department, the national weather service that issues forecasts and warnings for India.";
  }
  if (/\bwhat\s+does\s+mandi\s+mean\b|\bdefine\s+mandi\b|\bmandi\b.*\bmean\b/.test(t)) {
    return "In agri trade, a mandi is a regulated wholesale market yard where farmers and traders buy and sell produce.";
  }
  if (/\bfertilizer\s+subsidy\b/.test(t)) {
    return "Fertilizer subsidy in India is government financial support that reduces the effective cost of approved fertilizers for farmers. It is designed to keep essential nutrient inputs affordable and support crop productivity.";
  }
  return "";
}

/** @param {string} text */
function buildOneLineAgriDirectiveReply(text) {
  const t = String(text || "").toLowerCase();
  if (!/\b(one\s+line|single\s+line)\b/.test(t)) return "";
  if (/\byellow|yellowing|chlorosis|leaf\b/.test(t)) {
    return "First check root-zone moisture and recent watering because sudden yellowing is most often water-stress or root-oxygen stress before nutrient causes.";
  }
  if (/\bwilting|wilt\b/.test(t)) {
    return "First check recent irrigation, drainage, and root-zone moisture because sudden wilting is often drought shock, waterlogging, or root damage before you assume disease.";
  }
  if (/\bbest\s+time\b/.test(t) && /\birrigat/.test(t) && /\b(hot|summer)\b/.test(t)) {
    return "In hot summer, irrigate early morning (or cool evening only if night humidity stays low) to limit transpiration shock and long leaf wetness.";
  }
  return "";
}

/** @param {string} text */
function buildDeterministicTaskReply(text) {
  const t = String(text || "").toLowerCase();
  if (/\bare\s+you\s+(a\s+)?(bot|ai|human|an\s+ai\s+assistant)\b|\byou\s+a\s+bot\b/.test(t)) {
    return "I’m an AI farm assistant built to interpret your field, weather, and scan context and turn it into practical actions.";
  }
  if (/\bwheat\b.*\brust\b|\brust\b.*\bwheat\b/.test(t) && /\b(priority|plan|next\s+24\s+hours|actions?)\b/.test(t)) {
    return [
      "- Inspect representative wheat blocks now and mark rust hot-spots by severity.",
      "- Reduce leaf wetness immediately and prepare a label-compliant fungicide decision if spread is active.",
      "- Recheck within 24 hours and escalate to local extension support if pustule spread increases.",
    ].join("\n");
  }
  if ((/\b(weather|rain|forecast)\b/.test(t) && /\b(in|at)\s+[a-z][a-z\s-]{1,30}\b/i.test(text)) || /\bcurrent\s+weather\b/.test(t)) {
    let place = "your location";
    const mIn = String(text || "").match(/\b(?:in|at)\s+([A-Za-z][A-Za-z\s-]{1,30})/i);
    if (mIn) place = mIn[1].trim();
    else {
      const mLead = String(text || "").match(/^([A-Za-z][A-Za-z\s-]{1,24})\s+current\s+weather\b/i);
      if (mLead) place = mLead[1].trim();
    }
    return `To stay accurate, refresh live weather now from the Weather tab; I can then use ${place} conditions for precise actions.`;
  }
  if (/\b(step-?by-?step|priority\s+list|next\s+24\s+hours)\b/.test(t) && /\b(disease|spread|risk|irrigat|stress|rust|blight|spot)\b/.test(t)) {
    return [
      "- Confirm current spread zone and severity first (quick scouting pass + photo notes).",
      "- Execute one high-impact corrective action immediately and avoid stacking multiple treatments at once.",
      "- Re-check within 24 hours and escalate if spread continues despite intervention.",
    ].join("\n");
  }
  return "";
}

/** Work-audit and policy prompts that need reliable shape + accuracy without farm context. */
function buildWorkPackDirectReply(text) {
  const t = String(text || "").toLowerCase();

  if (/\be[\s-]?nam\b/.test(t) && /\b(2|two)\s+bullets?\b/.test(t)) {
    return [
      "- e-NAM is a national electronic trading portal that links APMC mandis for transparent online bidding and wider buyer discovery.",
      "- It aims to improve price discovery and reduce friction while keeping settlement aligned with notified mandi procedures.",
    ].join("\n");
  }
  if (/\bpm[\s-]?kisan\b/.test(t) && /\bone\s+sentence\b/.test(t)) {
    return "PM-KISAN is a central government income-support scheme that provides eligible landholding farmers fixed instalment assistance for farm and household needs.";
  }
  if (/\bpmfby\b|\bpradhan\s+mantri\s+fasal\s+bima\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Pradhan Mantri Fasal Bima Yojana (PMFBY) is a crop insurance program that covers yield losses from notified natural perils for eligible crops and seasons. It is designed to stabilize farm income after adverse weather through timely processes defined for enrollment, claims, and cut-offs.";
  }
  if (/\bintegrated\s+pest\s+management\b|\bwhat\s+is\s+ipm\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Integrated Pest Management (IPM) combines scouting, cultural tactics, resistant varieties, and targeted controls to keep pests below economic injury levels. It emphasizes minimizing unnecessary pesticide use while protecting yield and beneficial organisms.";
  }
  if (/\bnavdanya\b/.test(t) && /\bone\s+sentence\b/.test(t)) {
    return "Navdanya is an Indian biodiversity and seeds movement focused on conserving native varieties, promoting ecological farming, and strengthening farmer seed sovereignty.";
  }
  if (/\borganic\s+certification\b/.test(t) && /\bindia\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Organic certification in India follows third-party standards and inspections to verify that production avoids prohibited synthetics and meets permitted input rules. Farmers maintain records, undergo audits, and may use recognized marks once approved.";
  }
  if (/\bicar\b/.test(t) && /\b(role|functions?|what\s+does)\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "ICAR coordinates a national network of agricultural research institutes and agricultural universities to generate technologies and training. Its role is to strengthen productivity, sustainability, and resilience by linking science, education, and extension.";
  }
  if (/\bmandi\b/.test(t) && /\b(regulation|regulated|apmc)\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Mandi regulation in India typically operates through state APMC Acts that license yards, levy fees, and set conduct rules for traders and commission agents. The framework aims for transparent auctions, fair weighment, and orderly trade while states set operational details.";
  }
  if (/\brice\s+blast\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Rice blast is a fungal disease favored by warm, humid canopies and prolonged leaf wetness. Management combines resistant varieties where available, balanced nitrogen, canopy management, and timely fungicide use when advisory thresholds are met.";
  }
  if (/\bdeficit\s+irrigation\b/.test(t) && /\bwheat\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Deficit irrigation in wheat deliberately supplies less water than full crop demand during selected stages to save water while limiting yield loss. It requires careful timing—avoiding severe stress during tillering and grain filling—and monitoring soil moisture.";
  }
  if (/\bsalinity\b/.test(t) && /\birrigation\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Poor-quality or salty irrigation water can raise soil salinity and damage roots over time. Mitigation includes water testing, drainage, leaching with better-quality water when feasible, organic matter, and salt-tolerant rotations where needed.";
  }
  if (/\bcold\s+chain\b/.test(t) && /\bvegetables?\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Cold chain for vegetables uses rapid cooling after harvest and controlled temperatures to slow respiration and decay. Clean handling, suitable packaging, and avoiding temperature swings from field to market preserve shelf life.";
  }
  if (/\bgrain\s+storage\b/.test(t) && /\bmoisture\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Safe grain storage starts at appropriate moisture before bagging or bin storage to limit mold and insects. Monitor temperature and moisture, use aeration where designed, and act quickly on hot spots or off-odors.";
  }
  if (/\brecord\s+keeping\b/.test(t) && /\bharvest\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Harvest records should capture dates, plots, quantities, grades, and storage destinations for traceability. Pairing these notes with input logs simplifies marketing, compliance, and next-season planning.";
  }
  if (/\brelative\s+humidity\b/.test(t) && /\bdisease\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "High relative humidity extends leaf wetness, helping fungal spores and bacterial films spread. Managing humidity through airflow, irrigation timing, and spacing is a core disease-prevention lever.";
  }
  if (/\bagricultural\s+drought\b/.test(t) || (/\bdrought\b/.test(t) && /\bawareness\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t))) {
    return "Agricultural drought ties rainfall or soil moisture shortfalls to crop stress and yield risk, beyond a single dry day on a map. Early warning combines rainfall deficits, storage status, soil moisture proxies, and crop-stage sensitivity.";
  }
  if (/\bfrost\b/.test(t) && /\b(risk|crops?)\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Frost risk rises on clear, calm nights when surface temperatures fall below freezing and damage sensitive tissue. Mitigation includes planting timing, covers where feasible, and heeding local forecasts for radiation frost setups.";
  }
  if (/\bheatwave\b|\bheat\s+wave\b/.test(t) && /\bmitigation\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Shift irrigation toward early morning, verify soil moisture at root depth, and avoid mid-day sprinkling that scalds tissue.",
      "- Reduce heat stress operations at peak hours; widen airflow paths in canopy where still safe for the crop.",
      "- Scout daily for wilting, sunburn, and pest flares; log hotspots for next-season planning.",
    ].join("\n");
  }
  if (/\b(unknown|unsure)\b/.test(t) && /\bdisease\b/.test(t) && /\boutbreak\b/.test(t) && /\b(5|five)\s+bullets?\b/.test(t)) {
    return [
      "- Mark affected patch boundaries and limit tool movement between clean and suspect areas until spread is understood.",
      "- Capture clear close-up and distance photos; note growth stage, recent sprays, and irrigation changes.",
      "- Segregate suspect lots from clean harvest streams and avoid saving seed from diseased areas pending ID.",
      "- Contact extension or an accredited lab with samples using their submission protocol.",
      "- Preserve input batch records for the last two weeks to speed diagnosis and compliance review.",
    ].join("\n");
  }
  if (/\bone\s+professional\s+paragraph\s+only\b/.test(t) && /\bsoil\s+testing\b/.test(t)) {
    return "Soil testing replaces guesswork on fertilizer by revealing pH, organic matter, and available nutrients for your field. A representative composite sample at the right depth and season, analyzed by a credible lab, becomes a practical map for liming, basal and top-dress splits, and micronutrient fixes. Re-test on a sensible rotation—often every two to three years or after major yield shifts—so you track trends, catch salinity or compaction-related issues early, and keep input costs aligned with realistic targets.";
  }
  if (/\bmoisture\s+sensor\b/.test(t) && /\bfeel\b/.test(t) && /\b(2|two)\s+bullets?\b/.test(t)) {
    return [
      "- Sensors give repeatable depth-specific readings that scale across crews and fields when placed and calibrated well.",
      "- Hand-feel checks still validate placement, drift, and odd soil layers a single probe might miss.",
    ].join("\n");
  }
  if (/\bmulch(?:ing)?\b/.test(t) && /water|moisture|conserv/i.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Apply mulch after soil is moist and weeds are controlled so it locks moisture rather than sealing dry soil.",
      "- Keep mulch off stems to limit collar rot and allow transpiration at the base.",
      "- Replenish after wind loss and watch for pest habitat; adjust thickness by crop and season.",
    ].join("\n");
  }
  if (/\brain\b/.test(t) && /\bforecast\b/.test(t) && /\birrigation\b/.test(t) && /\bschedule\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Skip or trim cycles when meaningful rain is likely in 24–48 hours, with a resume plan if the storm misses.",
      "- Avoid topping off a full profile right before heavy rain; prioritize root-zone need over habit.",
      "- After rain, reassess infiltration versus runoff before resuming heavy machinery passes.",
    ].join("\n");
  }
  if (/\bwind\b/.test(t) && /\bdrift\b/.test(t) && /\bspray\b/.test(t) && /\b(2|two)\s+bullets?\b/.test(t)) {
    return [
      "- Spray only in stable wind within label limits, use drift-reducing nozzles, and protect downwind sensitive areas.",
      "- If gusts rise, stop application and log conditions; partial coverage wastes product and raises off-target risk.",
    ].join("\n");
  }
  if (/\b(burn|incorporat)/.test(t) && /\bresidue\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Where rules allow, incorporating residue recycles nutrients and builds organic matter; avoid burning unless regulation or safety demands it.",
      "- Burning removes carbon quickly and can violate air-quality rules while harming soil biology.",
      "- If incorporating, balance fertility so decomposition does not immobilize nitrogen early in the next crop.",
    ].join("\n");
  }
  if (/\blabor\b/.test(t) && /\bpeak\s+season\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Sequence harvest and packing with a roster and backup call list for surge days.",
      "- Pre-stage tools, cold storage, and transport to cut idle minutes in peak windows.",
      "- Run short safety and hydration briefings because fatigue drives injury and quality errors.",
    ].join("\n");
  }
  if (/\bcalibrat/i.test(t) && /\b(sprayer|spray\s+rig|spray\s+equipment)\b/i.test(t) && /\b(2|two)\s+bullets?\b/.test(t)) {
    return [
      "- Calibrate using measured flow rate, travel speed, and swath width; adjust pressure or nozzles to hit label volume per hectare.",
      "- Re-check after nozzle wear or major equipment changes and keep a written log per field pass.",
    ].join("\n");
  }
  if (/\bscouting\b/.test(t) && /\broutine\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Walk a fixed pattern weekly, sampling edges and interior rows where pressure often differs.",
      "- Score pests, diseases, beneficials, and growth stage so trends compare week to week.",
      "- Photo-tag anomalies immediately so advisers can interpret without a repeat visit.",
    ].join("\n");
  }
  if (/\bhigh\s+humidity\b/.test(t) && /\bfungal\b/.test(t) && /\b(4|four)\s+bullets?\b/.test(t)) {
    return [
      "- Shorten leaf wetness: shift away from evening irrigation and improve airflow where safe.",
      "- Scout lower canopy and sheltered rows where humidity lingers after sunrise.",
      "- Avoid unnecessary fine mists that extend wetting time beyond what the crop needs.",
      "- Base fungicide timing on verified risk, stage, and PHI—not calendar guesses alone.",
    ].join("\n");
  }
  if (/\bbacterial\b/.test(t) && /\bleaf\s+spot\b/.test(t) && /\b(capsicum|pepper)\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Limit splash: avoid overhead irrigation and working wet foliage across plants.",
      "- Remove heavily infected tissue with sanitized tools; bag debris leaving the field when practical.",
      "- Use copper or other label options strictly per label and local resistance guidance.",
    ].join("\n");
  }
  if (/\bpowdery\s+mildew\b/.test(t) && /\bgrape\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Open canopy for sun and air; remove shoots that shade clusters when training allows.",
      "- Scout young tissue and upper surfaces early; colonies often start there.",
      "- Time sprays to label growth stages and local thresholds rather than habit alone.",
    ].join("\n");
  }
  if (/\bpaddy\b|\brice\b/.test(t) && /\bwater\s+stress\b/.test(t) && /\b(2|two)\s+sentences?\b/.test(t)) {
    return "Paddy can show stress from drought or from poor water management that limits root oxygen. Stage water depth to the crop, drain briefly if stagnation raises disease risk, and refill based on soil checks rather than a rigid calendar.";
  }
  if (/\bdrip\b/.test(t) && /\b(maize|corn)\b/.test(t) && /\bsummer\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Align high-frequency, low-volume cycles with peak demand around flowering and grain fill.",
      "- Flush and verify emitter uniformity before mid-season heat and dust increase clog risk.",
      "- Probe 30–40 cm depth to confirm the wetting front before raising totals.",
    ].join("\n");
  }
  if (/\bheatwave\b|\bheat\s+wave\b/.test(t) && /\birrigation\b/.test(t) && /\b(correct|fix|adjust)\b/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Move most water to pre-dawn windows; use short rescue pulses only if wilting threatens permanent damage.",
      "- Increase monitoring because ET spikes can outpace yesterday’s plan.",
      "- After the heat spell, ramp down gradually to limit leaching and anaerobic pockets.",
    ].join("\n");
  }
  if (/\bcotton\b/.test(t) && /\bover[\s-]?irrigat/.test(t) && /\b(3|three)\s+bullets?\b/.test(t)) {
    return [
      "- Pause irrigation until drainage improves; waterlogged roots drive oxygen stress and rot.",
      "- Scout for wilting with wet soil—a red flag to shorten cycles only after water can move through the profile.",
      "- Resume scheduling using depth moisture checks rather than leaf appearance alone.",
    ].join("\n");
  }
  if (/\btomato\b/.test(t) && /\bearly\s+blight\b/.test(t) && /\b(4|four)\s+bullets?\b/.test(t)) {
    return [
      "- Scout and remove heavily spotted lower leaves; bag debris to reduce spore rain on fruiting canopy.",
      "- Keep foliage dry: morning-only irrigation, improve airflow, avoid working wet plants.",
      "- Apply protectant fungicide per label once disease is present and repeat on label interval with PHI respected.",
      "- Rotate modes of action next season and choose resistant varieties where markets allow.",
    ].join("\n");
  }
  if (/\baphids?\b/.test(t) && /\bchilli\b|\bchili\b|\bpepper\b/.test(t) && /\b(2|two)\s+bullets?\b/.test(t)) {
    return [
      "- Flush aphids with a firm water spray on small plants and release beneficials where practical.",
      "- If thresholds warrant, use a label-compliant selective option and preserve pollinators with timing and placement.",
    ].join("\n");
  }
  if (/\bno\s+scan\b/.test(t) && /\bleaf\s+spots?\b/.test(t) && /\b(2|two)\s+bullets?\b/.test(t)) {
    return [
      "- Scout a transect now with dated photos; note pattern (uniform vs scattered) and recent irrigation or sprays.",
      "- Avoid aggressive trimming or stacked sprays until you have a working ID—stabilize moisture and airflow first.",
    ].join("\n");
  }
  return "";
}

/** @param {Record<string, unknown>} o */
function stripUndefinedForFirestore(o) {
  const out = {};
  for (const [k, v] of Object.entries(o || {})) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** @param {{ id: string, data: () => any }} d */
function normalizeKnowledgeMemoryDoc(d) {
  const x = d.data();
  const lastR = x.lastReinforcedAt;
  const lastRMs =
    lastR && typeof lastR.toMillis === "function"
      ? lastR.toMillis()
      : typeof lastR === "string"
        ? Date.parse(lastR) || 0
        : 0;
  return {
    id: d.id,
    ...x,
    lastUsedAtMs: x.lastUsedAt?.toMillis?.() ?? 0,
    createdAtMs: x.createdAt?.toMillis?.() ?? 0,
    lastReinforcedAtMs: lastRMs,
  };
}

function el(id) {
  return document.getElementById(id);
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function formatTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Walk up to a scrollable parent (else document). */
function getAssistantScrollRoot(fromEl) {
  let p = fromEl;
  while (p && p !== document.body) {
    const st = getComputedStyle(p);
    const oy = st.overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight + 1) return p;
    p = p.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

function renderMessages(container, msgs, opts = {}) {
  if (!container) return;
  const awaitingId = opts.awaitingUserMsgId || null;
  const stream = opts.streamingAssistant || null;
  const supersededIds = opts.supersededIds || new Set();
  const showTyping =
    !!awaitingId &&
    msgs.some((m) => m.id === awaitingId && m.role === "user") &&
    !stream;

  const sorted = msgs.slice().sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
  const partsHtml = sorted
    .map((m) => {
      const role = m.role === "user" ? "user" : "assistant";
      const who = role === "user" ? "You" : "Assistant";
      const time = formatTime(tsToMs(m.createdAt));
      const safe = String(m.text || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
      const supersededBadge =
        role === "user" && supersededIds.has(m.id)
          ? `<div class="msg-superseded" aria-label="Superseded by the next message">superseded by your next message</div>`
          : "";
      return `
        <div class="msg ${role}${role === "user" && supersededIds.has(m.id) ? " is-superseded" : ""}">
          <div class="meta"><span>${who}</span><span>${time}</span></div>
          <div class="text">${safe}</div>
          ${supersededBadge}
        </div>
      `;
    })
    .join("");

  const streamHtml = stream
    ? `
    <div class="msg assistant streaming-reply thinking" data-stream-shell="1" aria-live="polite" aria-busy="true">
      <div class="meta"><span>Assistant</span><span>…</span></div>
      <div class="stream-thinking-glow" aria-hidden="true"></div>
      <div class="text stream-text-host is-streaming" data-stream-text="1"><span class="stream-plain"></span><span class="stream-caret" aria-hidden="true"></span></div>
    </div>`
    : "";

  const typingHtml = showTyping
    ? `
    <div class="msg assistant typing" aria-live="polite" aria-busy="true">
      <div class="meta"><span>Assistant</span><span>…</span></div>
      <div class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>`
    : "";

  container.innerHTML = partsHtml + streamHtml + typingHtml;
}

function buildAssistantReply({ question, fields, scans, recs, weatherLogs }) {
  const q = question.toLowerCase();

  const fieldCount = fields.length;
  const scanCount = scans.length;
  const latestScan = scans.slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))[0] || null;
  const latestWeather = weatherLogs.slice().sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt))[0] || null;

  const lines = [];

  // Always ground the response in real state first.
  lines.push(`Current state: ${fieldCount} field${fieldCount === 1 ? "" : "s"}, ${scanCount} scan${scanCount === 1 ? "" : "s"}.`);

  if (q.includes("start") || q.includes("setup") || q.includes("begin")) {
    if (!fieldCount && !scanCount) {
      lines.push("");
      lines.push("To activate analytics:");
      lines.push("- Add your first field in Fields.");
      lines.push("- Run your first crop scan and save it.");
      lines.push("- (Optional) Enable location to build weather logs.");
      return lines.join("\n");
    }
  }

  if (q.includes("latest") || q.includes("last scan") || q.includes("scan")) {
    if (!latestScan) {
      lines.push("");
      lines.push("No scans yet. Run a scan to generate your first health score and recommendations.");
      return lines.join("\n");
    }
    const health = typeof latestScan.healthScore === "number" ? `${Math.round(latestScan.healthScore)}%` : "--";
    const diag = latestScan.diagnosis?.label || "Scan saved";
    lines.push("");
    lines.push(`Latest scan: ${latestScan.cropType || "Crop"} • ${diag} • Health ${health}.`);
    if (latestScan.recommendations && latestScan.recommendations.length) {
      lines.push("Top actions:");
      for (const r of latestScan.recommendations.slice(0, 3)) lines.push(`- ${r.text}`);
    }
    return lines.join("\n");
  }

  if (q.includes("recommend") || q.includes("insight") || q.includes("next action")) {
    const active = recs.filter((r) => (r.status || "active") === "active");
    if (!active.length) {
      lines.push("");
      lines.push("No recommendations yet. Recommendations appear after you save scans (and later: weather/sensor logs).");
      return lines.join("\n");
    }
    active.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    lines.push("");
    lines.push("Latest recommendations:");
    for (const r of active.slice(0, 5)) lines.push(`- ${r.text}`);
    return lines.join("\n");
  }

  if (q.includes("weather") || q.includes("rain") || q.includes("humidity")) {
    if (!latestWeather) {
      lines.push("");
      lines.push("No weather logs yet. Enable location in the app to sync real weather data into your account.");
      return lines.join("\n");
    }
    const c = latestWeather.city || "your area";
    const cur = latestWeather.current || {};
    const t = typeof cur.temperature_2m === "number" ? `${Math.round(cur.temperature_2m)}°C` : "--";
    const hum = typeof cur.relative_humidity_2m === "number" ? `${Math.round(cur.relative_humidity_2m)}%` : "--";
    lines.push("");
    lines.push(`Latest weather log (${c}): Temp ${t}, Humidity ${hum}.`);
    return lines.join("\n");
  }

  if (q.includes("field")) {
    if (!fieldCount) {
      lines.push("");
      lines.push("No fields yet. Add a field to unlock per-field monitoring and coverage metrics.");
      return lines.join("\n");
    }
    lines.push("");
    lines.push("Your fields:");
    for (const f of fields.slice(0, 5)) lines.push(`- ${f.name || "Field"}${f.cropType ? ` (${f.cropType})` : ""}`);
    if (fieldCount > 5) lines.push(`- …and ${fieldCount - 5} more`);
    return lines.join("\n");
  }

  // Default: safe, minimal guidance without pretending.
  lines.push("");
  if (!fieldCount && !scanCount) {
    lines.push("I don’t have enough activity to analyze yet. Add a field or save a scan and I’ll adapt immediately.");
  } else {
    lines.push("Ask about your latest scan, recommendations, weather logs, or field coverage and I’ll answer using your real data.");
  }
  return lines.join("\n");
}

/** @type {Array<() => void>} */
let activeSubscriptions = [];
function teardownSubscriptions() {
  for (const u of activeSubscriptions) {
    try { u?.(); } catch (e) { console.warn("[assistant] teardown:", e); }
  }
  activeSubscriptions = [];
}

onAuthStateChanged(auth, (user) => {
  // Auth callbacks can fire multiple times (token refresh, sign-out+in,
  // multi-tab). Tear down any prior snapshot listeners before re-binding,
  // otherwise each refresh stacks another full set of Firestore reads.
  teardownSubscriptions();

  if (!user) {
    window.location.href = "login.html";
    return;
  }

  const listEl = el("assistant-messages");
  document.body.classList.add("assistant-page");

  const emptyEl = el("assistant-empty");
  const inputEl = el("assistant-input");
  inputEl?.addEventListener("focus", () => document.body.classList.add("assistant-composer-focus"));
  inputEl?.addEventListener("blur", () => document.body.classList.remove("assistant-composer-focus"));
  const sendBtn = el("assistant-send");
  const clearBtn = el("assistant-clear");
  const subEl = el("assistant-subtitle");

  let fields = [];
  let scans = [];
  let recs = [];
  let weatherLogs = [];
  let environmental = [];
  let fieldContextStates = [];
  let farmInterventions = [];
  let farmOperationalTasks = [];
  let assistantAlerts = [];
  let pendingImageBlob = null;
  let companionProfile = defaultCompanionProfile(user.uid);
  let lastMsgCount = 0;
  let chatMessages = [];
  /** While set, UI shows a typing row after this user message (until assistant stream starts). */
  let awaitingAssistantAfterUserId = null;
  /** When true, message list repaint during Firestore snapshot is skipped (stream owns DOM). */
  let streamInFlight = false;
  /** Live client-side stream shell; assistant row is persisted after stream completes. */
  let streamingAssistant = null; // { fullText: string, userMsgId: string, profile: string }
  /** Per-send generation; new send aborts previous stream via signal + generation check. */
  let sendGeneration = 0;
  let streamAbort = new AbortController();
  /** User-message IDs whose assistant reply was aborted by the user sending a follow-up. */
  const supersededUserMsgIds = new Set();
  /** Tracks the user-msg ID of the currently in-flight turn so we can mark it superseded on abort. */
  let currentTurnUserMsgId = null;
  /** @type {{ promise: Promise<string>, fastForward: () => void } | null} */
  let activeStreamCtrl = null;
  /** User scrolled up → stop following; near bottom again → resume follow. */
  let followPinnedBottom = true;
  const SCROLL_NEAR_BOTTOM_PX = 110;
  /** @type {HTMLElement | null} */
  let listScrollRoot = null;
  /** Cached anonymized regional briefing; `fetchRegionalBriefing` also rate-limits reads. */
  let regionalBriefingText = null;
  /** Latest `learning_profiles/{uid}` (may be absent until first aggregation). */
  let learningProfile = null;
  /** Cached `assistant_knowledge_memory` rows for this user (bounded query). */
  let knowledgeMemoryEntries = [];

  listScrollRoot = getAssistantScrollRoot(listEl);
  listScrollRoot.addEventListener(
    "scroll",
    () => {
      const r = listScrollRoot;
      if (!r) return;
      const near = r.scrollHeight - r.scrollTop - r.clientHeight < SCROLL_NEAR_BOTTOM_PX;
      followPinnedBottom = near;
    },
    { passive: true },
  );

  inputEl?.addEventListener("input", () => {
    if (streamInFlight && activeStreamCtrl) activeStreamCtrl.fastForward();
  });

  function updateCompanionEmptyHint() {
    const hintEl = el("assistant-companion-hint");
    const railBody = el("assistant-rail-body");
    if (!hintEl) return;
    if (lastMsgCount !== 0) {
      hintEl.textContent = "";
      hintEl.classList.add("hidden");
      if (railBody) {
        railBody.textContent = "";
        railBody.classList.add("hidden");
      }
      return;
    }
    const live = buildProactiveDigest({ fields, scans, fieldContextStates, weatherLogs, recs });
    const text = (companionProfile.proactiveDigest || "").trim() || live;
    const regHint =
      regionalBriefingText && regionalBriefingText.length > 30
        ? `\n\nRegional network (coarse, anonymized): ${regionalBriefingText.slice(0, 240).trim()}${
            regionalBriefingText.length > 240 ? "…" : ""
          }`
        : "";
    const full = text + regHint;
    hintEl.textContent = full;
    hintEl.classList.toggle("hidden", !full.trim());
    if (railBody) {
      railBody.textContent = full;
      railBody.classList.toggle("hidden", !full.trim());
    }
  }

  function paintChat() {
    const hasStreamShell = !!streamingAssistant;
    if (emptyEl) emptyEl.classList.toggle("hidden", chatMessages.length > 0 || hasStreamShell);
    renderMessages(listEl, chatMessages, {
      awaitingUserMsgId: awaitingAssistantAfterUserId,
      streamingAssistant,
      supersededIds: supersededUserMsgIds,
    });
    updateCompanionEmptyHint();
    const root = listScrollRoot || getAssistantScrollRoot(listEl);
    if (followPinnedBottom) {
      requestAnimationFrame(() => {
        try {
          root.scrollTo({ top: root.scrollHeight, behavior: "auto" });
        } catch {
          root.scrollTop = root.scrollHeight;
        }
      });
    }
  }

  activeSubscriptions.push(
    onSnapshot(doc(db, "companion_profiles", user.uid), (snap) => {
      companionProfile = normalizeCompanionProfile(snap.data(), user.uid);
      updateCompanionEmptyHint();
    }),
  );

  activeSubscriptions.push(
    onSnapshot(doc(db, "learning_profiles", user.uid), (snap) => {
      learningProfile = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      updateCompanionEmptyHint();
    }),
  );

  let fallbackKnowledgeListener = false;
  const knowledgeMemQ = query(
    collection(db, "assistant_knowledge_memory"),
    where("userId", "==", user.uid),
    orderBy("lastUsedAt", "desc"),
    limit(40),
  );
  const unsubKnowledge = onSnapshot(
    knowledgeMemQ,
    (snap) => {
      knowledgeMemoryEntries = snap.docs.map((d) => normalizeKnowledgeMemoryDoc(d));
    },
    (err) => {
      const msg = String(err?.message || err || "");
      if (!fallbackKnowledgeListener && /requires an index|failed-precondition/i.test(msg)) {
        fallbackKnowledgeListener = true;
        // Fallback keeps assistant usable even if composite index is missing.
        const fallbackQ = query(
          collection(db, "assistant_knowledge_memory"),
          where("userId", "==", user.uid),
          limit(40),
        );
        const unsubFallback = onSnapshot(
          fallbackQ,
          (snap) => {
            const rows = snap.docs.map((d) => normalizeKnowledgeMemoryDoc(d));
            rows.sort((a, b) => (b.lastUsedAtMs || 0) - (a.lastUsedAtMs || 0));
            knowledgeMemoryEntries = rows;
          },
          (fallbackErr) =>
            console.warn("[assistant] knowledge memory fallback listener:", fallbackErr?.message || fallbackErr),
        );
        activeSubscriptions.push(unsubFallback);
        console.warn("[assistant] knowledge memory index missing; using fallback query.");
        return;
      }
      console.warn("[assistant] knowledge memory listener:", msg);
    },
  );
  activeSubscriptions.push(unsubKnowledge);

  const attachInput = el("assistant-attach-input");
  const attachBtn = el("assistant-attach");

  if (subEl) {
    const cfg = getAiConfig();
    const dataHint = cfg.inferenceBaseUrl
      ? "vision API + your farm data"
      : "live weather + your Firestore data";
    subEl.textContent = `On-device intelligence • ${dataHint}`;
  }

  fetchRegionalBriefing(db)
    .then((t) => {
      regionalBriefingText = t;
      updateCompanionEmptyHint();
    })
    .catch(() => {});

  const refreshAttachUi = () => {
    if (!attachBtn) return;
    attachBtn.classList.toggle("has-file", !!pendingImageBlob);
    attachBtn?.setAttribute("aria-label", pendingImageBlob ? "Replace attached image" : "Attach crop photo");
  };

  const msgsQ = query(collection(db, "assistant_messages"), where("userId", "==", user.uid), limit(200));
  activeSubscriptions.push(
    onSnapshot(msgsQ, (snap) => {
      const msgs = [];
      snap.forEach((d) => msgs.push({ id: d.id, ...d.data() }));
      lastMsgCount = msgs.length;
      chatMessages = msgs;
      if (!streamInFlight) paintChat();
    }),
  );

  activeSubscriptions.push(
    onSnapshot(query(collection(db, "fields"), where("userId", "==", user.uid), limit(200)), (snap) => {
      fields = [];
      snap.forEach((d) => fields.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(500)), (snap) => {
      scans = [];
      snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "ai_recommendations"), where("userId", "==", user.uid), limit(200)), (snap) => {
      recs = [];
      snap.forEach((d) => recs.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(50)), (snap) => {
      weatherLogs = [];
      snap.forEach((d) => weatherLogs.push({ id: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "environmental_data"), where("userId", "==", user.uid), limit(40)), (snap) => {
      environmental = [];
      snap.forEach((d) => environmental.push({ id: d.id, ...d.data() }));
    }),
  );
  activeSubscriptions.push(
    onSnapshot(query(collection(db, "field_context_state"), where("userId", "==", user.uid), limit(40)), (snap) => {
      fieldContextStates = [];
      snap.forEach((d) => fieldContextStates.push({ id: d.id, fieldId: d.id, ...d.data() }));
      updateCompanionEmptyHint();
    }),
  );

  activeSubscriptions.push(
    onSnapshot(
      query(collection(db, "farm_interventions"), where("userId", "==", user.uid), limit(120)),
      (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => tsToMs(b.performedAt) - tsToMs(a.performedAt));
        farmInterventions = rows.slice(0, 48);
        updateCompanionEmptyHint();
      },
    ),
  );

  activeSubscriptions.push(
    onSnapshot(
      query(collection(db, "farm_operational_tasks"), where("userId", "==", user.uid), limit(120)),
      (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
        farmOperationalTasks = rows.slice(0, 48);
        updateCompanionEmptyHint();
      },
    ),
  );

  activeSubscriptions.push(
    onSnapshot(
      query(collection(db, "alerts"), where("userId", "==", user.uid), limit(80)),
      (snap) => {
        const rows = [];
        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
        rows.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
        assistantAlerts = rows.slice(0, 40);
        updateCompanionEmptyHint();
      },
    ),
  );

  attachBtn?.addEventListener("click", () => attachInput?.click());
  attachInput?.addEventListener("change", () => {
    const f = attachInput.files?.[0];
    if (!f || !String(f.type || "").startsWith("image/")) return;
    pendingImageBlob = f;
    refreshAttachUi();
    attachInput.value = "";
  });

  async function send() {
    const text = (inputEl?.value || "").trim();
    const imageBlob = pendingImageBlob;
    if (!text && !imageBlob) return;

    pendingImageBlob = null;
    refreshAttachUi();

    const hadPriorStreamInterrupt = streamInFlight;
    // If we're aborting a turn that was either awaiting an assistant reply or
    // actively streaming one, mark its originating user message as superseded
    // so the transcript reads coherently (no orphan unanswered question).
    if (currentTurnUserMsgId && (streamInFlight || awaitingAssistantAfterUserId)) {
      supersededUserMsgIds.add(currentTurnUserMsgId);
    }
    streamAbort.abort();
    streamAbort = new AbortController();
    sendGeneration += 1;
    const myGen = sendGeneration;
    followPinnedBottom = true;

    if (sendBtn) sendBtn.disabled = true;
    if (inputEl) inputEl.value = "";

    try {
      const flowTurnText = text || (imageBlob ? "(Image attached)" : "");
      recordFlowUserTurn({ text: flowTurnText, hadPriorStreamInterrupt: hadPriorStreamInterrupt });
      const flowSnap = getFlowSnapshot();

      const userMsgRef = await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "user",
        text: text || (imageBlob ? "(Image attached)" : ""),
        hasAttachment: !!imageBlob,
        createdAt: serverTimestamp(),
        schemaVersion: 2,
      });

      const optimisticUser = {
        id: userMsgRef.id,
        userId: user.uid,
        role: "user",
        text: text || (imageBlob ? "(Image attached)" : ""),
        hasAttachment: !!imageBlob,
        createdAt: { toMillis: () => Date.now() },
        schemaVersion: 2,
      };
      if (!chatMessages.some((m) => m.id === userMsgRef.id)) {
        chatMessages = [...chatMessages, optimisticUser].sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
      }
      awaitingAssistantAfterUserId = userMsgRef.id;
      currentTurnUserMsgId = userMsgRef.id;
      paintChat();

      const routing = classifyAssistantRouting(text, { hasImage: !!imageBlob });
      const knownDefReply = !imageBlob ? buildKnownAgriDefinitionReply(text) : "";
      const oneLineDirectiveReply = !imageBlob ? buildOneLineAgriDirectiveReply(text) : "";
      const workPackReply = !imageBlob ? buildWorkPackDirectReply(text) : "";
      const deterministicTaskReply = !imageBlob ? buildDeterministicTaskReply(text) : "";
      const forcedDirectReply =
        knownDefReply || oneLineDirectiveReply || workPackReply || deterministicTaskReply;

      let snapshot = null;
      let orch = null;
      let reply = "";
      /** @type {{ entry: any, score: number }[]} */
      let learnedMemoryHits = [];

      if (forcedDirectReply) {
        reply = forcedDirectReply;
        orch = null;
      } else if (routing.mode === "micro_social") {
        reply = buildMicroSocialAssistantReply(text, { fieldCount: fields.length, scanCount: scans.length });
        orch = null;
      } else if (routing.mode === "casual") {
        reply = buildCasualAssistantReply(text, { fieldCount: fields.length, scanCount: scans.length });
        orch = null;
      } else if (routing.mode === "clarify") {
        reply = buildVagueSymptomReply(text, { fieldCount: fields.length, scanCount: scans.length });
        orch = null;
      } else if (routing.mode === "operations_quick") {
        snapshot = {
          userId: user.uid,
          fields,
          scans,
          recs,
          weatherLogs,
          environmental,
          fieldContextStates,
          interventions: farmInterventions,
          operationalTasks: farmOperationalTasks,
          alerts: assistantAlerts,
          locale: getLang() || "en",
          companion: companionProfile,
          regionalBriefing: "",
          learningProfile: null,
        };
        reply = composeOperationsSnapshotReply(text, snapshot, companionProfile);
        orch = null;
      } else {
        if (routing.mode !== "weather_quick" && !regionalBriefingText) {
          try {
            regionalBriefingText = await fetchRegionalBriefing(db);
          } catch {
            regionalBriefingText = "";
          }
        }

        snapshot = {
          userId: user.uid,
          fields,
          scans,
          recs,
          weatherLogs,
          environmental,
          fieldContextStates,
          interventions: farmInterventions,
          operationalTasks: farmOperationalTasks,
          alerts: assistantAlerts,
          locale: getLang() || "en",
          companion: companionProfile,
          regionalBriefing: routing.mode === "weather_quick" ? "" : regionalBriefingText || "",
          learningProfile: routing.mode === "weather_quick" ? null : learningProfile || null,
        };

        orch = await runAgriOrchestrator(text || "Analyze the attached crop image.", snapshot, { imageBlob }, {
          routingMode: routing.mode === "weather_quick" ? "weather_quick" : "full",
          flowSnapshot: flowSnap,
        });
        attachSnapshotForReply(orch, snapshot);
        const cfgKmMem = getAiConfig();
        learnedMemoryHits = cfgKmMem.assistantKnowledgeMemoryEnabled
          ? findRelevantKnowledgeMemory(knowledgeMemoryEntries, text, { limit: 2, minScore: 0.16 })
          : [];
        orch.turnConfidence = computeTurnConfidence({
          question: text,
          routingMode: routing.mode,
          orch,
          memoryHits: learnedMemoryHits,
        });
        const replyVerbosity =
          routing.mode === "weather_quick"
            ? "minimal"
            : resolveReplyVerbosity({
                routingMode: routing.mode,
                profile: companionProfile,
                flow: flowSnap,
                userText: text,
              });
        reply = composeAssistantReply(text || "[image]", orch, {
          locale: snapshot.locale,
          companionProfile,
          replyVerbosity,
          routingReason: routing.reason,
          flowSnapshot: flowSnap,
          learnedMemoryHits,
        });

        if (!reply) {
          reply = buildAssistantReply({ question: text, fields, scans, recs, weatherLogs });
        }

        const cfgWeb = getAiConfig();
        let webBrief = null;
        /** @type {{ use?: boolean, reasons?: string[], query?: string } | null} */
        let webResearchMeta = null;
        if (cfgWeb.webResearchEnabled !== false && String(text || "").trim().length > 12 && orch) {
          const wr = shouldUseWebAssistedResearch({
            question: text,
            routingMode: routing.mode,
            orch,
            memoryHits: learnedMemoryHits,
            precomputedConfidence: orch.turnConfidence,
          });
          if (wr.use) {
            webResearchMeta = wr;
            try {
              const brief = await fetchPublicAgriBrief(wr.query || text, { signal: streamAbort.signal });
              webBrief = brief;
              if (brief?.summary) {
                reply = `${String(reply || "").trimEnd()}\n\n${formatWebResearchAppend(brief, { reasons: wr.reasons })}`;
              }
            } catch (e) {
              console.warn("[assistant] web research:", e?.message || e);
            }
          }
        }

        const cfgKmPersist = getAiConfig();
        if (cfgKmPersist.assistantKnowledgeMemoryEnabled && webBrief?.summary && orch && webResearchMeta?.use) {
          void (async () => {
            try {
              const payload = buildKnowledgeDocPayload({
                userId: user.uid,
                question: text,
                researchQuery: webResearchMeta.query || text,
                brief: webBrief,
                webReasons: webResearchMeta.reasons || [],
                intents: orch.intents || {},
                assistantReply: reply,
              });
              const mergeT = findMergeTargetEntry(knowledgeMemoryEntries, text);
              if (mergeT?.id) {
                const { id: _i, lastUsedAtMs: _lu, createdAtMs: _cm, lastReinforcedAtMs: _lr, ...base } = mergeT;
                const merged = mergeKnowledgeEntries(base, payload);
                await updateDoc(doc(db, "assistant_knowledge_memory", mergeT.id), {
                  ...stripUndefinedForFirestore(merged),
                  lastUsedAt: serverTimestamp(),
                  lastReinforcedAt: serverTimestamp(),
                });
              } else {
                await addDoc(
                  collection(db, "assistant_knowledge_memory"),
                  stripUndefinedForFirestore({
                    ...payload,
                    createdAt: serverTimestamp(),
                    lastUsedAt: serverTimestamp(),
                    lastReinforcedAt: serverTimestamp(),
                  }),
                );
              }
              const ps = await getDocs(
                query(collection(db, "assistant_knowledge_memory"), where("userId", "==", user.uid), limit(55)),
              );
              if (ps.size > KNOWLEDGE_MEMORY_CAP) {
                const rows = ps.docs.map((d) => ({
                  id: d.id,
                  lu: d.data().lastUsedAt?.toMillis?.() ?? 0,
                }));
                rows.sort((a, b) => a.lu - b.lu);
                const batch = writeBatch(db);
                for (const r of rows.slice(0, ps.size - KNOWLEDGE_MEMORY_CAP)) {
                  batch.delete(doc(db, "assistant_knowledge_memory", r.id));
                }
                await batch.commit();
              }
            } catch (e) {
              console.warn("[assistant] knowledge memory persist:", e?.message || e);
            }
          })();
        }

        if (
          cfgKmPersist.assistantKnowledgeMemoryEnabled &&
          learnedMemoryHits.length &&
          learnedMemoryHits[0].entry?.id &&
          routing.mode !== "weather_quick"
        ) {
          void updateDoc(doc(db, "assistant_knowledge_memory", learnedMemoryHits[0].entry.id), {
            lastUsedAt: serverTimestamp(),
          }).catch(() => {});
        }
      }

      const rawUserText = String(text || "").trim();
      const shapeNeeds = inferReplyFormatNeeds(rawUserText);
      const isGreetingOrAck = /^(hi|hello|hey|thanks|thank you|thx|ok|okay|bye|goodbye)\b/i.test(rawUserText);
      const isSocialPrompt =
        /\b(joke|pun|funny|laugh|cheer\s+me\s+up|rough\s+day|bad\s+day|how\s+are\s+you|what'?s\s+up|hows?\s+your\s+day)\b/i.test(
          rawUserText,
        );
      const isGenericOrchReply =
        !!orch &&
        /\bNo fields or scans are on file yet\b/i.test(String(reply || "")) &&
        !/\bIndian Council of Agricultural Research\b/i.test(String(reply || ""));
      const wantsActionPlan =
        /\b(action|steps?|bullet|plan|what\s+should\s+i\s+do|next\s+24\s+hours|irrigat|blight|pest|disease|schedule)\b/i.test(
          rawUserText,
        );
      const looksLikeGeneralKnowledgeAsk =
        /\b(full\s*form|what\s+does|what\s+is|who\s+is|define|meaning|history|policy|icar|imd|msp|subsidy|mandi)\b/i.test(
          rawUserText,
        );
      const webFallbackEligible =
        getAiConfig().webResearchEnabled !== false &&
        rawUserText.length > 14 &&
        !isGreetingOrAck &&
        !isSocialPrompt &&
        ((!orch && looksLikeGeneralKnowledgeAsk) || (isGenericOrchReply && looksLikeGeneralKnowledgeAsk));

      if (webFallbackEligible) {
        try {
          const brief = await fetchPublicAgriBrief(text, { signal: streamAbort.signal });
          if (brief?.summary) {
            const webBlock = formatWebResearchAppend(brief, { seamless: true });
            reply = isGenericOrchReply ? webBlock : `${String(reply || "").trimEnd()}\n\n${webBlock}`;
          }
        } catch (e) {
          console.warn("[assistant] fallback web lookup:", e?.message || e);
        }
      }
      if (isGenericOrchReply && wantsActionPlan && !looksLikeGeneralKnowledgeAsk) {
        reply = buildNoDataActionFallback(rawUserText);
      }

      if (!reply) {
        reply =
          "I’m here — ask about a field, weather, pests, or your latest scan and I’ll route it through the farm engines.";
      }
      reply = enforceReplyShape(reply, shapeNeeds);

      const mood = detectConversationMood(text);
      const naturalMicroBeforePolish =
        ROUTING_NO_ENGINE_LOG.includes(routing.mode);
      reply = polishFarmReportProse(reply, {
        mood,
        routingMode: routing.mode,
        naturalMicro: naturalMicroBeforePolish,
      });

      const memNudge = maybePresenceMemoryNudge(companionProfile, {
        routingMode: routing.mode,
        userText: text,
        replyLength: reply.length,
        fields,
        flowSnapshot: flowSnap,
      });
      if (memNudge) {
        reply = `${reply.trimEnd()}\n\n${memNudge}`;
      }
      // Re-apply strict shape after style/nudge transforms so exact counts persist.
      reply = enforceReplyShape(reply, shapeNeeds);

      const naturalMicro =
        routing.mode === "micro_social" ||
        routing.mode === "casual" ||
        routing.mode === "clarify" ||
        reply.trim().length < 100;
      const orchForMemory =
        orch ||
        ({
              intents: routing.mode === "operations_quick" ? { operations: true } : {},
              results: {},
              enginePackVersion:
                routing.mode === "clarify"
                  ? "clarify-turn"
                  : routing.mode === "casual"
                    ? "casual-turn"
                    : routing.mode === "micro_social"
                      ? "micro-social-turn"
                      : routing.mode === "operations_quick"
                        ? "operations-turn"
                        : "direct-turn",
            });

      // Companion memory + engine-run logging are deferred until after the
      // stream actually completes, so an aborted/never-shown reply never
      // pollutes the profile or analytics. See `commitTurnSideEffects` below.

      const commitTurnSideEffects = async () => {
        try {
          if (!naturalMicro && reply.trim().length > 96) pushRecentAssistantOpening(reply);
          const nextProfile = mergeCompanionAfterTurn(companionProfile, {
            userText: text,
            assistantReply: reply,
            orch: orchForMemory,
            locale: (snapshot && snapshot.locale) || getLang() || "en",
            fields,
            scans,
            fieldContextStates,
            weatherLogs,
            recs,
            userId: user.uid,
          });
          await setDoc(doc(db, "companion_profiles", user.uid), nextProfile, { merge: true });
        } catch (memErr) {
          console.warn("[assistant] companion memory:", memErr?.message || memErr);
        }

        if (!ROUTING_NO_ENGINE_LOG.includes(routing.mode)) {
          try {
            const safeGeo = orch?.geo && typeof orch.geo === "object" ? stripUndefinedForFirestore(orch.geo) : null;
            await addDoc(collection(db, "ai_engine_runs"), {
              userId: user.uid,
              createdAt: serverTimestamp(),
              replyTo: userMsgRef.id,
              enginePackVersion: orch?.enginePackVersion || "direct-turn",
              intents: orch?.intents || null,
              preview: orch?.persistedPreview || null,
              geo: safeGeo,
              routingMode: orch?.routingMode || "full",
              cognitive: orch?.cognitivePlan
                ? {
                    layer: orch.cognitivePlan.layer,
                    reasoningDepth: orch.cognitivePlan.reasoningDepth,
                    llmTier: orch.cognitivePlan.llmTier,
                  }
                : null,
              verificationChecks: orch?.cognitiveVerification?.checks || null,
              schemaVersion: 1,
            });
          } catch (runErr) {
            console.warn("[assistant] engine-run log:", runErr?.message || runErr);
          }
        }
      };

      const presencePlan = computePresencePlan({
        routingMode: routing.mode,
        userText: text,
        replyLength: reply.length,
        mood,
        flowSnapshot: flowSnap,
      });
      await presenceSleep(presencePlan.preStreamMs);

      awaitingAssistantAfterUserId = null;
      streamInFlight = true;
      streamingAssistant = {
        fullText: reply,
        userMsgId: userMsgRef.id,
        profile: routing.mode,
      };
      paintChat();

      const textEl = listEl.querySelector("[data-stream-text]");
      const streamShell = listEl.querySelector("[data-stream-shell]");
      if (!textEl || myGen !== sendGeneration) {
        streamInFlight = false;
        streamingAssistant = null;
        activeStreamCtrl = null;
        paintChat();
        return;
      }

      if (sendBtn) sendBtn.disabled = false;

      activeStreamCtrl = runAssistantTextStream({
        textHost: textEl,
        fullText: reply,
        streamProfile: routing.mode,
        streamLeadInMs: presencePlan.streamLeadInMs,
        rhythmTone: streamRhythmPreference(flowSnap, routing.mode),
        signal: streamAbort.signal,
        shouldFollowScroll: () => followPinnedBottom,
        getScrollRoot: getAssistantScrollRoot,
        onFirstChar: () => {
          streamShell?.classList.remove("thinking");
          streamShell?.classList.add("stream-speaking");
        },
      });

      const streamResult = await activeStreamCtrl.promise;
      activeStreamCtrl = null;

      if (myGen !== sendGeneration || streamResult === "aborted") {
        // Aborted/superseded — keep DOM as-is until the finally block paints,
        // and skip persistence + companion-memory writes. The reply was never
        // fully shown, so don't record it.
        return;
      }

      // Persist the assistant message FIRST so the snapshot listener has it
      // ready; then in one paint frame swap streamingAssistant off. This
      // avoids the brief flicker where stream shell disappears before the
      // persisted message arrives.
      const persistedReplyDoc = await addDoc(collection(db, "assistant_messages"), {
        userId: user.uid,
        role: "assistant",
        text: reply,
        createdAt: serverTimestamp(),
        replyTo: userMsgRef.id,
        enginePackVersion:
          orch?.enginePackVersion ||
          (routing.mode === "clarify"
            ? "clarify-turn"
            : routing.mode === "casual"
              ? "casual-turn"
              : routing.mode === "micro_social"
                ? "micro-social-turn"
                : routing.mode === "operations_quick"
                  ? "operations-turn"
                  : ""),
        enginePreview: orch?.persistedPreview || null,
        routingMode: routing.mode,
        schemaVersion: 2,
      });
      // Optimistically place the persisted reply into chatMessages so the
      // upcoming paint shows it instantly without waiting for snapshot RTT.
      if (persistedReplyDoc?.id && !chatMessages.some((m) => m.id === persistedReplyDoc.id)) {
        chatMessages = [
          ...chatMessages,
          {
            id: persistedReplyDoc.id,
            userId: user.uid,
            role: "assistant",
            text: reply,
            replyTo: userMsgRef.id,
            createdAt: { toMillis: () => Date.now() },
            routingMode: routing.mode,
            schemaVersion: 2,
          },
        ].sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
      }
      streamInFlight = false;
      streamingAssistant = null;
      // Turn completed successfully — clear pointer so a later abort doesn't
      // incorrectly mark this user-msg as superseded.
      if (currentTurnUserMsgId === userMsgRef.id) currentTurnUserMsgId = null;

      // Fire-and-forget — these write to Firestore but don't block the UI.
      commitTurnSideEffects();
    } catch (e) {
      console.error("[assistant] send failed:", e);
      alert(
        "Couldn’t complete that message. Check your connection and try again. If it keeps failing, open the browser console (details for support).",
      );
    } finally {
      awaitingAssistantAfterUserId = null;
      streamInFlight = false;
      streamingAssistant = null;
      activeStreamCtrl = null;
      paintChat();
      if (sendBtn && myGen === sendGeneration) sendBtn.disabled = false;
      inputEl?.focus();
    }
  }

  sendBtn?.addEventListener("click", send);
  inputEl?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  clearBtn?.addEventListener("click", async () => {
    const ok = confirm("Clear assistant chat and engine run history for this account?");
    if (!ok) return;
    streamAbort.abort();
    sendGeneration += 1;
    streamAbort = new AbortController();
    streamInFlight = false;
    streamingAssistant = null;
    activeStreamCtrl = null;
    try {
      const runsQ = query(collection(db, "ai_engine_runs"), where("userId", "==", user.uid), limit(500));
      const [msgSnap, runSnap] = await Promise.all([getDocs(msgsQ), getDocs(runsQ)]);
      const batch = writeBatch(db);
      msgSnap.forEach((d) => batch.delete(doc(db, "assistant_messages", d.id)));
      runSnap.forEach((d) => batch.delete(doc(db, "ai_engine_runs", d.id)));
      await batch.commit();
    } catch (e) {
      console.error(e);
      alert(`Failed to clear: ${e.message}`);
    }
  });
});

