/**
 * Persist compact monthly geo-intelligence snapshots (land memory).
 */
import {
    doc,
    serverTimestamp,
    setDoc,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

export function geoSnapshotDocId(userId, fieldId, periodKey) {
    const raw = `${userId}_${fieldId}_${periodKey}`.replace(/[^a-zA-Z0-9_]/g, "_");
    return raw.slice(0, 450);
}

/**
 * @param {import("firebase/firestore").Firestore} db
 */
export async function mergeGeoIntelSnapshot(db, userId, fieldId, periodKey, body) {
    if (!userId || !fieldId || !periodKey) return;
    const id = geoSnapshotDocId(userId, fieldId, periodKey);
    await setDoc(
        doc(db, "geo_intel_snapshots", id),
        {
            userId,
            fieldId,
            periodKey,
            schemaVersion: 1,
            updatedAt: serverTimestamp(),
            ...body,
        },
        { merge: true },
    );
}
