/**
 * Aggregates longitudinal signals into learning_profiles (batched, explainable writes).
 */
import {
    doc,
    getDoc,
    setDoc,
    collection,
    query,
    where,
    orderBy,
    limit,
    getDocs,
    serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { defaultLearningProfile, LEARNING_PROFILE_VERSION } from "./defaults.js";
import { buildKnowledgeEdges } from "./knowledge-edges.js";
import { updateFieldOutcomeStats, twinDivergenceFromPending, updateSimErrorEma } from "./metrics.js";
import { buildReflectionSnippets } from "./reflection.js";
import { appendAudit, appendTimeline } from "./calibration-apply.js";
import { pickFocusFieldForTwin, latestWeatherBundle } from "../twin/assistant-twin-brief.js";
import { buildDigitalTwinState } from "../twin/twin-state.js";
import { runScenarioProjection } from "../twin/simulation-engine.js";
import { tsToMs } from "../ai/farmer-context.js?v=34";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

function emaPair(prev, x, alpha) {
    return prev * (1 - alpha) + x * alpha;
}

async function fetchLimited(db, userId) {
    const [fieldsSnap, scansSnap, intSnap, wxSnap, ctxSnap, existingSnap] = await Promise.all([
        getDocs(query(collection(db, "fields"), where("userId", "==", userId), limit(80))),
        getDocs(query(collection(db, "crop_scans"), where("userId", "==", userId), orderBy("createdAt", "desc"), limit(200))),
        getDocs(query(collection(db, "farm_interventions"), where("userId", "==", userId), limit(150))),
        getDocs(query(collection(db, "weather_logs"), where("userId", "==", userId), limit(20))),
        getDocs(query(collection(db, "field_context_state"), where("userId", "==", userId), limit(50))),
        getDoc(doc(db, "learning_profiles", userId)),
    ]);

    const fields = [];
    fieldsSnap.forEach((d) => fields.push({ id: d.id, ...d.data() }));
    const scans = [];
    scansSnap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
    const interventions = [];
    intSnap.forEach((d) => interventions.push({ id: d.id, ...d.data() }));
    interventions.sort((a, b) => tsToMs(b.performedAt) - tsToMs(a.performedAt));
    const weatherLogs = [];
    wxSnap.forEach((d) => weatherLogs.push({ id: d.id, ...d.data() }));
    weatherLogs.sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt));
    const fieldContextStates = [];
    ctxSnap.forEach((d) => fieldContextStates.push({ id: d.id, fieldId: d.id, ...d.data() }));

    return { fields, scans, interventions, weatherLogs, fieldContextStates, existingSnap };
}

/**
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} userId
 * @param {string} reason
 */
export async function runLearningAggregation(db, userId, reason = "scheduled") {
    if (!db || !userId) return;
    const { fields, scans, interventions, weatherLogs, fieldContextStates, existingSnap } = await fetchLimited(db, userId);

    const prev = existingSnap.exists() ? existingSnap.data() : defaultLearningProfile(userId);
    if (prev.schemaVersion && prev.schemaVersion > LEARNING_PROFILE_VERSION) {
        return;
    }

    const lastAgg = prev.lastAggregatedAt ? tsToMs(prev.lastAggregatedAt) : 0;
    const force = reason === "scan_saved" || reason === "intervention_logged" || reason === "manual";
    if (!force && Date.now() - lastAgg < 45000) return;

    const wx = weatherLogs[0] || null;
    const { edges } = buildKnowledgeEdges(scans, wx);

    const fieldStats = updateFieldOutcomeStats(prev.fieldStats || {}, interventions, scans);

    let audit = prev.auditLog || [];
    let timeline = prev.timeline || [];
    const global = { ...defaultLearningProfile(userId).global, ...(prev.global || {}) };

    const div = twinDivergenceFromPending(prev.pendingTwinCheck || null, scans);
    if (div.error != null && Number.isFinite(div.error)) {
        const upd = updateSimErrorEma(global.simErrorEma, global.simSampleCount, div.error);
        global.simErrorEma = upd.simErrorEma;
        global.simSampleCount = upd.simSampleCount;
        audit = appendAudit(audit, {
            field: "global.simErrorEma",
            oldVal: prev.global?.simErrorEma,
            newVal: global.simErrorEma,
            reason: `Twin sketch vs scan on field ${div.fieldId?.slice(0, 6) || "?"}`,
        });
        timeline = appendTimeline(timeline, {
            label: "Simulation check-in",
            value: `${div.error > 0 ? "+" : ""}${div.error.toFixed(1)} pts vs prior sketch`,
            detail: "Estimated — compares newest scan after projection timestamp.",
        });
    }

    /** Aggregate intervention success across scored fields */
    let meanSucc = null;
    let succN = 0;
    for (const st of Object.values(fieldStats)) {
        if (typeof st.interventionSuccessEma === "number" && (st.interventionsScoredTotal || 0) > 0) {
            meanSucc = (meanSucc || 0) + st.interventionSuccessEma;
            succN++;
        }
    }
    if (succN) {
        meanSucc /= succN;
        const targetComfort = 1 + (meanSucc - 0.5) * 0.1;
        global.recommendationComfortScale = clamp(
            emaPair(global.recommendationComfortScale || 1, targetComfort, 0.16),
            0.86,
            1.12,
        );
        let totScored = 0;
        for (const st of Object.values(fieldStats)) totScored += st.interventionsScoredTotal || 0;
        if (meanSucc < 0.42 && totScored > 4) {
            global.fungalTriggerLearned = clamp((global.fungalTriggerLearned || 0) + 0.012, -0.06, 0.06);
            audit = appendAudit(audit, {
                field: "global.fungalTriggerLearned",
                reason: "Inferred intervention success below midline — nudging alert bar slightly upward for evidence.",
            });
        }
    }

    const fungalEdges = edges.filter((e) => e.to === "fungal_risk");
    const humidHint = wx && typeof wx.current?.relative_humidity_2m === "number" && wx.current.relative_humidity_2m >= 75;
    const recurrence = fungalEdges.reduce((a, b) => a + b.count, 0) >= 4;
    if (humidHint && recurrence) {
        global.fungalTriggerLearned = clamp((global.fungalTriggerLearned || 0) - 0.01, -0.06, 0.06);
        global.regionalStressLearnedMul = clamp((global.regionalStressLearnedMul || 1) * 1.02, 0.92, 1.12);
    }

    if (typeof global.simErrorEma === "number" && global.simErrorEma < -3) {
        global.recommendationComfortScale = clamp((global.recommendationComfortScale || 1) - 0.02, 0.86, 1.1);
    }

    const reflections = buildReflectionSnippets({ ...prev, global, fieldStats }, {
        highHumidityWeeks: humidHint,
        fungalRecurrence: recurrence,
    });

    /** New pending twin anchor for next pass */
    let pendingTwinCheck = prev.pendingTwinCheck || null;
    const focus = pickFocusFieldForTwin(fields, scans);
    const bundle = latestWeatherBundle({ weatherLogs });
    if (focus && bundle?.daily?.precipitation_sum) {
        const ctx = fieldContextStates.find((x) => (x.fieldId || x.id) === focus.id);
        const ints = interventions.filter((x) => x.fieldId === focus.id);
        const fScans = scans.filter((s) => s.fieldId === focus.id);
        const twin = buildDigitalTwinState({
            field: focus,
            scans: fScans,
            ctxState: ctx || null,
            interventions: ints,
        });
        const proj = runScenarioProjection(twin, bundle, "baseline", { regionalStress01: 0.14 });
        pendingTwinCheck = {
            fieldId: focus.id,
            predictedEndHealth: proj.summary?.endHealth ?? null,
            capturedAt: Date.now(),
        };
    }

    const patch = {
        schemaVersion: LEARNING_PROFILE_VERSION,
        userId,
        global,
        fieldStats,
        knowledgeEdges: edges,
        timeline,
        auditLog: audit,
        reflections,
        pendingTwinCheck,
        lastAggregatedAt: serverTimestamp(),
        lastReason: reason,
        updatedAt: serverTimestamp(),
    };

    await setDoc(doc(db, "learning_profiles", userId), patch, { merge: true });
}
