/**
 * Geo-derived alerts (deterministic IDs, at-most-daily per key).
 */
import {
    doc,
    serverTimestamp,
    setDoc,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { buildGeoAlertReliability, gateAlertSeverity } from "../ai/reliability/core.js";

/**
 * @param {import("firebase/firestore").Firestore} db
 */
export async function syncGeoDerivedAlerts(db, userId, payload) {
    if (!userId || !payload?.fieldId) return;
    const dayKey = new Date().toISOString().slice(0, 10);
    const { fieldId, fieldName, stressMean, ndviProxy, signals } = payload;

    if (typeof stressMean === "number" && stressMean >= 0.68) {
        const id = `${userId}_geo_stress_${fieldId}_${dayKey}`.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 450);
        const geoRel = buildGeoAlertReliability({ stressMean, ndviProxy });
        let sev = stressMean >= 0.78 ? "high" : "warn";
        sev = gateAlertSeverity(sev, geoRel.calibratedConfidence);
        await setDoc(
            doc(db, "alerts", id),
            {
                userId,
                severity: sev,
                title: "Vegetation stress pattern (geo fusion)",
                body: `${fieldName || "Field"}: inferred stress index ${Math.round(stressMean * 100)}%` +
                    (typeof ndviProxy === "number" ? `; vigor proxy ~${Math.round(ndviProxy * 100)}%.` : ".") +
                    (signals?.length ? ` Signals: ${signals.slice(0, 4).map((s) => s.id).join(", ")}.` : "") +
                    " Inferred from fused scan + weather + field intelligence — confirm with scouting.",
                type: "geo_vegetation",
                source: "geo_intel_pipeline",
                fieldId,
                readAt: null,
                createdAt: serverTimestamp(),
                dayKey,
                dataScope: "inferred",
                schemaVersion: 2,
                reliability: geoRel,
                epistemicPrimary: geoRel.primaryEpistemic,
            },
            { merge: true },
        );
    }
}
