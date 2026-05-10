import { tsToMs } from "../farmer-context.js";

/**
 * Transparent yield outlook — trend + uncertainty, not fabricated tonnage.
 */
export function runYieldOutlook(ctx) {
    const scans = ctx.scans || [];
    if (scans.length < 3) {
        return {
            engine: "yield_outlook",
            version: 1,
            status: "insufficient_history",
            message:
                "Yield forecasting needs more longitudinal health records. Save at least three crop scans over time (or connect field yield logs when available).",
            outlook: null,
        };
    }

    const last3 = scans.slice(0, 3).map((s) => (typeof s.healthScore === "number" ? s.healthScore : null));
    const valid = last3.filter((x) => x != null);
    if (valid.length < 2) {
        return {
            engine: "yield_outlook",
            version: 1,
            status: "insufficient_scores",
            message: "Recent scans are missing numeric health scores needed for a defensible trend.",
            outlook: null,
        };
    }

    const avgRecent = valid.reduce((a, b) => a + b, 0) / valid.length;
    const older = scans.slice(3, 6).map((s) => (typeof s.healthScore === "number" ? s.healthScore : null)).filter((x) => x != null);
    const avgOlder = older.length ? older.reduce((a, b) => a + b, 0) / older.length : null;

    let trend = "stable";
    let delta = 0;
    if (avgOlder != null) {
        delta = avgRecent - avgOlder;
        if (delta > 6) trend = "improving";
        else if (delta < -6) trend = "worsening";
    }

    const latest = scans[0];
    const daysSince = latest?.createdAt ? (Date.now() - tsToMs(latest.createdAt)) / 86400000 : null;

    return {
        engine: "yield_outlook",
        version: 1,
        status: "trend_only",
        message:
            "This is a health-score trend outlook, not a calibrated bushel/hectare model. Connect your FastAPI yield service for econometric forecasts.",
        outlook: {
            trend,
            healthScoreDelta: Math.round(delta),
            recentAvgHealth: Math.round(avgRecent),
            olderAvgHealth: avgOlder != null ? Math.round(avgOlder) : null,
            dataRecencyDays: daysSince != null ? Math.round(daysSince) : null,
        },
        interpretation:
            trend === "improving"
                ? "Logged crop health is moving up — keep following recommendations and verify with field checks."
                : trend === "worsening"
                  ? "Logged crop health is declining — prioritize the highest-severity field observations you recorded."
                  : "Logged crop health is roughly steady — maintain scouting cadence.",
    };
}
