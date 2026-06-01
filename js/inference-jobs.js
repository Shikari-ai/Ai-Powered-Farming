import { addDoc, collection, doc, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { postDiseaseVision } from "./ai/vision-client.js?v=34";
import { getAiConfig } from "./ai/config.js?v=71";
import { buildRichVisionContextBundle } from "./ai/vision-context.js?v=34";
import { mergeVisionInferenceIntoFieldMemory } from "./ai/field-context.js?v=34";

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
        const rich =
            meta.contextBundle ||
            (await buildRichVisionContextBundle({
                fieldContextStates: meta.fieldContextStates || [],
                scans: meta.scans || [],
                fields: meta.fields || [],
                climateProfile: meta.climateProfile || null,
            }));
        if (meta.cropSlug) {
            rich.crop_slug = String(meta.cropSlug)
                .trim()
                .toLowerCase()
                .replace(/\s+/g, "_");
        }
        if (meta.growthStageSlug) {
            rich.growth_stage = String(meta.growthStageSlug).trim().toLowerCase().replace(/\s+/g, "_");
        }

        const result = await postDiseaseVision(blob, {
            baseUrl: cfg.inferenceBaseUrl,
            confThreshold: meta.confThreshold ?? 0.65,
            includeContext: true,
            contextOverride: rich,
            trackingId: meta.trackingId,
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
                      contextual_intel: result.raw.contextual_intel
                          ? {
                                risk_tier: result.raw.contextual_intel.risk_tier,
                                risk_score_0_100: result.raw.contextual_intel.risk_score_0_100,
                                suppressions_applied: (result.raw.contextual_intel.suppressions_applied || []).slice(0, 8),
                            }
                          : null,
                  }
                : null;

        const patch = {
            status: result.ok ? "completed" : "failed",
            finishedAt: serverTimestamp(),
            vision: result.ok ? { ok: true, raw: rawCompact } : { ok: false, message: result.message, httpStatus: result.httpStatus },
        };
        await updateDoc(doc(db, "ai_inference_jobs", jobRef.id), patch);

        if (result.ok && meta.fieldId && userId) {
            try {
                const dets = result.detections || [];
                let maxModel = null;
                for (const d of dets) {
                    const mc = typeof d.model_confidence === "number" ? d.model_confidence : null;
                    const c = typeof d.confidence === "number" ? d.confidence : null;
                    const v = mc != null ? mc : c;
                    if (v != null) maxModel = maxModel == null ? v : Math.max(maxModel, v);
                }
                await mergeVisionInferenceIntoFieldMemory(db, userId, meta.fieldId, {
                    topHypothesis: result.topHypothesis,
                    detections: dets,
                    cropSlug: meta.cropSlug || null,
                    growthStageSlug: meta.growthStageSlug || null,
                    topConfidence: result.confidence != null ? Number(result.confidence) : null,
                    maxModelConfidence: maxModel,
                });
            } catch (e) {
                console.warn("field memory merge skipped:", e);
            }
        }
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
