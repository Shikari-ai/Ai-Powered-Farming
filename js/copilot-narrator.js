/**
 * Calm, non-alarmist narration for live copilot (vision + weather + memory heuristics).
 */

import { tsToMs } from "./ai/farmer-context.js?v=34";
import { buildTwinBriefForAssistant } from "./twin/assistant-twin-brief.js";

function severityPhrase(result) {
    const t = (result?.contextualIntel?.risk_tier || "").toLowerCase();
    if (t === "critical" || t === "high") return "elevated priority";
    if (t === "elevated" || t === "moderate") return "moderate concern";
    return "early signal";
}

export function buildProactiveUtterance(result, { weatherLogs, companion } = {}) {
    const weatherLog = (weatherLogs || [])
        .slice()
        .sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt))[0];
    if (!result || !result.ok) return "";
    const hyp = result.topHypothesis || (result.detections && result.detections[0]?.label) || null;
    const conf =
        typeof result.confidence === "number"
            ? `About ${Math.round(Math.min(1, result.confidence) * 100)} percent confidence from this frame.`
            : "";
    const sev = severityPhrase(result);
    const iq = result.imageQuality;
    const qual =
        iq && String(iq).toLowerCase() === "low"
            ? "Image clarity is limited, so treat this as a screen, not a final diagnosis."
            : "";

    const hum = weatherLog?.current?.relative_humidity_2m;
    const wx =
        typeof hum === "number" && hum >= 80
            ? ` Humidity has been high around ${Math.round(hum)} percent—which can align with fungal pressure when leaves stay wet.`
            : "";

    const mem =
        companion?.preferredCrops?.length && companion.preferredCrops[0]
            ? ` I’ll keep ${companion.preferredCrops[0]} habits in mind as we walk.`
            : "";

    if (!hyp) {
        return [qual, "I’m watching the canopy; stable so far on this view.", wx || mem].filter(Boolean).join(" ").trim();
    }

    return [
        `I’m seeing patterns that resemble ${hyp} — ${sev}.`,
        conf,
        result.explanation ? String(result.explanation).slice(0, 280) : "",
        qual,
        wx,
        mem,
    ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 900);
}

/**
 * @param {string} q
 * @param {any | null} lastVision
 * @param {any[]} weatherLogs
 */
export function answerVoiceQuery(q, lastVision, weatherLogs, farmSnapshot = null) {
    const lower = String(q || "").toLowerCase();

    if (/\b(what if|simulate|simulation|forecast|digital twin|\btwin\b)\b/i.test(lower) && farmSnapshot?.fields?.length) {
        const brief = buildTwinBriefForAssistant({
            fields: farmSnapshot.fields,
            scans: farmSnapshot.scans || [],
            weatherLogs: farmSnapshot.weatherLogs || weatherLogs || [],
            fieldContextStates: farmSnapshot.fieldContextStates || [],
            interventions: farmSnapshot.interventions || [],
            regionalBriefing: farmSnapshot.regionalBriefing || "",
        });
        if (brief) {
            return [
                "Quick simulated contrast from your coarse digital twin—hypothetical only.",
                `Focus ${brief.focusFieldName}: baseline week sketch ~${brief.baseline.endHealth}% health vs wet-week sketch ~${brief.wetWeek.endHealth}% (${brief.wetWeek.deltaVsBaseline >= 0 ? "+" : ""}${brief.wetWeek.deltaVsBaseline} pts in this toy model, ${brief.dataConfidence} input confidence).`,
                brief.simulationDisclaimer,
            ].join(" ");
        }
        return "I need weather synced and fields loaded to run a twin sketch—open the dashboard once with location, then try again.";
    }

    const w = (weatherLogs || []).slice().sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt))[0];
    const hum = w?.current?.relative_humidity_2m;
    const temp = w?.current?.temperature_2m;

    if (/\b(irrigate|water|irrigation|sprinkl)\b/.test(lower)) {
        if (!w) return "I don’t have fresh weather in your account yet—open the app with location once, then ask again.";
        if (typeof hum === "number" && hum > 78)
            return "Humidity is fairly high; if leaves stay wet, ease up on overhead watering and check drainage.";
        if (typeof temp === "number" && temp > 32)
            return "It’s quite warm; a light irrigation pass may help if soil is drying—pair that with your soil moisture check.";
        return "Based on current air readings, irrigation looks routine—still confirm soil moisture at root depth.";
    }

    if (/\b(yellow|chlorosis|chlorotic)\b/.test(lower)) {
        if (lastVision?.ok && lastVision.topHypothesis) {
            return `From this live frame, the model leans toward ${lastVision.topHypothesis}—yellowing can be nutrient, water, or pest related, so a quick soil test helps before big nitrogen swings.`;
        }
        return "Yellowing has several causes—nutrients, waterlogging, or pests. Capture a closer leaf photo; I’ll keep screening as you move.";
    }

    if (/\b(serious|bad|danger|emergency)\b/.test(lower)) {
        if (lastVision?.ok && lastVision.contextualIntel?.risk_tier) {
            const tier = lastVision.contextualIntel.risk_tier;
            return `I’d call this "${tier}" risk from vision and context—not a reason to panic, but a good moment to plan the next field check calmly.`;
        }
        return "I need a confident live read first—keep the plant centered; I’ll narrate as soon as the model stabilizes.";
    }

    if (/\b(what|which|name|disease|pest)\b/.test(lower)) {
        if (lastVision?.ok && lastVision.topHypothesis)
            return `Best hypothesis right now: ${lastVision.topHypothesis}. ${lastVision.explanation ? lastVision.explanation.slice(0, 220) : "Walk slowly so boxes stay stable."}`;
        return "Hold steady on the foliage—I'm still locking in a hypothesis from your camera.";
    }

    if (lastVision?.ok && lastVision.explanation) return String(lastVision.explanation).slice(0, 500);

    return "Ask about irrigation, disease, yellowing, or whether this looks serious—I’ll answer from the latest camera read and your weather.";
}

export function createProactiveGate({ walkModeRef, minMsNormal, minMsWalk }) {
    let lastAt = 0;
    let lastKey = "";
    return {
        shouldSpeak(key) {
            const now = Date.now();
            const base = walkModeRef.current ? minMsWalk : minMsNormal;
            const same = key && key === lastKey;
            const needGap = same ? base * 2 : base;
            if (now - lastAt < needGap) return false;
            lastAt = now;
            lastKey = key || lastKey;
            return true;
        },
        reset() {
            lastAt = 0;
            lastKey = "";
        },
    };
}
