/**
 * Short, varied connective prose — purely local. No external models.
 * Keeps full engine-driven replies from feeling like a raw bullet dump.
 */

import { openerFingerprint, openerWasRecentlyUsed } from "./conversation-naturals.js?v=48";

function hash32(s) {
    let h = 0;
    const str = String(s || "");
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    }
    return h;
}

function pick(arr, seed) {
    if (!arr.length) return "";
    const fresh = typeof seed === "number" ? arr.filter((s) => !openerWasRecentlyUsed(s)) : arr;
    const pool = fresh.length ? fresh : arr;
    const i = Math.abs(seed) % pool.length;
    return pool[i];
}

/**
 * @param {string} question
 * @param {any} orch
 * @param {{
 *   compact?: boolean,
 *   replyVerbosity?: string,
 *   slim?: boolean,
 *   avoidOpenerFingerprints?: string[],
 *   flowSnapshot?: import('./conversation-flow.js').FlowSnapshot | null,
 * }} [opts]
 * @returns {string}
 */
export function buildConversationalBridge(question, orch, opts = {}) {
    if (opts.compact || opts.replyVerbosity === "minimal" || opts.replyVerbosity === "compact") return "";
    const q = String(question || "").trim();
    if (q.length < 2) return "";

    const intents = orch.intents || {};
    const r = orch.results || {};
    const degraded = !!(orch.degradedHints && orch.degradedHints.length);
    const geoHint = orch.geo?.city ? String(orch.geo.city) : "";
    const flow = opts.flowSnapshot || null;
    const flowSalt = flow
        ? `${flow.energy || ""}:${flow.prefersDepth ? "d" : ""}${flow.prefersConcise ? "c" : ""}${flow.reflective ? "r" : ""}`
        : "";
    const seed = hash32(q.slice(0, 120) + geoHint + (orch.cognitivePlan?.layer || "") + flowSalt);

    const banned = new Set((opts.avoidOpenerFingerprints || []).filter((x) => typeof x === "string" && x.length > 10));
    const slim = !!opts.slim;

    const pickAway = (candidates) => {
        const arr = candidates.filter((x) => typeof x === "string" && x.trim());
        if (!arr.length) return "";
        const filt = arr.filter((line) => !banned.has(openerFingerprint(line)));
        const pool = filt.length ? filt : arr;
        return pick(pool, seed ^ 0x2f6ea53);
    };

    const neutral = slim
        ? [
              "Straight read from what you’ve saved — live weather where we’ve got it.",
              "Quick pass over your snapshots — anchored, not flashy.",
              "Below is anchored on your onboard data.",
          ]
        : [
              "Here’s a straight read from your onboard engines — everything below is grounded in what you’ve saved, plus live weather where we have it.",
              "I stitched this together from your farm context, recommendations merge, and environment signals — advisory only, you still run the field.",
              "Pulling the thread from your latest data: practical next checks first, then the supporting detail.",
              "This turn is mostly deterministic pipelines over your own snapshots — I’ll flag where uncertainty matters.",
          ];

    if (degraded) {
        return pickAway(
            slim
                ? ["Signals thin — staying cautious.", "Freshness caveat; conservative read below."]
                : [
                      "Connectivity or freshness is a bit thin — I’ll stay conservative and lean on what we know for sure.",
                      "Some signals are stale; I’ll flag uncertainty and keep recommendations cautious.",
                      "A couple inputs look dated — I’ll underline what’s firm versus what’s a best guess.",
                  ],
        );
    }

    if (intents.weather || /\bweather\b|forecast|rain|humidity/i.test(q)) {
        return pickAway(
            slim
                ? [
                      geoHint ? `Weather (${geoHint}) — from your anchored readout.` : "Quick weather from your anchored readout.",
                      "Humidity/rain cues below — spray timing context.",
                  ]
                : [
                      `Weather-wise${geoHint ? ` for ${geoHint}` : ""}, here’s the blend from your anchor and Open‑Meteo-style readouts.`,
                      "Starting with atmosphere and moisture — that drives a lot of what follows for spray and disease pressure.",
                      "Moisture and temperature frames the rest — here’s how your quick weather layer reads.",
                  ],
        );
    }
    if (intents.pest || /\bpest\b|insect|mite/i.test(q)) {
        return pickAway(
            slim
                ? ["Short pest-pressure read from scouting + cues below.", "Pest heuristic from humidity/warmth/rain."]
                : [
                      "Scouting and environment together shape pest pressure — here’s how your current numbers line up.",
                      "Pest outlook is heuristic from humidity, warmth, and rain cues — useful for timing checks, not a replacement for traps.",
                      "Think of pest risk as a scheduling nudge — traps and row walks still decide the story.",
                  ],
        );
    }
    if (intents.disease || /\bdisease\b|blight|rust|mildew|spot/i.test(q)) {
        return pickAway(
            slim
                ? ["Short disease-pressure angle tied to humidity + scans below.", "Scout to verify — condensed read below."]
                : [
                      "Disease thinking here ties weather stress to what you’ve logged or scanned — verification in the row still wins.",
                      "I’m weighing leaf-wetness drivers against your saved symptoms and any vision read you have.",
                      "The disease layer here is pattern + environment — confirm with a tight scout before big chemical moves.",
                  ],
        );
    }
    if (intents.irrigation || /\birrigation|irrigate|moisture|water\b/i.test(q)) {
        return pickAway(
            slim
                ? ["Irrigation nudge skews meteorology — probe still decides.", "Water balance angle below (weather-heavy)."]
                : [
                      "Water balance is part weather, part field history — here’s a concise operational take.",
                      "Irrigation calls need soil truth; this layer gives you the meteorology and risk nudge.",
                      "Hydration decisions need your probe data — I’m anchoring the weather side of the ledger.",
                  ],
        );
    }

    if (intents.operations || /\b(task|tasks|intervention|alert)\b/i.test(q)) {
        return pickAway(
            slim
                ? ["Task/intervention ledger first — skim below.", "Ops snapshot — terse pass."]
                : [
                      "Chores and logged work are showing up in your snapshot — I’ll keep this inventory-forward.",
                      "Operations first: what’s open, what you recently did, then we can tie it to engines if you want.",
                      "This is mostly your task and intervention trail — say if you want it prioritised against weather or pests.",
                  ],
        );
    }

    /** Tight phrasing-only turns: section headers alone read cleaner than stacking a generic preamble. */
    if (
        q.length <= 78 &&
        !intents.weather &&
        !intents.pest &&
        !intents.disease &&
        !intents.irrigation &&
        !intents.operations &&
        !degraded &&
        !(r.recommendations?.actions?.length)
    ) {
        return "";
    }

    if (r.recommendations?.actions?.length) {
        return pickAway(
            slim
                ? ["Merged actions stacked below — grab what fits.", "Ranked suggestions — skim first."]
                : [
                      "Your recommendation engine already ranked a few moves — I’ll narrate why they surfaced.",
                      "Below is the merged action list from pest, weather, and reliability caps — pick what fits your rotation.",
                      "Recommendations are ranked with guardrails — I’ll stay close to the reasoning baked into each line.",
                  ],
        );
    }

    if ((orch.snapshot?.scans?.length || 0) === 0 && (orch.snapshot?.fields?.length || 0) === 0) {
        return pickAway(
            slim
                ? ["Light account context — general-safe below.", "Add field + scan when you can."]
                : [
                      "Once you add a field and a scan, this assistant gets much sharper — for now I’ll keep guidance general and safe.",
                      "Light context so far — I’ll avoid pretending I know rows I haven’t seen in your account.",
                      "We’re still bootstrapping farm context — short answers until scans and fields land.",
                  ],
        );
    }

    return pickAway(neutral);
}
