/**
 * Reflective verification: lightweight, explainable checks before strong claims (no extra network).
 */

import { tsToMs } from "./farmer-context.js";

/**
 * @param {{
 *   cognitivePlan: import('./cognitive-plan.js').CognitivePlan | null,
 *   results: Record<string, any>,
 *   snapshot: any,
 *   degraded: { degraded?: boolean, weatherFresh01?: number, reasons?: string[] },
 * }} ctx
 */
export function buildReflectiveVerification(ctx) {
    const plan = ctx.cognitivePlan;
    if (!plan?.verificationPass) {
        return { checks: [], notes: [], softenStrongClaims: false };
    }

    const checks = [];
    const notes = [];
    const degraded = ctx.degraded || {};
    const results = ctx.results || {};
    const snapshot = ctx.snapshot || {};

    if (degraded.degraded) checks.push("degraded_mode");
    const wf = typeof degraded.weatherFresh01 === "number" ? degraded.weatherFresh01 : 0.75;
    if (wf < 0.48) checks.push("stale_weather_evidence");

    const wx = results.weatherIntelligence;
    if (wx?.error) checks.push("weather_unavailable");

    const vis = results.diseaseVision;
    if (vis && !vis.error && vis.status === "ok" && typeof vis.confidence === "number" && vis.confidence < 0.38) {
        checks.push("vision_low_confidence");
        notes.push("The image model’s confidence is on the low side — a quick field look beats acting on the label alone.");
    }

    const fungal = wx?.fungalDiseasePressure?.score;
    const scans = snapshot.scans || [];
    const latest = scans
        .slice()
        .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))[0];
    const health = latest?.healthScore;
    if (typeof fungal === "number" && fungal > 0.62 && typeof health === "number" && health > 78) {
        checks.push("signal_tension_weather_vs_scan");
        notes.push("Humidity-style pressure reads elevated versus your latest saved scan — worth watching, not a rush verdict.");
    }

    const rec = results.recommendations;
    if (rec?.actions?.length && wf < 0.42) {
        checks.push("action_confidence_coupon");
    }

    const softenStrongClaims = checks.length >= 2 || wf < 0.45 || checks.includes("vision_low_confidence");

    return {
        checks,
        notes: notes.slice(0, 2),
        softenStrongClaims,
    };
}
