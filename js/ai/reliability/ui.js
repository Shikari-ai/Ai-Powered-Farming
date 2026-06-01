/**
 * Small HTML fragments for epistemic + confidence UI (escape externally controlled text).
 */
import { EPISTEMIC } from "./core.js";

const EPI_STYLE = {
    [EPISTEMIC.OBSERVED]: {
        cls: "epi-obs",
        short: "Observed",
        hint: "Direct input or measurement you (or sensors) provided",
    },
    [EPISTEMIC.INFERRED]: {
        cls: "epi-inf",
        short: "Inferred",
        hint: "Heuristic or model fusion — not a direct observation",
    },
    [EPISTEMIC.PREDICTED]: {
        cls: "epi-pred",
        short: "Predicted",
        hint: "Forward-looking estimate — conditions can change",
    },
};

export function epistemicBadgeHTML(kind) {
    const k = EPI_STYLE[kind] || EPI_STYLE[EPISTEMIC.INFERRED];
    const safeHint = String(k.hint).replace(/"/g, "&quot;");
    return `<span class="epi-badge ${k.cls}" title="${safeHint}">${k.short}</span>`;
}

export function confidencePillHTML(label, calibrated) {
    const pct =
        typeof calibrated === "number"
            ? `${Math.round(Math.max(0, Math.min(1, calibrated)) * 100)}%`
            : "—";
    const safeL = String(label || "").replace(/</g, "&lt;");
    return `<span class="conf-pill" title="Calibrated reliability index">${safeL} · ${pct}</span>`;
}

export function reliabilityRowHTML(rel) {
    if (!rel || !rel.schemaVersion) return "";
    const kind = rel.primaryEpistemic || EPISTEMIC.INFERRED;
    const badge = epistemicBadgeHTML(kind);
    const pill = confidencePillHTML(rel.confidenceLabel, rel.calibratedConfidence);
    const sum = rel.reasoningSummary
        ? `<div class="rel-sum">${String(rel.reasoningSummary).replace(/</g, "&lt;")}</div>`
        : "";
    return `<div class="rel-row">${badge}${pill}${sum}</div>`;
}
