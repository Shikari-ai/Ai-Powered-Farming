/**
 * AI reliability & epistemic labeling — calibration, gating, evidence bundles.
 * Keep cadence deterministic; no random noise.
 */

export const EPISTEMIC = {
    OBSERVED: "observed",
    INFERRED: "inferred",
    PREDICTED: "predicted",
};

export function clamp01(x) {
    const n = Number(x);
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/**
 * Raw model or heuristic score → conservative calibrated score.
 * @param {number|null} raw 0–1 or null
 * @param {{ evidenceStrength?: number, freshness01?: number, penaltyStack?: string[] }} ctx
 */
export function calibrateConfidence(raw, ctx = {}) {
    const base =
        typeof raw === "number" && !Number.isNaN(raw) ? clamp01(raw) : 0.42;
    const ev =
        ctx.evidenceStrength != null ? clamp01(ctx.evidenceStrength) : 0.55;
    const fresh = ctx.freshness01 != null ? clamp01(ctx.freshness01) : 0.75;
    let out = base * 0.52 + ev * 0.26 + fresh * 0.22;
    const penalties = ctx.penaltyStack || [];
    if (penalties.includes("low_light")) out -= 0.14;
    if (penalties.includes("no_lab")) out -= 0.07;
    if (penalties.includes("rules_only")) out -= 0.06;
    if (penalties.includes("sparse_history")) out -= 0.08;
    if (penalties.includes("stale_weather")) out -= 0.1;
    if (penalties.includes("fused_model")) out -= 0.04;
    if (penalties.includes("no_image")) out -= 0.05;
    out = clamp01(out);
    return Math.round(out * 1000) / 1000;
}

/** User-facing short label */
export function confidenceLabel(calibrated) {
    const c = clamp01(calibrated);
    if (c >= 0.72) return "High confidence";
    if (c >= 0.48) return "Moderate confidence";
    return "Limited confidence — verify in the field";
}

/** Longer UI string with optional caveats */
export function confidenceDetail(calibrated, factors = []) {
    const extra = (factors || []).filter(Boolean).slice(0, 3).join(" ");
    return extra ? `${confidenceLabel(calibrated)}. ${extra}` : confidenceLabel(calibrated);
}

/**
 * Downgrade alert severity when evidence is weak (failsafe).
 */
export function gateAlertSeverity(severity, calibrated) {
    const s = String(severity || "warn").toLowerCase();
    const c = clamp01(calibrated);
    if (c < 0.38 && s === "high") return "warn";
    if (c < 0.32 && s === "warn") return "info";
    return s;
}

/**
 * Reliability block for rule-based symptom scans + saved recommendations.
 */
export function buildSymptomScanReliability(computed, imageMeta) {
    const symptomN = computed.selectedSymptoms?.length || 0;
    const hasImg = !!imageMeta;
    const evidenceStrength = Math.min(
        1,
        0.32 + symptomN * 0.11 + (hasImg ? 0.12 : 0),
    );
    const raw = 0.52 + Math.min(0.22, symptomN * 0.035);
    const penalties = ["rules_only", "no_lab"];
    if (!hasImg) penalties.push("no_image");
    if (symptomN < 2) penalties.push("sparse_history");
    const calibrated = calibrateConfidence(raw, {
        evidenceStrength,
        freshness01: 1,
        penaltyStack: penalties,
    });
    const factors = [
        symptomN < 2 ? "Few symptoms logged — interpretation stays broad." : null,
        "Heuristic rules, not a lab diagnosis.",
        hasImg ? null : "No reference image attached to this save.",
    ].filter(Boolean);

    return {
        schemaVersion: 1,
        primaryEpistemic: EPISTEMIC.INFERRED,
        observed: (computed.selectedSymptoms || []).map((id) => `symptom:${id}`),
        inferred: [`diagnosis:${computed.diagnosis?.code || "unknown"}`],
        predicted: [],
        rawConfidence: raw,
        calibratedConfidence: calibrated,
        confidenceLabel: confidenceLabel(calibrated),
        confidenceDetail: confidenceDetail(calibrated, factors),
        contributingSignals: [
            `health_score:${computed.healthScore}`,
            `severity:${computed.severity?.level || "n/a"}`,
        ],
        evidenceBundle: {
            symptomCount: symptomN,
            healthScore: computed.healthScore,
            hasUploadedImage: hasImg,
            analysisVersion: "rules-v1",
            diagnosisCode: computed.diagnosis?.code || null,
            severityLevel: computed.severity?.level || null,
        },
        reasoningSummary:
            "Recommendations derive from your selected symptoms and internal rule engine; confirm in the field before major treatment spends.",
    };
}

export function buildGeoAlertReliability({ stressMean, ndviProxy }) {
    const raw =
        typeof stressMean === "number" ? clamp01(stressMean) : 0.45;
    const calibrated = calibrateConfidence(raw, {
        evidenceStrength: 0.52,
        freshness01: 0.82,
        penaltyStack: ["fused_model"],
    });
    return {
        schemaVersion: 1,
        primaryEpistemic: EPISTEMIC.INFERRED,
        observed:
            typeof ndviProxy === "number"
                ? [`vigor_proxy:${Math.round(ndviProxy * 100)}%`]
                : [],
        inferred: [
            typeof stressMean === "number"
                ? `stress_mesh:${Math.round(stressMean * 100)}%`
                : "stress_mesh:n/a",
        ],
        predicted: [],
        rawConfidence: raw,
        calibratedConfidence: calibrated,
        confidenceLabel: confidenceLabel(calibrated),
        confidenceDetail:
            "Inferred from fused polygon + scan + weather signals — not a government survey map.",
        evidenceBundle: {
            stressMean: stressMean ?? null,
            ndviProxy: ndviProxy ?? null,
            pipeline: "geo_intel_pipeline",
        },
        reasoningSummary:
            "Pattern is a screening hint; ground-truth still requires scouting or imagery you trust.",
    };
}

/**
 * Vision API output: conservative calibration from server confidence + quality hints.
 */
export function buildVisionReliability(visionIntel) {
    if (!visionIntel || visionIntel.status !== "ok") {
        return {
            schemaVersion: 1,
            primaryEpistemic: EPISTEMIC.INFERRED,
            observed: [],
            inferred: [],
            predicted: [],
            rawConfidence: null,
            calibratedConfidence: 0.35,
            confidenceLabel: confidenceLabel(0.35),
            confidenceDetail:
                "Vision model unavailable or returned no usable confidence — treat any text as preliminary.",
            evidenceBundle: { source: "disease_vision", status: visionIntel?.status || "none" },
            reasoningSummary: visionIntel?.message || "No vision inference.",
        };
    }
    const iq = visionIntel.imageQuality;
    const penalties = [];
    const iqStr = iq != null ? String(iq).toLowerCase() : "";
    if (iqStr.includes("low") || iqStr.includes("dark") || iqStr.includes("blur")) {
        penalties.push("low_light");
    }
    const detN = Array.isArray(visionIntel.detections)
        ? visionIntel.detections.length
        : 0;
    const evidenceStrength = Math.min(1, 0.4 + detN * 0.08);
    const raw =
        typeof visionIntel.confidence === "number"
            ? clamp01(visionIntel.confidence)
            : 0.5;
    const calibrated = calibrateConfidence(raw, {
        evidenceStrength,
        freshness01: 1,
        penaltyStack: penalties,
    });

    return {
        schemaVersion: 1,
        primaryEpistemic: EPISTEMIC.INFERRED,
        observed: detN ? [`detections_count:${detN}`] : [],
        inferred: visionIntel.topHypothesis
            ? [`hypothesis:${visionIntel.topHypothesis}`]
            : [],
        predicted: [],
        rawConfidence: raw,
        calibratedConfidence: calibrated,
        confidenceLabel: confidenceLabel(calibrated),
        confidenceDetail: confidenceDetail(calibrated, [
            penalties.includes("low_light")
                ? "Image quality may limit reliability."
                : null,
        ]),
        evidenceBundle: {
            source: "disease_vision",
            modelVersion: visionIntel.modelVersion || null,
            detectionCount: detN,
            imageQuality: iq ?? null,
        },
        reasoningSummary:
            "Labels come from a server vision model; always pair with scouting and local expertise.",
    };
}

/**
 * Engine-merged recommendation row calibration.
 */
export function calibrateEngineAction(action, ctx) {
    const raw =
        typeof action.confidence === "number" ? action.confidence : 0.55;
    const calibrated = calibrateConfidence(raw, {
        evidenceStrength: ctx.scanCount >= 3 ? 0.72 : 0.48,
        freshness01: ctx.weatherFresh01 ?? 0.7,
        penaltyStack: ctx.scanCount < 2 ? ["sparse_history"] : [],
    });
    const ep =
        action.primaryEpistemic ||
        (action.priority === "follow_up" ? EPISTEMIC.INFERRED : EPISTEMIC.PREDICTED);
    return {
        ...action,
        rawConfidence: raw,
        calibratedConfidence: calibrated,
        confidenceLabel: confidenceLabel(calibrated),
        primaryEpistemic: ep,
    };
}

/**
 * Strip overclaim / panic phrasing for assistant copy (lightweight guard).
 * @param {string} text
 * @param {{ allowDefiniteDisease?: boolean }} [opts] When `allowDefiniteDisease` is false, softens definitive disease naming.
 */
export function softenOverclaimProse(text, opts) {
    if (!text) return text;
    let s = String(text)
        .replace(/\b\d{3}%\s*certain\b/gi, "uncertain without field verification")
        .replace(/\bguaranteed\b/gi, "not guaranteed")
        .replace(/\bimminent destruction\b/gi, "a situation to verify soon")
        .replace(/\bcrop destruction imminent\b/gi, "elevated risk — verify in person")
        .replace(/\bwill definitely\b/gi, "may")
        .replace(/\bdefinitely\b/gi, "likely")
        .replace(/\bdefinitively\b/gi, "likely");

    if (opts && opts.allowDefiniteDisease === false) {
        s = s.replace(
            /\b(this is|it is|that is|that's)\s+(the\s+|a\s+)?([A-Za-z][A-Za-z\s-]{2,45})\s+disease\b/gi,
            (_m, _p, art, name) => `could be ${art || ""}${name} disease`.replace(/\s+/g, " "),
        );
    }

    return s;
}
