/**
 * Multimodal disease / stress vision → FastAPI (`/v1/vision/disease`).
 * Parses real model payloads only; never invents detections client-side.
 */

import { buildVisionContextBundle } from "./vision-context.js?v=34";
import { recordInferenceOutcome } from "./system-health.js";

function baseUrlClean(baseUrl) {
    return String(baseUrl || "").replace(/\/$/, "");
}

/**
 * Full API response + normalized convenience fields.
 */
export async function postDiseaseVision(blob, options = {}) {
    const url = baseUrlClean(options.baseUrl);
    if (!url) {
        return {
            ok: false,
            status: "unconfigured",
            message: "No inference base URL.",
        };
    }
    if (!(blob instanceof Blob)) {
        throw new Error("Invalid image blob");
    }

    const fd = new FormData();
    fd.append("file", blob, options.filename || "crop.jpg");
    if (options.confThreshold != null) fd.append("conf_threshold", String(options.confThreshold));
    if (options.iouThreshold != null) fd.append("iou_threshold", String(options.iouThreshold));

    let ctx = options.context || null;
    if (options.contextOverride != null) {
        ctx = options.contextOverride;
    } else if (options.includeContext !== false && !ctx) {
        ctx = await buildVisionContextBundle();
    }
    if (ctx) fd.append("context_json", JSON.stringify(ctx));
    if (options.trackingId != null && String(options.trackingId).trim()) {
        fd.append("tracking_id", String(options.trackingId).trim());
    }

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), options.timeoutMs || 55000);
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

    try {
        const res = await fetch(`${url}/v1/vision/disease`, {
            method: "POST",
            body: fd,
            signal: controller.signal,
            ...options.fetchOpts,
        });

        if (res.status === 503 || res.status === 501) {
            const msg = await res.text();
            recordInferenceOutcome({ ok: false, error: "model_unavailable" });
            return {
                ok: false,
                status: "model_unavailable",
                httpStatus: res.status,
                message: msg.slice(0, 800) || "Model not loaded on server.",
            };
        }

        if (!res.ok) {
            const msg = await res.text();
            recordInferenceOutcome({ ok: false, error: `http_${res.status}` });
            throw new Error(msg.slice(0, 400) || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const dets = Array.isArray(data.detections) ? data.detections : [];
        recordInferenceOutcome({
            ok: true,
            ms: (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0,
        });

        return {
            ok: true,
            status: "ok",
            raw: data,
            modelVersion: data.model_version || data.modelVersion || null,
            topHypothesis: data.top_hypothesis || data.topHypothesis || null,
            confidence: typeof data.confidence === "number" ? data.confidence : null,
            detections: dets,
            explanation: data.explanation || "",
            environmentalReasoning: Array.isArray(data.environmental_reasoning) ? data.environmental_reasoning : [],
            treatments: Array.isArray(data.treatments) ? data.treatments : [],
            severity: data.severity || null,
            imageQuality: data.image_quality || null,
            inferenceMs: data.inference_ms ?? null,
            contextualIntel: data.contextual_intel || data.contextualIntel || null,
            predictionReliability: data.prediction_reliability || data.predictionReliability || null,
        };
    } catch (e) {
        recordInferenceOutcome({ ok: false, error: e?.message || "fetch_failed" });
        throw e;
    } finally {
        clearTimeout(t);
    }
}

/** Legacy shape for orchestrator / assistant */
export async function analyzeCropImage(blob, opts = {}) {
    const r = await postDiseaseVision(blob, opts);
    if (!r.ok) {
        return {
            engine: "disease_vision",
            status: r.status === "unconfigured" ? "unconfigured" : "model_unavailable",
            httpStatus: r.httpStatus,
            message: r.message,
        };
    }
    return {
        engine: "disease_vision",
        status: "ok",
        modelVersion: r.modelVersion,
        topHypothesis: r.topHypothesis,
        confidence: r.confidence,
        explanation: r.explanation,
        treatments: r.treatments,
        maskUrl: r.raw?.mask_url || null,
        detections: r.detections,
        severity: r.severity,
        imageQuality: r.imageQuality,
        environmentalReasoning: r.environmentalReasoning,
        contextualIntel: r.contextualIntel,
        predictionReliability: r.predictionReliability,
        raw: r.raw,
    };
}
