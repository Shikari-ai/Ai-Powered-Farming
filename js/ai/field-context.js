/**
 * Longitudinal field memory for contextual AI (Firestore).
 * Doc id: fieldId (same as `fields` collection).
 */

import { tsToMs } from "./farmer-context.js?v=34";
import {
    addDoc,
    collection,
    doc,
    getDoc,
    increment,
    serverTimestamp,
    setDoc,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

function uniqueLabels(labels) {
    const out = [];
    const seen = new Set();
    for (const x of labels || []) {
        const s = String(x || "").trim();
        if (!s || seen.has(s)) continue;
        seen.add(s);
        out.push(s);
        if (out.length >= 10) break;
    }
    return out;
}

/**
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} userId
 * @param {string} fieldId
 * @param {{
 *   topHypothesis?: string | null,
 *   detections?: any[],
 *   cropSlug?: string | null,
 *   growthStageSlug?: string | null,
 * }} payload
 */
export async function mergeVisionInferenceIntoFieldMemory(db, userId, fieldId, payload) {
    if (!db || !userId || !fieldId) return;

    const ref = doc(db, "field_context_state", fieldId);
    const snap = await getDoc(ref);
    const prev = snap.exists() ? snap.data() : {};

    const fromDets = (payload.detections || []).map((d) => d.label).filter(Boolean);
    const labels = uniqueLabels([...(prev.lastVisionLabels || []), ...fromDets]);

    /** @type {any[]} */
    let outbreaks = Array.isArray(prev.outbreakHistory) ? [...prev.outbreakHistory] : [];
    const top = payload.topHypothesis ? String(payload.topHypothesis) : "";
    if (top && top !== "healthy_leaf") {
        outbreaks.unshift({ label: top, at: Date.now(), source: "vision" });
        outbreaks = outbreaks.slice(0, 15);
    }

    let stability = typeof prev.stabilityScore === "number" ? prev.stabilityScore : 72;
    if (top && top !== "healthy_leaf") stability = Math.max(28, stability - 5);
    else if (top === "healthy_leaf") stability = Math.min(96, stability + 3);

    await setDoc(
        ref,
        {
            userId,
            fieldId,
            updatedAt: serverTimestamp(),
            lastVisionAt: serverTimestamp(),
            cropSlug: payload.cropSlug || prev.cropSlug || null,
            growthStageSlug: payload.growthStageSlug || prev.growthStageSlug || null,
            lastTopHypothesis: top || prev.lastTopHypothesis || null,
            lastVisionLabels: labels,
            outbreakHistory: outbreaks,
            stabilityScore: Math.round(stability),
            visionInferenceCount: increment(1),
            schemaVersion: 1,
        },
        { merge: true },
    );

    await addDoc(collection(db, "field_context_events"), {
        userId,
        fieldId,
        type: "vision_inference",
        createdAt: serverTimestamp(),
        payload: {
            topHypothesis: top || null,
            topConfidence:
                payload.topConfidence != null && !Number.isNaN(Number(payload.topConfidence))
                    ? Number(payload.topConfidence)
                    : null,
            maxModelConfidence:
                payload.maxModelConfidence != null && !Number.isNaN(Number(payload.maxModelConfidence))
                    ? Number(payload.maxModelConfidence)
                    : null,
            detectionCount: (payload.detections || []).length,
            cropSlug: payload.cropSlug || null,
        },
        schemaVersion: 1,
    });
}

/**
 * After a symptom-based scan save (rules / manual).
 */
export async function mergeSymptomScanIntoFieldMemory(db, userId, fieldId, payload) {
    if (!db || !userId || !fieldId) return;
    const ref = doc(db, "field_context_state", fieldId);
    const snap = await getDoc(ref);
    const prev = snap.exists() ? snap.data() : {};

    const label = payload.diagnosisLabel || payload.diagnosis?.label || "";
    /** @type {any[]} */
    let outbreaks = Array.isArray(prev.outbreakHistory) ? [...prev.outbreakHistory] : [];
    if (label && payload.severity !== "good") {
        outbreaks.unshift({ label: String(label), at: Date.now(), source: "symptom_scan" });
        outbreaks = outbreaks.slice(0, 15);
    }

    await setDoc(
        ref,
        {
            userId,
            fieldId,
            updatedAt: serverTimestamp(),
            lastSymptomScanAt: serverTimestamp(),
            cropSlug: payload.cropSlug || prev.cropSlug || null,
            outbreakHistory: outbreaks,
            symptomScanCount: increment(1),
            schemaVersion: 1,
        },
        { merge: true },
    );

    await addDoc(collection(db, "field_context_events"), {
        userId,
        fieldId,
        type: "symptom_scan",
        createdAt: serverTimestamp(),
        payload: {
            diagnosisLabel: label || null,
            healthScore: payload.healthScore ?? null,
        },
        schemaVersion: 1,
    });
}

/**
 * Derive compact blocks for POST /v1/vision/disease context_json.
 * @param {any[]} fieldContextStates
 * @param {any[]} scans
 * @param {any[]} fields
 */
export function summarizeFieldMemoryForVision(fieldContextStates, scans, fields) {
    const now = Date.now();
    const windowMs = 30 * 86400000;
    const blocks = [];
    const states = fieldContextStates || [];
    const scanArr = scans || [];
    const fieldArr = fields || [];

    for (const s of states) {
        const fid = s.fieldId || s.id;
        if (!fid) continue;
        let scanCount30d = 0;
        for (const sc of scanArr) {
            if ((sc.fieldId || "") !== fid) continue;
            const t = tsToMs(sc.createdAt);
            if (t && now - t < windowMs) scanCount30d++;
        }
        const field = fieldArr.find((f) => f.id === fid);
        const cropRaw = s.cropSlug || field?.cropType || "";
        blocks.push({
            field_id: fid,
            crop_slug: cropRaw
                ? String(cropRaw)
                      .trim()
                      .toLowerCase()
                      .replace(/\s+/g, "_")
                : null,
            growth_stage: s.growthStageSlug || null,
            stability: typeof s.stabilityScore === "number" ? s.stabilityScore : null,
            recent_labels: (s.lastVisionLabels || []).slice(0, 6),
            outbreak_history: (s.outbreakHistory || []).slice(0, 5),
            scan_count_30d: scanCount30d,
        });
    }
    return blocks;
}
