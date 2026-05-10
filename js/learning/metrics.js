/**
 * Outcome metrics from interventions + scans (EMAs, bounded).
 */
import { tsToMs } from "../ai/farmer-context.js?v=34";
import { assessInterventionOutcome } from "../ops/effectiveness.js";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

function ema(prev, x, alpha) {
    if (prev == null || Number.isNaN(prev)) return x;
    return prev * (1 - alpha) + x * alpha;
}

/**
 * @param { Record<string, any> } fieldStats prev
 * @param {any[]} interventions
 * @param {any[]} scans
 */
export function updateFieldOutcomeStats(fieldStats, interventions, scans) {
    const next = { ...fieldStats };
    const byField = new Map();
    for (const inv of interventions || []) {
        const fid = inv.fieldId;
        if (!fid) continue;
        if (!byField.has(fid)) byField.set(fid, []);
        byField.get(fid).push(inv);
    }

    for (const [fid, invs] of byField) {
        const fScans = (scans || []).filter((s) => s.fieldId === fid);
        let successN = 0;
        let scoredN = 0;
        let recoverySum = 0;
        for (const inv of invs) {
            const out = assessInterventionOutcome(inv, fScans);
            if (typeof out.effectivenessScore === "number") {
                scoredN++;
                if (out.effectivenessScore >= 0.52) successN++;
                recoverySum += out.deltaHealth ?? 0;
            }
        }
        const prev = next[fid] || {};
        const alpha = 0.22;
        const rate = scoredN ? successN / scoredN : null;
        next[fid] = {
            interventionSuccessEma:
                rate != null ? ema(prev.interventionSuccessEma, rate, alpha) : prev.interventionSuccessEma ?? null,
            recoveryDeltaEma:
                scoredN > 0
                    ? ema(prev.recoveryDeltaEma, recoverySum / scoredN, alpha)
                    : prev.recoveryDeltaEma ?? null,
            interventionsScoredTotal: (prev.interventionsScoredTotal || 0) + scoredN,
            lastUpdatedMs: Date.now(),
        };
    }
    return next;
}

/**
 * Compare last twin projection anchor vs newest scan (crude simulation feedback).
 * @param {any} pending { fieldId, predictedEndHealth, capturedAt }
 * @param {any[]} scans
 * @returns {{ error: number|null, fieldId: string|null }}
 */
export function twinDivergenceFromPending(pending, scans) {
    if (!pending?.fieldId || typeof pending.predictedEndHealth !== "number") {
        return { error: null, fieldId: null };
    }
    let best = null;
    let bestT = 0;
    for (const s of scans || []) {
        if (s.fieldId !== pending.fieldId) continue;
        const t = tsToMs(s.createdAt);
        if (t >= pending.capturedAt && t >= bestT) {
            bestT = t;
            best = s;
        }
    }
    if (!best || typeof best.healthScore !== "number") return { error: null, fieldId: pending.fieldId };
    const err = best.healthScore - pending.predictedEndHealth;
    return { error: err, fieldId: pending.fieldId };
}

export function updateSimErrorEma(prevEma, prevN, error, alpha = 0.18) {
    const next = ema(prevEma, error, alpha);
    return { simErrorEma: clamp(next, -25, 25), simSampleCount: (prevN || 0) + 1 };
}
