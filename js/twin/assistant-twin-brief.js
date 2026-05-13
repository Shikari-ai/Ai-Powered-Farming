/**
 * Compact, sync twin brief for assistant + orchestrator bundles (no network).
 */
import { tsToMs } from "../ai/farmer-context.js?v=34";
import { buildDigitalTwinState } from "./twin-state.js";
import { runScenarioProjection } from "./simulation-engine.js";

function latestScanForField(scans, fieldId) {
    let best = null;
    let bestT = 0;
    for (const s of scans || []) {
        if (s.fieldId !== fieldId) continue;
        const t = tsToMs(s.createdAt);
        if (t >= bestT) {
            bestT = t;
            best = s;
        }
    }
    return best;
}

/**
 * Pick the field with the lowest recent health (tie-break: more scans).
 */
export function pickFocusFieldForTwin(fields, scans) {
    let best = null;
    let score = Infinity;
    for (const f of fields || []) {
        const ls = latestScanForField(scans, f.id);
        const h = typeof ls?.healthScore === "number" ? ls.healthScore : 70;
        const n = (scans || []).filter((s) => s.fieldId === f.id).length;
        const sorter = h - n * 0.08;
        if (sorter < score) {
            score = sorter;
            best = f;
        }
    }
    return best;
}

export function latestWeatherBundle(snapshot) {
    const logs = (snapshot.weatherLogs || []).slice().sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt));
    const w = logs[0];
    if (!w) return null;
    return {
        current: w.current || {},
        daily: w.daily || {},
        hourly: w.hourly || {},
        timezone: w.timezone,
        fetchedAt: w.fetchedAt,
    };
}

/**
 * @param {any} snapshot assistant/orchestrator snapshot
 * @returns {object|null}
 */
export function buildTwinBriefForAssistant(snapshot) {
    const fields = snapshot.fields || [];
    const scans = snapshot.scans || [];
    const field = pickFocusFieldForTwin(fields, scans);
    if (!field) return null;

    const ctx = (snapshot.fieldContextStates || []).find((x) => (x.fieldId || x.id) === field.id);
    const ints = (snapshot.interventions || []).filter((x) => x.fieldId === field.id);
    const fScans = scans.filter((s) => s.fieldId === field.id);
    const regional = String(snapshot.regionalBriefing || "").slice(-400);

    const twin = buildDigitalTwinState({
        field,
        scans: fScans,
        ctxState: ctx || null,
        interventions: ints,
        regionalSnippet: regional,
    });

    const wx = latestWeatherBundle(snapshot);
    if (!wx?.daily?.precipitation_sum) return null;

    const regionalStress =
        /\b(high|elevated|outbreak|stress)\b/i.test(regional) ? 0.28 : 0.12;

    const baseline = runScenarioProjection(twin, wx, "baseline", { regionalStress01: regionalStress });
    const alt = runScenarioProjection(twin, wx, "continued_rain", { regionalStress01: regionalStress });

    const delta = (alt.summary?.endHealth || 0) - (baseline.summary?.endHealth || 0);

    return {
        focusFieldId: field.id,
        focusFieldName: field.name || "Field",
        dataConfidence: twin.dataConfidence,
        simulationDisclaimer: "Simulated trajectories — not forecasts of actual crop performance.",
        baseline: {
            endHealth: Math.round(baseline.summary?.endHealth || 0),
            endFungal01: baseline.summary?.endFungal,
        },
        wetWeek: {
            endHealth: Math.round(alt.summary?.endHealth || 0),
            deltaVsBaseline: Math.round(delta),
        },
        inspectLoad: baseline.operationalImpact?.suggestedInspections7d ?? 0,
    };
}

/**
 * Text lines for deterministic assistant reply section.
 */
export function formatTwinBriefLines(brief) {
    if (!brief) return [];
    const lines = [];
    lines.push(
        `${brief.focusFieldName}: twin confidence ${brief.dataConfidence} (more scans + context tighten bands).`,
    );
    lines.push(
        `Simulated week ahead — baseline end health ~${brief.baseline.endHealth}% vs wetter-week sketch ~${brief.wetWeek.endHealth}% (${brief.wetWeek.deltaVsBaseline <= 0 ? "lower" : "higher"} by ~${Math.abs(brief.wetWeek.deltaVsBaseline)} pts in this toy model).`,
    );
    lines.push(`Operational load hint (purely heuristic): ~${brief.inspectLoad} inspection passes worth planning.`);
    lines.push(brief.simulationDisclaimer);
    return lines;
}

export function formatShallowTwinReplyLines(tb) {
    if (!tb?.available) return [];
    return [
        `${tb.focusFieldName} (simulated sketch): baseline week ends ~${tb.baselineEndHealth}% vs wet-week path ~${tb.wetWeekEndHealth}% in the toy twin (${tb.dataConfidence} input confidence).`,
        `Heuristic inspection cadence ~${tb.inspectHint} pass(es) if pressures stay elevated — you still decide field work.`,
        "Hypothetical only — not a forecast of yield or disease outcomes.",
    ];
}

/**
 * Shallow object for LLM bundle (already sanitized depth upstream).
 */
export function shallowTwinForBundle(snapshot) {
    const brief = buildTwinBriefForAssistant(snapshot);
    if (!brief) return { available: false };
    return {
        available: true,
        focusFieldName: brief.focusFieldName,
        dataConfidence: brief.dataConfidence,
        baselineEndHealth: brief.baseline.endHealth,
        wetWeekEndHealth: brief.wetWeek.endHealth,
        inspectHint: brief.inspectLoad,
    };
}
