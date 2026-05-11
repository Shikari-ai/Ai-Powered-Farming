/**
 * Client-side epistemic / uncertainty copy — deterministic only (no LLM).
 * Keeps the assistant from sounding over-certain when farm evidence is thin.
 */

/** Short system-style phrases for reuse in routers and the main composer. */
export const EPISTEMIC_PHRASES = {
    noFieldsNoScans:
        "No fields or scans are on file yet, so I’m generalizing from patterns—not your rows.",
    noFields: "No fields are saved yet; tie advice to a block when you can.",
    noScans: "No scans are saved yet—a Scanner pass grounds disease and pest context.",
    staleWeather:
        "Weather sync on this device looks dated—refresh the Weather page if you need a live read.",
    weatherError: "Live weather didn’t load; treat moisture and timing hints as tentative.",
    noVisionEvidence:
        "There’s no camera-model result and no solid logged diagnosis for this turn—I won’t name a specific disease from thin air.",
    noDiagnosisOnScan:
        "Your latest saved scan doesn’t lock a diagnosis yet—narrow symptoms or add a labeled scan.",
    missingCrop: "Crop isn’t recorded on your latest scan, so crop-specific advice stays generic.",
    provisionalActionsHeader: "Prioritized actions (provisional—limited on-farm evidence):",
};

/**
 * Disease intent: only defer naming / closing a diagnosis when vision is not usable
 * and the latest scan has no symptoms to scaffold from.
 * @param {any} orch
 */
export function shouldDeferDiagnosis(orch) {
    if (!orch?.intents?.disease) return false;
    if (orch.results?.diseaseVision?.status === "ok") return false;
    const latest = orch.snapshot?.scans?.[0];
    if (latest?.diagnosis?.label && String(latest.diagnosis.label).trim()) return false;
    const syms = latest?.observedSymptoms || latest?.selectedSymptoms || [];
    if (Array.isArray(syms) && syms.length > 0) return false;
    return true;
}

/**
 * @param {any} orch
 * @param {any} [snapshot]
 */
export function shouldFrameActionsProvisional(orch, snapshot) {
    const snap = snapshot || orch?.snapshot;
    const fields = snap?.fields?.length ?? 0;
    const scans = snap?.scans?.length ?? 0;
    const wf = typeof orch?.weatherFresh01 === "number" ? orch.weatherFresh01 : 1;
    const wxErr = !!orch?.results?.weatherIntelligence?.error;
    const staleWx = wf < 0.55 || (orch?.degradedReasons || []).includes("stale_weather");
    return fields === 0 || scans === 0 || wxErr || staleWx || shouldDeferDiagnosis(orch);
}

/** Value for `allowDefiniteDisease` when calling `softenOverclaimProse` from assistant copy. */
export function allowDefiniteDiseaseClaims(orch) {
    const visionOk = orch?.results?.diseaseVision?.status === "ok";
    const label = orch?.snapshot?.scans?.[0]?.diagnosis?.label;
    return visionOk || !!(label && String(label).trim());
}

/**
 * @param {{ fieldCount?: number, scanCount?: number }} ctx
 * @returns {string} Leading clause ending with "—" or "".
 */
export function farmContextEmptyLead(ctx = {}) {
    const fc = typeof ctx.fieldCount === "number" ? ctx.fieldCount : 0;
    const sc = typeof ctx.scanCount === "number" ? ctx.scanCount : 0;
    if (fc > 0 && sc > 0) return "";
    if (fc === 0 && sc === 0) return "I don’t have any saved fields or scans yet—";
    if (fc === 0) return "No saved fields yet—";
    return "No saved scans yet—";
}

/**
 * 0–2 sentences when evidence is thin; empty string when nothing to say.
 * @param {{ snapshot?: any, orch?: any, question?: string, omitFarmOnboarding?: boolean }} args
 */
export function buildUncertaintyPreamble({ snapshot, orch, question, omitFarmOnboarding = false }) {
    const snap = snapshot || orch?.snapshot || {};
    const fields = snap.fields || [];
    const scans = snap.scans || [];
    const orchRef = orch || {};
    const intents = orchRef.intents || {};
    const r = orchRef.results || {};
    const q = String(question || "");

    /** @type {string[]} */
    const parts = [];

    if (!omitFarmOnboarding) {
        if (fields.length === 0 && scans.length === 0) {
            parts.push(EPISTEMIC_PHRASES.noFieldsNoScans);
        } else {
            if (fields.length === 0) parts.push(EPISTEMIC_PHRASES.noFields);
            if (scans.length === 0) parts.push(EPISTEMIC_PHRASES.noScans);
        }
    }

    const wf = typeof orchRef.weatherFresh01 === "number" ? orchRef.weatherFresh01 : null;
    const staleWx = wf != null && wf < 0.55;
    const wxErr = !!r.weatherIntelligence?.error;
    const staleReason = (orchRef.degradedReasons || []).includes("stale_weather");
    if (wxErr) {
        parts.push(EPISTEMIC_PHRASES.weatherError);
    } else if (staleWx || staleReason) {
        parts.push(EPISTEMIC_PHRASES.staleWeather);
    }

    const latest = scans[0];
    const wantsCrop =
        intents.disease ||
        intents.pest ||
        intents.field ||
        /\b(crop|variety|cultivar|field)\b/i.test(q);
    if (latest && !latest.cropType && wantsCrop) {
        parts.push(EPISTEMIC_PHRASES.missingCrop);
    }

    if (shouldDeferDiagnosis(orchRef)) {
        parts.push(EPISTEMIC_PHRASES.noVisionEvidence);
    } else if (scans.length > 0 && intents.disease && latest && !latest.diagnosis?.label) {
        const syms = latest.observedSymptoms || latest.selectedSymptoms || [];
        if (!Array.isArray(syms) || syms.length === 0) {
            parts.push(EPISTEMIC_PHRASES.noDiagnosisOnScan);
        }
    }

    const seen = new Set();
    const uniq = [];
    for (const p of parts) {
        const t = String(p).trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        uniq.push(t);
    }
    return uniq.slice(0, 2).join(" ").trim();
}
