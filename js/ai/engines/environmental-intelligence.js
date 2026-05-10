/**
 * Environmental intelligence — merges latest Firestore environmental_data docs with live weather readings.
 */

import { tsToMs } from "../farmer-context.js";
export function runEnvironmentalIntelligence(ctx, wxReadings) {
    const env = ctx.environmental || [];
    const envTs = (doc) => tsToMs(doc.recordedAt) || tsToMs(doc.createdAt) || tsToMs(doc.timestamp) || 0;
    const latest = env.slice().sort((a, b) => envTs(b) - envTs(a))[0];

    const parts = [];
    if (!env.length) {
        parts.push("No sensor / manual environmental logs in Firestore yet — weather-only view.");
    } else {
        parts.push(`Latest environmental record${latest?.label ? `: ${latest.label}` : ""} stored in your account.`);
    }

    if (wxReadings) {
        parts.push(
            `Open-Meteo snapshot: ${wxReadings.temperatureC != null ? `${Math.round(wxReadings.temperatureC)}°C` : "—"}, ` +
                `${wxReadings.humidityPct != null ? `${Math.round(wxReadings.humidityPct)}% RH` : "—"}.`
        );
    }

    return {
        engine: "environmental",
        version: 1,
        summary: parts.join(" "),
        sensorDocCount: env.length,
    };
}
