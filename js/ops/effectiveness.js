/**
 * Assess intervention outcomes from longitudinal scans (inferred, not lab truth).
 */
import { tsToMs } from "../ai/farmer-context.js";

/**
 * @param {object} intervention Firestore-shaped doc
 * @param {{ id: string, createdAt?: any, healthScore?: number, fieldId?: string }[]} scansForField newest-first or mixed
 */
export function assessInterventionOutcome(intervention, scansForField) {
    const t0 = tsToMs(intervention.performedAt);
    if (!t0 || !intervention.fieldId) {
        return {
            effectivenessScore: null,
            recoveryConfidence: "low_pre",
            narrative: "Not enough timing context to score this intervention yet.",
        };
    }
    const after = (scansForField || [])
        .filter((s) => s.fieldId === intervention.fieldId && tsToMs(s.createdAt) > t0)
        .sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));

    const pre =
        intervention.preScanSnapshot?.healthScore ??
        (() => {
            const before = (scansForField || [])
                .filter((s) => s.fieldId === intervention.fieldId && tsToMs(s.createdAt) <= t0)
                .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))[0];
            return typeof before?.healthScore === "number" ? before.healthScore : null;
        })();

    if (after.length === 0 || pre == null) {
        return {
            effectivenessScore: null,
            recoveryConfidence: "pending_followup_scan",
            narrative:
                "Log a follow-up scan after your observation window to measure recovery trend. " +
                "This score stays provisional until then.",
        };
    }
    const latest = after[after.length - 1];
    const delta = (latest.healthScore ?? pre) - pre;
    const hoursToFirst = (tsToMs(after[0].createdAt) - t0) / 3600000;

    let effectivenessScore = 0.5 + delta / 200;
    if (delta >= 8) effectivenessScore += 0.08;
    if (delta <= -5) effectivenessScore -= 0.12;
    effectivenessScore = Math.max(0.08, Math.min(0.95, effectivenessScore));

    let recoveryConfidence = "moderate";
    if (after.length >= 2 && delta > 3) recoveryConfidence = "moderate_high";
    if (after.length === 1 && hoursToFirst < 6) recoveryConfidence = "low_time_sampling";
    if (delta < -3) recoveryConfidence = "concerning_trend";

    const narrative = [
        `Pre-intervention health reference ~${Math.round(pre)}%.`,
        `Latest scan after action ~${Math.round(latest.healthScore ?? pre)}% (${after.length} follow-up scan(s)).`,
        delta >= 0
            ? "Trend suggests stabilization or recovery — continue scouting."
            : "Trend did not improve yet — verify treatment coverage, timing, or rule out additional stress.",
    ].join(" ");

    return { effectivenessScore, recoveryConfidence, narrative, deltaHealth: delta, followUpScanCount: after.length };
}

/**
 * Aggregate crude metrics for dashboard copy (privacy-safe, per-user).
 */
export function summarizeOperationsAnalytics(interventions, scans) {
    const n = interventions.length;
    if (!n) {
        return { summary: "No logged interventions yet — recording treatments builds effectiveness baselines." };
    }
    let scored = 0;
    let acc = 0;
    for (const inv of interventions) {
        const a = assessInterventionOutcome(inv, scans);
        if (typeof a.effectivenessScore === "number") {
            scored++;
            acc += a.effectivenessScore;
        }
    }
    const avgEff = scored ? Math.round((acc / scored) * 100) : null;
    return {
        summary:
            scored && avgEff != null
                ? `Rough effectiveness index across ${scored} scored intervention(s): ~${avgEff}% (inferred from scan trends, not proof of causation).`
                : `${n} intervention(s) logged — add follow-up scans to unlock effectiveness trends.`,
        interventionCount: n,
        scoredCount: scored,
        avgEffectivenessPct: avgEff,
    };
}
