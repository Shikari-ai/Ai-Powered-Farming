/**
 * Calm, evidence-tagged reflection lines from learning state (not mystical).
 */
import { monthKey } from "./seasonality.js";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

export function buildReflectionSnippets(profile, hint = {}) {
    const lines = [];
    const g = profile?.global || {};
    const fs = profile?.fieldStats || {};
    const mk = monthKey(new Date());

    if (typeof g.simErrorEma === "number" && (g.simSampleCount || 0) >= 2) {
        const dir = g.simErrorEma > 0.8 ? "Observed canopy health finished above the last toy projection on average."
            : g.simErrorEma < -0.8 ? "Observed health trended below the last toy projection — humidity or stress may be running hotter than the sketch assumed."
                : "Toy twin errors are small recently — forecasts and scouting are roughly aligned.";
        lines.push(`${dir} (rolling bias ~${g.simErrorEma.toFixed(1)} pts, ${g.simSampleCount} samples — simulated layer only).`);
    }

    let bestField = null;
    let bestRate = -1;
    for (const [fid, st] of Object.entries(fs)) {
        const r = st.interventionSuccessEma;
        if (typeof r === "number" && r > bestRate) {
            bestRate = r;
            bestField = fid;
        }
    }
    if (bestField && bestRate >= 0.55) {
        lines.push(
            `Field memory suggests interventions have been trending useful where follow-up scans exist (${Math.round(bestRate * 100)}% inferred success rate — not proof of product performance).`,
        );
    }

    if (hint.highHumidityWeeks && hint.fungalRecurrence) {
        lines.push(
            "Humid weeks overlap with recurring fungal codes in your scan tail — the system will keep fungal vigilance slightly earlier in similar windows.",
        );
    }

    lines.push(`Season tag ${mk}: seasonal priors stay soft until your scan volume crosses a few dozen signals per crop.`);

    return lines.map((s) => String(s).trim()).filter(Boolean).slice(0, 4);
}
