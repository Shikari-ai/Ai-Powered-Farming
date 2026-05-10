/**
 * Multimodal disease / stress vision → FastAPI (`/v1/vision/disease`).
 * Parses real model payloads only; never invents detections client-side.
 */

import { buildVisionContextBundle } from "./vision-context.js?v=33";

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
    if (options.includeContext !== false && !ctx) {
        ctx = await buildVisionContextBundle();
    }
    if (ctx) fd.append("context_json", JSON.stringify(ctx));

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), options.timeoutMs || 55000);

    try {
        const res = await fetch(`${url}/v1/vision/disease`, {
            method: "POST",
            body: fd,
            signal: controller.signal,
            ...options.fetchOpts,
        });

        if (res.status === 503 || res.status === 501) {
            const msg = await res.text();
            return {
                ok: false,
                status: "model_unavailable",
                httpStatus: res.status,
                message: msg.slice(0, 800) || "Model not loaded on server.",
            };
        }

        if (!res.ok) {
            const msg = await res.text();
            throw new Error(msg.slice(0, 400) || `HTTP ${res.status}`);
        }

        const data = await res.json();
        const dets = Array.isArray(data.detections) ? data.detections : [];

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
        };
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
        raw: r.raw,
    };
}
