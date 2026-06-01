/**
 * Optional farmer feedback for continuous improvement — writes to Firestore `vision_feedback`.
 * Requires authenticated user; collection rules mirror other per-user data.
 */

import { addDoc, collection, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} userId
 * @param {{
 *   kind: "confirm" | "correct" | "upload_sample",
 *   predictedLabel?: string | null,
 *   predictedClassId?: number | null,
 *   confidence?: number | null,
 *   farmerLabel?: string | null,
 *   cropSlug?: string | null,
 *   fieldId?: string | null,
 *   scanId?: string | null,
 *   modelVersion?: string | null,
 *   notes?: string | null,
 *   imageStoragePath?: string | null,
 * }} payload
 */
export async function submitVisionFeedback(db, userId, payload) {
    if (!db || !userId) {
        throw new Error("submitVisionFeedback: db and userId required");
    }
    return addDoc(collection(db, "vision_feedback"), {
        userId,
        createdAt: serverTimestamp(),
        kind: payload.kind,
        predictedLabel: payload.predictedLabel ?? null,
        predictedClassId: payload.predictedClassId ?? null,
        confidence: payload.confidence ?? null,
        farmerLabel: payload.farmerLabel ?? null,
        cropSlug: payload.cropSlug ?? null,
        fieldId: payload.fieldId ?? null,
        scanId: payload.scanId ?? null,
        modelVersion: payload.modelVersion ?? null,
        notes: payload.notes ?? null,
        imageStoragePath: payload.imageStoragePath ?? null,
    });
}
