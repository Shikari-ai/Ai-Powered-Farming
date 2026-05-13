/**
 * Lightweight discrete twin simulation — hypothetical trajectories only.
 * Labels: simulated / estimated — never certainties.
 */
import { tsToMs } from "../ai/farmer-context.js?v=34";
import { getCachedTwinProjection } from "./simulation-cache.js";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

/** @typedef {{
 *   id: string,
 *   label: string,
 *   description: string,
 * }} TwinScenarioMeta */

/** @type {TwinScenarioMeta[]} */
export const SCENARIO_PRESETS = [
    {
        id: "baseline",
        label: "Baseline",
        description: "Continue current rhythm — no extra intervention modeled.",
    },
    {
        id: "delay_irrigation_3d",
        label: "Delay irrigation 3d",
        description: "Simulates deferred irrigation under warm/humid stress.",
    },
    {
        id: "continued_rain",
        label: "Wetter week",
        description: "Boosts effective rain in the projection (hypothetical wet spell).",
    },
    {
        id: "no_fungicide",
        label: "No fungicide",
        description: "Assumes fungal pressure is not chemically suppressed.",
    },
    {
        id: "immediate_intervention",
        label: "Treat now",
        description: "Models prompt protective/stacked response (you still choose products).",
    },
];

function dailyRainMm(weatherBundle, dayIndex) {
    const d = weatherBundle?.daily?.precipitation_sum;
    if (!Array.isArray(d)) return 0;
    return typeof d[dayIndex] === "number" ? d[dayIndex] : 0;
}

function dailyHumidityHint(weatherBundle, dayIndex) {
    const h = weatherBundle?.hourly?.relative_humidity_2m;
    if (Array.isArray(h) && h.length > dayIndex * 24) return h[dayIndex * 24];
    const cur = weatherBundle?.current?.relative_humidity_2m;
    return typeof cur === "number" ? cur : 65;
}

/**
 * @param {any} twin from buildDigitalTwinState
 * @param {any|null} weatherBundle Open-Meteo-shaped or stored weather_logs body
 * @param {string} scenarioId
 * @param {{ horizonDays?: number, regionalStress01?: number, learningCal?: { fungalSimMul?: number, healthBiasCorrection?: number } }} [opts]
 */
function stepSimulation(twin, weatherBundle, scenarioId, opts = {}) {
    const horizon = clamp(opts.horizonDays ?? 7, 3, 14);
    const regionalStress = clamp(opts.regionalStress01 ?? 0.12, 0, 0.6);
    const lc = opts.learningCal || null;
    const fMul = lc?.fungalSimMul ?? 1;
    const pressureScale = clamp(0.65 + fMul * 0.35, 0.75, 1.35);

    let health = clamp(twin.health0 + (lc?.healthBiasCorrection ?? 0), 8, 98);
    let fungal = clamp(twin.fungalMemory01 + regionalStress * 0.15, 0.05, 0.95);
    let pest = clamp(twin.pestMemory01 + regionalStress * 0.1, 0.05, 0.92);
    let stress = 0.22;
    let stability = twin.stability0;

    const steps = [];
    const uncertaintyBase =
        twin.dataConfidence === "high" ? 2.8 : twin.dataConfidence === "medium" ? 4.2 : 6.5;
    const scansPenalty = Math.max(0, 6 - Math.min(6, twin.scanCount)) * 0.35;

    for (let day = 0; day <= horizon; day++) {
        let rain = dailyRainMm(weatherBundle, day);
        const rh = dailyHumidityHint(weatherBundle, day);

        if (scenarioId === "continued_rain") rain *= 1.45;
        if (scenarioId === "delay_irrigation_3d" && day < 3) {
            stress += 0.06;
            if (!/rain-fed/i.test(String(twin.irrigationType || ""))) health -= 0.55;
        }
        if (scenarioId === "immediate_intervention") {
            if (day <= 2) fungal *= 0.72;
            if (day <= 1) pest *= 0.85;
            stability = clamp(stability + 0.03, 0, 1);
        }
        if (scenarioId === "no_fungicide") {
            fungal += 0.018 + (rain > 4 ? 0.03 : 0);
        } else if (scenarioId !== "immediate_intervention") {
            fungal -= 0.006;
        }

        const wet = rain > 5 ? 0.14 : rain > 2 ? 0.07 : 0;
        const humid = rh >= 82 ? 0.11 : rh >= 72 ? 0.05 : 0;
        fungal = clamp(fungal + (wet + humid) * pressureScale - 0.04 + twin.outbreakRecurrence01 * 0.02, 0.05, 0.96);
        pest = clamp(pest + (stress > 0.38 ? 0.022 : 0.01) - 0.008, 0.05, 0.94);

        const vegDrag = fungal * 18 + pest * 14;
        const recover = twin.recentInterventionCount10d ? 1.15 : 1;
        health = clamp(health - vegDrag * recover * 0.08 + (scenarioId === "immediate_intervention" ? 0.35 : 0), 5, 99);

        stability = clamp(stability - fungal * 0.04 - stress * 0.03 + (day % 3 === 0 ? 0.015 : 0), 0.08, 0.97);
        stress = clamp(stress * 0.93 + wet * 0.12 + humid * 0.06 - 0.02, 0.08, 0.92);

        const band = uncertaintyBase + scansPenalty + day * 0.35;
        steps.push({
            day,
            label: day === 0 ? "Now" : `+${day}d`,
            health,
            fungalPressure01: fungal,
            pestPressure01: pest,
            stress01: stress,
            stability01: stability,
            healthLow: clamp(health - band, 0, 100),
            healthHigh: clamp(health + band * 0.65, 0, 100),
        });
    }

    const workloadInspect = Math.ceil(fungal * 4.5 + pest * 3.2);
    const workloadRescan = fungal >= 0.45 || health < 62 ? 1 : 0;

    return {
        scenarioId,
        horizonDays: horizon,
        steps,
        summary: {
            endHealth: steps[steps.length - 1].health,
            endFungal: steps[steps.length - 1].fungalPressure01,
            endStability: steps[steps.length - 1].stability01,
        },
        operationalImpact: {
            suggestedInspections7d: workloadInspect,
            rescanPriority: workloadRescan,
        },
        simulationNote: "All trajectories are simulated heuristics — not field-validated predictions.",
    };
}

/**
 * @param {any} twin
 * @param {any|null} weatherBundle
 * @param {string} scenarioId
 * @param {object} [opts]
 */
export function runScenarioProjection(twin, weatherBundle, scenarioId, opts) {
    const wxTime =
        weatherBundle?.current?.time || weatherBundle?.fetchedAt || "";
    const key = JSON.stringify({
        fid: twin.fieldId,
        s: scenarioId,
        h: twin.health0,
        fm: Math.round(twin.fungalMemory01 * 100),
        sc: twin.scanCount,
        dc: twin.dataConfidence,
        wx: typeof wxTime === "string" ? wxTime.slice(0, 24) : tsToMs(wxTime),
        lm: Math.round((opts.learningCal?.fungalSimMul ?? 1) * 100),
        hb: Math.round((opts.learningCal?.healthBiasCorrection ?? 0) * 10),
    });
    return getCachedTwinProjection(key, 60_000, () => stepSimulation(twin, weatherBundle, scenarioId, opts));
}

/**
 * @param {any} twin
 * @param {any|null} weatherBundle
 * @param {string[]} scenarioIds max ~4 for UI
 * @param {{ regionalStress01?: number, learningCal?: object }} [opts]
 */
export function compareScenarios(twin, weatherBundle, scenarioIds, opts) {
    const out = [];
    for (const id of scenarioIds) {
        const meta = SCENARIO_PRESETS.find((p) => p.id === id);
        out.push({
            meta: meta || { id, label: id, description: "" },
            projection: runScenarioProjection(twin, weatherBundle, id, opts),
        });
    }
    return out;
}

/**
 * Explain why an alternate path diverged vs baseline (trust bullets).
 * @param {ReturnType<typeof runScenarioProjection>} baseline
 * @param {ReturnType<typeof runScenarioProjection>} other
 */
export function explainSimulationDifference(baseline, other) {
    const lines = [];
    const bEnd = baseline.summary?.endHealth ?? 0;
    const oEnd = other.summary?.endHealth ?? 0;
    const d = oEnd - bEnd;
    if (Math.abs(d) < 0.6) {
        lines.push("Ending health is close to baseline — most of the week’s drivers are similar in this model.");
    } else if (d < 0) {
        lines.push(
            `Projected health finishes ~${Math.abs(Math.round(d))} points lower than baseline in this simulation.`,
        );
    } else {
        lines.push(`Projected health finishes ~${Math.round(d)} points higher than the passive baseline here.`);
    }

    if (other.scenarioId === "continued_rain") {
        lines.push("Wetter-week path keeps leaf-wetness drivers elevated → fungal pressure accrues faster in the model.");
    }
    if (other.scenarioId === "delay_irrigation_3d") {
        lines.push("Deferred irrigation nudges moisture stress up early in the run (unless the field is rain-fed).");
    }
    if (other.scenarioId === "no_fungicide") {
        lines.push("Without a modeled fungal suppression term, pressure decays more slowly when humidity/rain aligns.");
    }
    if (other.scenarioId === "immediate_intervention") {
        lines.push("Immediate response assumes you act early — real outcomes depend on product, coverage, and weather windows.");
    }

    const hum = other.steps?.[0] && baseline.steps?.[0];
    if (hum) {
        lines.push("Drivers use your latest weather bundle + scan/memory context — weak data widens uncertainty bands automatically.");
    }

    lines.push("This is a planning mirror, not a prescription — validate with scouting and local extension guidance.");
    return lines;
}
