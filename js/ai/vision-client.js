/**
 * Multimodal disease / stress vision bridge → FastAPI service.
 * Returns only server-backed labels; never invents confidences client-side.
 */

export async function analyzeCropImage(blob, { baseUrl, fetchOpts = {} }) {
    const url = String(baseUrl || "").replace(/\/$/, "");
    if (!url) {
        return { engine: "disease_vision", status: "unconfigured", message: "No inference base URL." };
    }
    if (!(blob instanceof Blob)) {
        throw new Error("Invalid image blob");
    }

    const fd = new FormData();
    fd.append("file", blob, "crop.jpg");

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 45000);

    try {
        const res = await fetch(`${url}/v1/vision/disease`, {
            method: "POST",
            body: fd,
            signal: controller.signal,
            ...fetchOpts,
        });

        if (res.status === 501 || res.status === 503) {
            const msg = await res.text();
            return {
                engine: "disease_vision",
                status: "model_unavailable",
                httpStatus: res.status,
                message: msg.slice(0, 400) || "Model not loaded on server.",
            };
        }

        if (!res.ok) {
            const msg = await res.text();
            throw new Error(msg.slice(0, 200) || `HTTP ${res.status}`);
        }

        const data = await res.json();
        return {
            engine: "disease_vision",
            status: "ok",
            modelVersion: data.model_version || data.modelVersion || null,
            topHypothesis: data.top_hypothesis || data.topHypothesis || null,
            confidence: typeof data.confidence === "number" ? data.confidence : null,
            explanation: data.explanation || "",
            treatments: Array.isArray(data.treatments) ? data.treatments : [],
            maskUrl: data.mask_url || null,
        };
    } finally {
        clearTimeout(t);
    }
}
