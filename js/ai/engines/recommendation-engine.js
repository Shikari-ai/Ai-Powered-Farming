import { tsToMs } from "../farmer-context.js";

/**
 * Merge deterministic signals into ranked actions. No random scores.
 */
export function runRecommendationEngine(ctx, { weatherIntel, pestIntel }) {
    const actions = [];

    if (weatherIntel?.fungalDiseasePressure?.score >= 0.45) {
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
        });
    }

    if (pestIntel?.pestPressureIndex >= 0.45) {
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
        });
    }

    return {
        engine: "recommendation_merge",
        version: 1,
        actions,
    };
}
