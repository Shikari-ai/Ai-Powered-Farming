/**
 * Build anonymized regional pulse and merge into regional_index (client-side aggregation).
 * One contribution per user per coarse cell per ISO week (deduped via users/{uid}/regional_sent).
 */
import {
    doc,
    runTransaction,
    serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { anonymizedCentroidCell, cellFromWeatherLog, isoWeekKey } from "./regional-privacy.js";

function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

/**
 * Derive numeric signals only — no crop names tied to identity in aggregate (optional cropBucket coarse).
 * @param {object} params
 */
export function buildRegionalPulse({
    fields,
    scansByField,
    contextByField,
    weatherLog,
}) {
    const fieldsArr = Array.isArray(fields) ? fields : [];
    let cell = anonymizedCentroidCell(fieldsArr);
    if (!cell && weatherLog) cell = cellFromWeatherLog(weatherLog);
    if (!cell) return null;

    let stressSum = 0;
    let stressN = 0;
    let fungal = 0;
    let pest = 0;
    let unstable = 0;

    for (const f of fieldsArr) {
        const scan = scansByField?.[f.id];
        if (scan && typeof scan.healthScore === "number") {
            stressSum += (100 - scan.healthScore) / 100;
            stressN++;
        }
        const code = scan?.diagnosis?.code || "";
        if (/fungal|mold|mildew/.test(String(code))) fungal += 0.35;
        if (/pest/.test(String(code))) pest += 0.35;
        const ctx = contextByField?.[f.id];
        if (typeof ctx?.stabilityScore === "number" && ctx.stabilityScore < 0.42) unstable += 0.15;
    }

    const hum = weatherLog?.current?.relative_humidity_2m;
    const humStress = typeof hum === "number" ? clamp01((hum - 72) / 28) * 0.25 : 0;

    const stress = clamp01(
        (stressN ? stressSum / stressN : 0.35) + Math.min(0.4, fungal + pest) + humStress + unstable,
    );

    return {
        cellId: cell.cellId,
        latBucket: cell.lat,
        lngBucket: cell.lng,
        stress,
        fungalMass: clamp01(fungal),
        pestMass: clamp01(pest),
        humidityCoarse: typeof hum === "number" ? Math.round(hum / 5) * 5 : null,
        schemaVersion: 1,
        dataScope: "anonymized_aggregate",
    };
}

function sentDocId(weekKey, cellId) {
    return `${weekKey}_${cellId}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 420);
}

/**
 * @param {import("firebase/firestore").Firestore} db
 */
export async function contributeRegionalPulse(db, userId, pulse, options = {}) {
    if (!userId || !pulse?.cellId) return { ok: false, reason: "no_pulse" };

    const relay = typeof window !== "undefined" ? window.__AGRI_REGIONAL_RELAY__ : null;
    if (typeof relay === "string" && relay.startsWith("http")) {
        try {
            await fetch(`${relay.replace(/\/$/, "")}/v1/regional/pulse`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    weekKey: options.weekKey || isoWeekKey(),
                    pulse,
                }),
            });
            return { ok: true, federated: true };
        } catch (e) {
            console.warn("[regional] relay failed, falling back to Firestore:", e?.message);
        }
    }

    const weekKey = options.weekKey || isoWeekKey();
    const cellRef = doc(db, "regional_index", weekKey, "cells", pulse.cellId);
    const sentRef = doc(db, "users", userId, "regional_sent", sentDocId(weekKey, pulse.cellId));

    try {
        await runTransaction(db, async (tx) => {
            const sentSnap = await tx.get(sentRef);
            if (sentSnap.exists()) return;

            const cellSnap = await tx.get(cellRef);
            const prev = cellSnap.data() || {};
            const n = (prev.sampleN || 0) + 1;
            const wStress = ((prev.stressEWMA || 0) * (prev.sampleN || 0) + pulse.stress) / n;
            const wF = ((prev.fungalEWMA || 0) * (prev.sampleN || 0) + pulse.fungalMass) / n;
            const wP = ((prev.pestEWMA || 0) * (prev.sampleN || 0) + pulse.pestMass) / n;
            let humAvg = prev.humidityCoarseAvg ?? null;
            if (typeof pulse.humidityCoarse === "number") {
                humAvg =
                    humAvg == null
                        ? pulse.humidityCoarse
                        : (humAvg * (prev.sampleN || 0) + pulse.humidityCoarse) / n;
            }

            tx.set(
                cellRef,
                {
                    weekKey,
                    cellId: pulse.cellId,
                    latBucket: pulse.latBucket,
                    lngBucket: pulse.lngBucket,
                    stressEWMA: wStress,
                    fungalEWMA: wF,
                    pestEWMA: wP,
                    humidityCoarseAvg: humAvg,
                    sampleN: n,
                    trustCalibration: typeof prev.trustCalibration === "number" ? prev.trustCalibration : 0.5,
                    updatedAt: serverTimestamp(),
                    schemaVersion: 1,
                    observed: "coarse_grid_rollup",
                    inferred: "ewma_signals",
                },
                { merge: true },
            );

            tx.set(sentRef, {
                weekKey,
                cellId: pulse.cellId,
                createdAt: serverTimestamp(),
                schemaVersion: 1,
            });
        });
        return { ok: true, weekKey, cellId: pulse.cellId };
    } catch (e) {
        console.warn("[regional] contribute:", e?.message || e);
        return { ok: false, reason: String(e?.message || e) };
    }
}
