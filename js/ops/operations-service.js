/**
 * Firestore helpers: interventions + operational tasks (human-in-the-loop only).
 */
import {
    addDoc,
    collection,
    doc,
    serverTimestamp,
    setDoc,
    updateDoc,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/**
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} userId
 * @param {{
 *   fieldId: string,
 *   interventionType: string,
 *   notes?: string,
 *   aiTriggerSource?: object,
 *   expectedOutcomeWindowHours?: number,
 *   followUpRecommendation?: string,
 *   preScanSnapshot?: object|null,
 * }} payload
 */
export async function logIntervention(db, userId, payload) {
    if (!db || !userId || !payload?.fieldId || !payload?.interventionType) {
        throw new Error("logIntervention: missing required fields");
    }
    const ref = await addDoc(collection(db, "farm_interventions"), {
        userId,
        fieldId: payload.fieldId,
        interventionType: payload.interventionType,
        performedAt: serverTimestamp(),
        notes: String(payload.notes || "").slice(0, 4000),
        aiTriggerSource: payload.aiTriggerSource || { kind: "manual" },
        expectedOutcomeWindowHours:
            typeof payload.expectedOutcomeWindowHours === "number"
                ? payload.expectedOutcomeWindowHours
                : 72,
        followUpRecommendation: String(payload.followUpRecommendation || "").slice(0, 1200),
        preScanSnapshot: payload.preScanSnapshot ?? null,
        outcomeEffectiveness: null,
        schemaVersion: 1,
        createdAt: serverTimestamp(),
    });
    return ref.id;
}

export async function updateInterventionOutcome(db, interventionId, outcome) {
    await updateDoc(doc(db, "farm_interventions", interventionId), {
        outcomeEffectiveness: outcome,
        outcomeAssessedAt: serverTimestamp(),
    });
}

/**
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} userId
 * @param {{
 *   fieldId?: string|null,
 *   title: string,
 *   detail?: string,
 *   priority?: string,
 *   dueAtMs?: number|null,
 *   source?: string,
 *   triggerRefs?: object,
 * }} task
 */
export async function createOperationalTask(db, userId, task) {
    const dueAt = task.dueAtMs ? new Date(task.dueAtMs) : null;
    const ref = await addDoc(collection(db, "farm_operational_tasks"), {
        userId,
        fieldId: task.fieldId || null,
        title: String(task.title || "").slice(0, 280),
        detail: String(task.detail || "").slice(0, 2000),
        priority: task.priority || "normal",
        status: "open",
        dueAt: dueAt,
        source: task.source || "user",
        triggerRefs: task.triggerRefs || {},
        schemaVersion: 1,
        createdAt: serverTimestamp(),
    });
    return ref.id;
}

export async function completeOperationalTask(db, taskId) {
    await updateDoc(doc(db, "farm_operational_tasks", taskId), {
        status: "done",
        completedAt: serverTimestamp(),
    });
}

export async function dismissOperationalTask(db, taskId) {
    await updateDoc(doc(db, "farm_operational_tasks", taskId), {
        status: "dismissed",
        completedAt: serverTimestamp(),
    });
}

/**
 * Idempotent follow-up task after scan (dedupe by scan id).
 */
export async function ensurePostScanFollowUpTask(db, userId, fieldId, scanId, healthScore) {
    if (!userId || !fieldId || !scanId) return;
    const id = `${userId}_${fieldId}_post_scan_${scanId}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 420);
    const weak = typeof healthScore === "number" ? healthScore < 58 : false;
    if (!weak) return;
    await setDoc(
        doc(db, "farm_operational_tasks", id),
        {
            userId,
            fieldId,
            title: "Follow-up scan & field check",
            detail:
                "Health looked stressed on the latest save — plan a scouting pass and a re-scan within 24–48h to track recovery. You stay in control of any treatment.",
            priority: typeof healthScore === "number" && healthScore < 42 ? "high" : "normal",
            status: "open",
            dueAt: new Date(Date.now() + 36 * 3600000),
            source: "ai",
            triggerRefs: { scanId },
            schemaVersion: 1,
            createdAt: serverTimestamp(),
        },
        { merge: true },
    );
}
