/**
 * Build a compact digital-twin snapshot for one field (living model inputs).
 * All semantics are heuristic — not a biophysical crop model.
 */
import { tsToMs } from "../ai/farmer-context.js?v=34";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

/**
 * Rough growth stage from planted date (when present).
 * @param {string|null} plantedAt ISO date
 */
function inferGrowthStage(plantedAt) {
    if (!plantedAt) return { label: "unknown", progress01: 0.5 };
    const t = Date.parse(plantedAt);
    if (!Number.isFinite(t)) return { label: "unknown", progress01: 0.5 };
    const days = (Date.now() - t) / 86400000;
    if (days < 21) return { label: "early", progress01: clamp(days / 90, 0.05, 0.35) };
    if (days < 70) return { label: "mid", progress01: clamp(0.35 + (days - 21) / 120, 0.35, 0.72) };
    if (days < 130) return { label: "late", progress01: clamp(0.72 + (days - 70) / 200, 0.72, 0.95) };
    return { label: "senescence", progress01: 0.95 };
}

/**
 * @param {object} opts
 * @param {any} opts.field
 * @param {any[]} opts.scans field-scoped
 * @param {any|null} opts.ctxState field_context_state doc
 * @param {any[]} opts.interventions field-scoped (optional)
 * @param {string} [opts.regionalSnippet] anonymized regional briefing tail
 */
export function buildDigitalTwinState({ field, scans, ctxState, interventions = [], regionalSnippet = "" }) {
    const sorted = (scans || []).slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    const latest = sorted[0] || null;
    const health0 =
        typeof latest?.healthScore === "number" ? latest.healthScore : sorted.length ? 68 : null;

    const fungalMem =
        sorted.filter((s) => s?.diagnosis?.code === "fungal_risk").length >= 2 ? 0.55
        : sorted.some((s) => s?.diagnosis?.code === "fungal_risk") ? 0.32
        : 0.12;

    const pestMem =
        sorted.filter((s) => s?.diagnosis?.code === "pest_damage").length >= 2 ? 0.45
        : sorted.some((s) => s?.diagnosis?.code === "pest_damage") ? 0.25
        : 0.1;

    const oh = ctxState?.outbreakHistory;
    const outbreakRecurrence = Array.isArray(oh) && oh.length ? clamp(0.2 + oh.length * 0.12, 0, 0.85) : 0.15;

    const stability0 =
        typeof ctxState?.stabilityScore === "number" ? clamp(ctxState.stabilityScore, 0.05, 0.98) : 0.52;

    const recentTreat =
        (interventions || []).filter((x) => {
            const t = tsToMs(x.performedAt);
            return t && Date.now() - t < 10 * 86400000;
        }).length;

    const growth = inferGrowthStage(field?.plantedAt || null);
    const scanCount = sorted.length;

    let dataConfidence = "low";
    if (scanCount >= 4 && health0 != null) dataConfidence = "medium";
    if (scanCount >= 8 && health0 != null && ctxState) dataConfidence = "high";

    return {
        fieldId: field?.id || null,
        cropType: field?.cropType || null,
        irrigationType: field?.irrigationType || null,
        growth,
        health0: health0 ?? 72,
        fungalMemory01: fungalMem,
        pestMemory01: pestMem,
        outbreakRecurrence01: outbreakRecurrence,
        stability0,
        recentInterventionCount10d: recentTreat,
        scanCount,
        latestDiagnosisCode: latest?.diagnosis?.code || null,
        dataConfidence,
        regionalSnippet: String(regionalSnippet || "").slice(0, 400),
    };
}
