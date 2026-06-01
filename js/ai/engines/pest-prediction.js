import { tsToMs } from "../farmer-context.js";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

/**
 * Rule-based pest pressure outlook. Probabilities are calibrated indices (0–1), not ML posteriors.
 * @param {any} ctx
 * @param {{ temperatureC: number|null, humidityPct: number|null, rainTodayMm: number|null, rainTomorrowMm: number|null }} wx
 */
export function runPestPrediction(ctx, wx) {
    const reasons = [];
    let score = 0.18;

    const { humidityPct: rh, temperatureC: t, rainTodayMm: rt, rainTomorrowMm: rm } = wx;

    if (rh != null && rh > 78) {
        score += 0.14;
        reasons.push(`High humidity (${Math.round(rh)}%) supports soft-bodied pests and pathogen vectors.`);
    }
    if (t != null && t > 28 && t < 36) {
        score += 0.1;
        reasons.push(`Warm canopy temperatures (~${Math.round(t)}°C) can accelerate insect development cycles.`);
    }
    if (rt != null && rt > 3) {
        score += 0.08;
        reasons.push("Recent rain boosts tender new growth, often attractive to sucking pests.");
    }
    if (rm != null && rm > 6) {
        score += 0.06;
        reasons.push("Upcoming wet window may reduce natural enemy activity briefly.");
    }

    const cropTypes = new Set();
    for (const f of ctx.fields || []) {
        if (f.cropType) cropTypes.add(String(f.cropType).toLowerCase());
    }
    for (const s of ctx.scans || []) {
        if (s.cropType) cropTypes.add(String(s.cropType).toLowerCase());
    }
    if (cropTypes.has("cotton")) {
        score += 0.06;
        reasons.push("Cotton stage management: monitor bollworm / whitefly complexes during warm humid spells.");
    }

    const now = Date.now();
    const pestScans30d = (ctx.scans || []).filter((s) => {
        if (s.diagnosis?.code !== "pest_damage") return false;
        const age = now - tsToMs(s.createdAt);
        return age >= 0 && age < 30 * 86400000;
    });
    if (pestScans30d.length) {
        score += clamp(pestScans30d.length * 0.07, 0, 0.22);
        reasons.push(`You logged ${pestScans30d.length} pest-damage scan(s) in the last 30 days — scout those fields closely.`);
    }

    score = clamp(score, 0, 0.92);

    const label = score >= 0.55 ? "elevated" : score >= 0.35 ? "moderate" : "watch";

    return {
        engine: "pest_prediction",
        version: 1,
        pestPressureIndex: Math.round(score * 100) / 100,
        riskLabel: label,
        reasons,
        prevention: [
            "Sticky traps + regular scouting beats calendar spraying.",
            "Log exact symptom photos and field maps so trends stay evidence-based.",
            "Align sprays with labels, wind, and bee safety windows.",
        ],
        basis: "Heuristic model from humidity, temperature, rainfall signals, crop hints, and your recent pest-tagged scans.",
    };
}
