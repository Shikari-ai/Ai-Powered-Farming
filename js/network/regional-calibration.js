/**
 * Anonymous-style calibration: adjusts trust field on coarse cell.
 * Deduped per user per cell per week; quota per calendar day.
 */
import {
    doc,
    runTransaction,
    serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

function calibSentId(weekKey, cellId, vote) {
    return `${weekKey}_${cellId}_${vote}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 400);
}

function dayKey() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * vote: "align" | "too_alarmist"
 * delta trust: small EWMA bump
 */
export async function submitRegionalCalibration(db, userId, weekKey, cellId, vote) {
    if (!userId || !weekKey || !cellId || !vote) return { ok: false };

    const cellRef = doc(db, "regional_index", weekKey, "cells", cellId);
    const sentRef = doc(db, "users", userId, "regional_calib", calibSentId(weekKey, cellId, vote));
    const quotaRef = doc(db, "users", userId, "regional_calib_quota", dayKey());

    try {
        await runTransaction(db, async (tx) => {
            const qSnap = await tx.get(quotaRef);
            const used = qSnap.data()?.count || 0;
            if (used >= 12) throw new Error("quota");

            const sSnap = await tx.get(sentRef);
            if (sSnap.exists()) throw new Error("duplicate");

            const cSnap = await tx.get(cellRef);
            if (!cSnap.exists()) throw new Error("no_cell");

            const prevT = typeof cSnap.data()?.trustCalibration === "number" ? cSnap.data().trustCalibration : 0.5;
            let nextT = prevT;
            if (vote === "align") nextT = Math.min(0.92, prevT + 0.04);
            if (vote === "too_alarmist") nextT = Math.max(0.15, prevT - 0.05);

            const calUp = (cSnap.data()?.calibrationAlign || 0) + (vote === "align" ? 1 : 0);
            const calDown = (cSnap.data()?.calibrationDown || 0) + (vote === "too_alarmist" ? 1 : 0);

            tx.set(
                cellRef,
                {
                    trustCalibration: nextT,
                    calibrationAlign: calUp,
                    calibrationDown: calDown,
                    updatedAt: serverTimestamp(),
                },
                { merge: true },
            );
            tx.set(
                sentRef,
                { weekKey, cellId, vote, createdAt: serverTimestamp(), schemaVersion: 1 },
              { merge: true },
            );
            tx.set(
                quotaRef,
                { count: used + 1, day: dayKey(), updatedAt: serverTimestamp() },
                { merge: true },
            );
        });
        return { ok: true };
    } catch (e) {
        const m = e?.message || String(e);
        if (m === "quota" || m === "duplicate") return { ok: false, reason: m };
        console.warn("[regional] calib:", m);
        return { ok: false, reason: m };
    }
}
