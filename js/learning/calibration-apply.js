/**
 * Apply learned calibration in a bounded, explainable way.
 */
function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

/**
 * Local-only preview flag (`localStorage.agri_learning_preview === "1"`).
 * When true, optional numeric fields on `profile.sandbox` may scale twin/recommendation test multipliers;
 * **does not** require `sandbox.enabled === true` (that flag stays for heavier experimental overlays elsewhere).
 */
export function isLearningSandboxPreview() {
    try {
        return localStorage.getItem("agri_learning_preview") === "1";
    } catch {
        return false;
    }
}

/**
 * @param {any} profile learning_profiles doc
 * @returns {{ comfortScale: number, fungalThresholdNudge: number, pestThresholdNudge: number, fungalSimMul: number, stressSimMul: number, healthBiasCorrection: number, source: string }}
 */
export function getRecommendationCalibration(profile) {
    const g = profile?.global || {};
    const sand = profile?.sandbox || {};
    const preview = isLearningSandboxPreview();
    let comfortScale = typeof g.recommendationComfortScale === "number" ? g.recommendationComfortScale : 1;
    let fungalNudge = typeof g.fungalTriggerLearned === "number" ? g.fungalTriggerLearned : 0;
    let pestNudge = typeof g.pestTriggerLearned === "number" ? g.pestTriggerLearned : 0;
    if (preview && typeof sand.comfortScale === "number") comfortScale *= sand.comfortScale;
    comfortScale = clamp(comfortScale, 0.82, 1.12);
    fungalNudge = clamp(fungalNudge, -0.08, 0.08);
    pestNudge = clamp(pestNudge, -0.08, 0.08);
    return {
        comfortScale,
        fungalThresholdNudge: fungalNudge,
        pestThresholdNudge: pestNudge,
        fungalSimMul: clamp(
            (g.regionalStressLearnedMul || 1) * (preview && typeof sand.fungalMul === "number" ? sand.fungalMul : 1),
            0.85,
            1.2,
        ),
        stressSimMul: 1,
        healthBiasCorrection: typeof g.simErrorEma === "number" ? clamp(g.simErrorEma * 0.15, -4, 4) : 0,
        source: preview ? "production+sandbox_preview" : "production",
    };
}

export function appendAudit(prevLog, entry, cap = 14) {
    const log = Array.isArray(prevLog) ? prevLog.slice() : [];
    log.unshift({
        at: Date.now(),
        ...entry,
    });
    return log.slice(0, cap);
}

export function appendTimeline(prev, entry, cap = 18) {
    const t = Array.isArray(prev) ? prev.slice() : [];
    t.unshift({
        at: Date.now(),
        ...entry,
    });
    return t.slice(0, cap);
}
