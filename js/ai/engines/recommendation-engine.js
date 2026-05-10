import { tsToMs } from "../farmer-context.js";
import { calibrateEngineAction } from "../reliability/core.js";
import { getRecommendationCalibration } from "../../learning/calibration-apply.js";

function clampThreshold(x) {
    return Math.max(0.35, Math.min(0.72, x));
}

/**
 * Merge deterministic signals into ranked actions. No random scores.
 * @param {any} ctx
 * @param {{ weatherIntel: any, pestIntel: any, degraded?: { weatherFresh01?: number } }} engines
 */
export function runRecommendationEngine(ctx, { weatherIntel, pestIntel, degraded = {} }, learningProfile = null) {
    const cal = learningProfile ? getRecommendationCalibration(learningProfile) : null;
    const fungalBar = clampThreshold(0.45 + (cal?.fungalThresholdNudge || 0));
    const pestBar = clampThreshold(0.45 + (cal?.pestThresholdNudge || 0));
    const actions = [];

    if (weatherIntel?.fungalDiseasePressure?.score >= fungalBar) {
        actions.push({
            priority: "high",
            title: "Fungal disease vigilance",
            steps: [
                "Walk lows in the canopy morning — look for necrotic halos or powdery films.",
                "Improve airflow (pruning / row spacing) before extra fungicide passes.",
            ],
            reasoning: `Fungal pressure index ${Math.round((weatherIntel.fungalDiseasePressure.score || 0) * 100)}% from your live weather bundle.`,
            confidence: 0.72,
            confidenceBasis: "Humidity + rainfall thresholds calibrated against plant pathology heuristics.",
            primaryEpistemic: "predicted",
        });
    }

    if (pestIntel?.pestPressureIndex >= pestBar) {
        actions.push({
            priority: pestIntel.pestPressureIndex >= 0.6 ? "high" : "medium",
            title: "Pest scouting window",
            steps: [
                "Check leaf undersides at dawn for eggs and larvae.",
                "Document counts per plant to compare week-over-week.",
            ],
            reasoning: `Pest outlook index ${Math.round((pestIntel.pestPressureIndex || 0) * 100)}% from environment + your history.`,
            confidence: 0.65,
            confidenceBasis: "Combines microclimate stressors with your saved pest-risk scans.",
            primaryEpistemic: "predicted",
        });
    }

    const active = (ctx.recs || []).filter((r) => (r.status || "active") === "active");
    active.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    for (const r of active.slice(0, 3)) {
        actions.push({
            priority: "follow_up",
            title: "Existing recommendation",
            steps: [r.text],
            reasoning: "Already generated from your saved scan workflow.",
            confidence: 0.85,
            confidenceBasis: "Stored ai_recommendations tied to your account.",
            primaryEpistemic: "inferred",
        });
    }

    const scanCount = (ctx.scans || []).length;
    const weatherFresh01 =
        degraded && typeof degraded.weatherFresh01 === "number"
            ? degraded.weatherFresh01
            : 0.75;

    const calibrated = actions.map((a) => {
        let c = calibrateEngineAction(a, { scanCount, weatherFresh01 });
        if (cal?.comfortScale && typeof c.calibratedConfidence === "number") {
            c = {
                ...c,
                calibratedConfidence: Math.max(
                    0.12,
                    Math.min(0.95, c.calibratedConfidence * cal.comfortScale),
                ),
                learningAdjusted: true,
            };
        }
        return c;
    });

    return {
        engine: "recommendation_merge",
        version: 2,
        actions: calibrated,
    };
}
