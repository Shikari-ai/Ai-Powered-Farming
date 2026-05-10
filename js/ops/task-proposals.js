/**
 * Deterministic operational task proposals — human confirms or dismisses in UI.
 */
import { tsToMs } from "../ai/farmer-context.js";

function hoursBetween(a, b) {
    return Math.abs(a - b) / 3600000;
}

/**
 * @param {object} input
 * @param {any[]} input.scans field-scoped, any order
 * @param {any[]} input.alerts user alerts (optional)
 * @param {any|null} input.ctxState field_context_state doc
 * @param {any|null} input.weatherLog latest
 * @param {string} input.fieldId
 * @param {string} input.fieldName
 */
export function proposeFieldTasks({ scans, alerts, ctxState, weatherLog, fieldId, fieldName }) {
    const proposals = [];
    const now = Date.now();
    const sorted = (scans || []).slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    const latest = sorted[0];
    const hum = weatherLog?.current?.relative_humidity_2m;

    if (latest?.diagnosis?.code === "fungal_risk" && typeof hum === "number" && hum >= 75) {
        proposals.push({
            title: `Scout ${fieldName || "field"} canopy after humid weather`,
            detail:
                "Humidity is elevated — walk lows in the morning for fungal signs. (Inferred risk, not a diagnosis.)",
            priority: "high",
            dueAtMs: now + 18 * 3600000,
            source: "ai",
            triggerRefs: { scanId: latest.id },
        });
    }

    if (latest && tsToMs(latest.createdAt) < now - 5 * 86400000 && (latest.healthScore ?? 100) < 65) {
        proposals.push({
            title: "Re-scan health hotspot within 48h",
            detail: "Last scan is aging while health was moderate/low — fresh imagery/context sharpens guidance.",
            priority: "normal",
            dueAtMs: now + 36 * 3600000,
            source: "ai",
            triggerRefs: { scanId: latest.id },
        });
    }

    const unstable =
        typeof ctxState?.stabilityScore === "number" ? ctxState.stabilityScore < 0.42 : false;
    if (unstable) {
        proposals.push({
            title: "Short inspection pass (field memory unstable)",
            detail: "Context engine flagged instability — quick walk-through to align ground truth.",
            priority: "normal",
            dueAtMs: now + 24 * 3600000,
            source: "ai",
            triggerRefs: {},
        });
    }

    for (const a of alerts || []) {
        if (a.fieldId !== fieldId || a.readAt) continue;
        const sev = String(a.severity || "").toLowerCase();
        if (sev === "high" || sev === "warn") {
            proposals.push({
                title: `Follow up alert: ${a.title || "Field signal"}`,
                detail: (a.body || "").slice(0, 280),
                priority: sev === "high" ? "urgent" : "high",
                dueAtMs: now + 12 * 3600000,
                source: "ai",
                triggerRefs: { alertId: a.id },
            });
        }
    }

    return proposals.map((p) => ({ ...p, fieldId }));
}

/**
 * Cross-field workload: sort fields by composite risk hint.
 */
export function prioritizeFieldsByRisk(fields, scansByFieldId) {
    const scored = (fields || []).map((f) => {
        const list = scansByFieldId[f.id] || [];
        const latest = list.slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))[0];
        let score = 0;
        if (latest) {
            score += Math.max(0, 100 - (latest.healthScore ?? 70)) * 1.2;
            if (latest.severity?.level === "critical") score += 35;
            else if (latest.severity?.level === "moderate") score += 18;
            if (latest.diagnosis?.code === "fungal_risk") score += 12;
            if (latest.diagnosis?.code === "pest_damage") score += 12;
        }
        return { field: f, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored;
}
