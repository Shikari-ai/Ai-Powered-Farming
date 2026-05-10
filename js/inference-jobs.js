import { addDoc, collection, doc, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { postDiseaseVision } from "./ai/vision-client.js?v=33";
import { getAiConfig } from "./ai/config.js?v=33";

/**
 * Client-orchestrated job row + server inference (no Firebase Admin required).
 */
export async function runVisionJob(db, userId, blob, meta = {}) {
    const cfg = getAiConfig();
    if (!cfg.inferenceBaseUrl) {
        return { skipped: true, reason: "no_inference_url" };
    }

    const jobRef = await addDoc(collection(db, "ai_inference_jobs"), {
        userId,
        status: "processing",
        source: meta.source || "scanner",
        fieldId: meta.fieldId || null,
        createdAt: serverTimestamp(),
        schemaVersion: 1,
    });

    try {
        const result = await postDiseaseVision(blob, {
            baseUrl: cfg.inferenceBaseUrl,
            confThreshold: meta.confThreshold ?? 0.65,
            includeContext: true,
        });

        const rawCompact =
            result.ok && result.raw
                ? {
                      detections: (result.raw.detections || []).slice(0, 24),
                      top_hypothesis: result.raw.top_hypothesis,
                      confidence: result.raw.confidence,
                      inference_ms: result.raw.inference_ms,
                      severity: result.raw.severity,
                      explanation: result.raw.explanation ? String(result.raw.explanation).slice(0, 4000) : null,
                      environmental_reasoning: result.raw.environmental_reasoning || [],
                  }
                : null;

        const patch = {
            status: result.ok ? "completed" : "failed",
            finishedAt: serverTimestamp(),
            vision: result.ok ? { ok: true, raw: rawCompact } : { ok: false, message: result.message, httpStatus: result.httpStatus },
        };
        await updateDoc(doc(db, "ai_inference_jobs", jobRef.id), patch);
        return { jobId: jobRef.id, ...result };
    } catch (e) {
        await updateDoc(doc(db, "ai_inference_jobs", jobRef.id), {
            status: "failed",
            error: String(e.message || e),
            finishedAt: serverTimestamp(),
        });
        throw e;
    }
}
