import "./auth-session.js?v=33";
import './i18n.js';
import { auth, db, storage } from './auth.js?v=32';
import { cropHealthDocId } from "./services/entity-sync.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    doc,
    query,
    where,
    orderBy,
    limit,
    onSnapshot,
    serverTimestamp,
    writeBatch,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    ref,
    uploadBytesResumable,
    getDownloadURL,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { getAiConfig } from "./ai/config.js?v=71";
import { startLiveDiseaseScan } from "./scanner-live-vision.js?v=35";
import { runVisionJob } from "./inference-jobs.js?v=34";
import { mergeSymptomScanIntoFieldMemory } from "./ai/field-context.js?v=34";
import {
    buildSymptomScanReliability,
    gateAlertSeverity,
    calibrateConfidence,
    confidenceLabel,
    EPISTEMIC,
} from "./ai/reliability/core.js";
import { queueLearningFlush } from "./learning/scheduler.js";
import { decorateNotificationForAmbient } from "./ambient/notification-decorator.js";
import { enqueueSensoryCue } from "./ambient/sensory-hooks.js";
import { runAiVisionScan } from "./ai/vision-scan.js?v=3";
import { startLiveGeminiScan } from "./ai/live-vision-gemini.js?v=3";

const SYMPTOMS = [
    { id: "leaf_spots", label: "Leaf spots", weight: 14, tags: ["fungal", "bacterial"] },
    { id: "yellowing", label: "Yellowing", weight: 10, tags: ["nutrient", "water"] },
    { id: "wilting", label: "Wilting", weight: 14, tags: ["water", "root"] },
    { id: "mold", label: "Mold / mildew", weight: 18, tags: ["fungal"] },
    { id: "holes", label: "Holes / chewing", weight: 16, tags: ["pest"] },
    { id: "curling", label: "Leaf curling", weight: 12, tags: ["pest", "water"] },
    { id: "stunted", label: "Stunted growth", weight: 14, tags: ["nutrient", "root"] },
    { id: "discoloration", label: "Discoloration", weight: 10, tags: ["nutrient", "stress"] },
];

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function computeHealthScore(selectedSymptomIds) {
    let score = 100;
    for (const sId of selectedSymptomIds) {
        const s = SYMPTOMS.find(x => x.id === sId);
        if (s) score -= s.weight;
    }
    return clamp(Math.round(score), 0, 100);
}

function computeDiagnosis(selectedSymptomIds) {
    const tags = new Set();
    for (const sId of selectedSymptomIds) {
        const s = SYMPTOMS.find(x => x.id === sId);
        if (!s) continue;
        for (const t of s.tags) tags.add(t);
    }

    if (selectedSymptomIds.length === 0) {
        return { code: "no_symptoms", label: "No symptoms reported", category: "healthy" };
    }
    if (tags.has("fungal")) return { code: "fungal_risk", label: "Fungal risk signals", category: "risk" };
    if (tags.has("pest")) return { code: "pest_damage", label: "Possible pest damage", category: "risk" };
    if (tags.has("nutrient")) return { code: "nutrient_stress", label: "Possible nutrient stress", category: "risk" };
    if (tags.has("water")) return { code: "water_stress", label: "Possible water stress", category: "risk" };
    return { code: "needs_review", label: "Needs further review", category: "unknown" };
}

function computeSeverity(healthScore) {
    if (healthScore >= 80) return { level: "good", label: "Good" };
    if (healthScore >= 50) return { level: "warning", label: "Needs attention" };
    return { level: "critical", label: "Critical" };
}

function buildRecommendations({ diagnosis, selectedSymptomIds }) {
    const recs = [];
    const has = (id) => selectedSymptomIds.includes(id);

    if (diagnosis.code === "no_symptoms") {
        recs.push({ type: "info", text: "Log a scan with symptoms anytime you notice changes." });
        recs.push({ type: "info", text: "Add fields to unlock per-field monitoring and trends." });
        return recs;
    }

    if (diagnosis.code === "fungal_risk") {
        recs.push({ type: "action", text: "Inspect underside of leaves and remove heavily affected foliage." });
        recs.push({ type: "action", text: "Avoid overhead watering; improve airflow around plants." });
        if (has("mold")) recs.push({ type: "warning", text: "If mildew spreads quickly, consult a local agronomist for targeted treatment." });
    }

    if (diagnosis.code === "pest_damage") {
        recs.push({ type: "action", text: "Check leaves early morning for larvae/eggs; document findings." });
        recs.push({ type: "action", text: "Consider pheromone/sticky traps and targeted scouting before spraying." });
    }

    if (diagnosis.code === "nutrient_stress") {
        recs.push({ type: "action", text: "Review recent fertilization; consider soil test before adjusting inputs." });
        recs.push({ type: "info", text: "Track symptom spread across fields to confirm nutrient vs pest causes." });
    }

    if (diagnosis.code === "water_stress") {
        recs.push({ type: "action", text: "Check irrigation schedule and soil moisture at root depth." });
        if (has("wilting")) recs.push({ type: "warning", text: "If wilting persists after irrigation, check for root issues." });
    }

    if (recs.length === 0) {
        recs.push({ type: "info", text: "Add more observations to generate actionable recommendations." });
    }
    return recs;
}

function qs(id) {
    return document.getElementById(id);
}

function setHidden(el, isHidden) {
    if (!el) return;
    el.classList.toggle("hidden", isHidden);
}

function renderSymptoms(container, onChange) {
    container.innerHTML = "";
    for (const s of SYMPTOMS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.symptom = s.id;
        btn.textContent = s.label;
        btn.style.padding = "10px 12px";
        btn.style.borderRadius = "999px";
        btn.style.border = "1px solid rgba(255,255,255,0.10)";
        btn.style.background = "rgba(0,0,0,0.22)";
        btn.style.color = "rgba(255,255,255,0.92)";
        btn.style.fontSize = "12px";
        btn.style.cursor = "pointer";
        btn.addEventListener("click", () => {
            btn.classList.toggle("active");
            btn.style.borderColor = btn.classList.contains("active") ? "rgba(16,185,129,0.8)" : "rgba(255,255,255,0.10)";
            btn.style.background = btn.classList.contains("active") ? "rgba(16,185,129,0.12)" : "rgba(0,0,0,0.22)";
            onChange();
        });
        container.appendChild(btn);
    }
}

function getSelectedSymptoms(container) {
    return Array.from(container.querySelectorAll("button.active")).map(b => b.dataset.symptom);
}

function renderResult({ healthScore, diagnosis, severity, recommendations }) {
    const titleEl = qs("result-title");
    const healthEl = qs("result-health");
    if (titleEl) titleEl.textContent = diagnosis.label;
    if (healthEl) healthEl.textContent = `${healthScore}%`;

    const list = document.querySelector("#result-state .rec-list");
    if (!list) return;
    list.innerHTML = "";
    for (const r of recommendations) {
        const li = document.createElement("li");
        const icon = document.createElement("i");
        icon.className = r.type === "warning" ? "ri-error-warning-line" : "ri-check-line";
        icon.style.color = r.type === "warning" ? "var(--accent-orange)" : "var(--accent-green)";
        li.appendChild(icon);
        const text = document.createElement("span");
        text.textContent = r.text;
        li.appendChild(text);
        list.appendChild(li);
    }

    const badge = document.querySelector("#result-state .result-badge");
    if (badge) {
        badge.classList.toggle("danger", severity.level !== "good");
    }
}

async function captureFromVideo(videoEl) {
    if (!videoEl || videoEl.readyState < 2) throw new Error("Camera not ready");
    const canvas = document.createElement("canvas");
    canvas.width = videoEl.videoWidth || 1280;
    canvas.height = videoEl.videoHeight || 720;
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const tier = window.__agriCamera && typeof window.__agriCamera.getTier === "function" ? window.__agriCamera.getTier() : "high";
    const q = tier === "low" ? 0.88 : 0.96;
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (!b) reject(new Error("Could not capture image"));
            else resolve(b);
        }, "image/jpeg", q);
    });
    return blob;
}

async function uploadScanImage({ userId, scanId, blob, onProgress }) {
    const storagePath = `crop_scans/${userId}/${scanId}.jpg`;
    const storageRef = ref(storage, storagePath);
    const task = uploadBytesResumable(storageRef, blob, { contentType: blob.type || "image/jpeg" });
    await new Promise((resolve, reject) => {
        task.on("state_changed",
            (snap) => {
                if (onProgress && snap.totalBytes) {
                    const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
                    onProgress(pct);
                }
            },
            (err) => reject(err),
            () => resolve()
        );
    });
    const downloadURL = await getDownloadURL(task.snapshot.ref);
    return { storagePath, downloadURL };
}

function setBtnLoading(btn, isLoading, text) {
    if (!btn) return;
    btn.disabled = isLoading;
    btn.innerHTML = isLoading
        ? `<i class="ri-loader-4-line spin" style="margin-right:8px;"></i>${text || "Working..."}`
        : text || btn.dataset.originalText || btn.textContent;
}

document.addEventListener("DOMContentLoaded", () => {
    const readyState = qs("ready-state");
    const analyzeState = qs("analyze-state");
    const resultState = qs("result-state");
    const preview = qs("scan-preview");
    const cropSel = qs("scan-crop");
    const fieldSel = qs("scan-field");
    const captureBtn = qs("capture-btn");
    const uploadInput = qs("upload-input");
    const analyzeBtn = qs("analyze-btn");
    const retakeBtn = qs("retake-btn");
    const saveBtn = qs("save-scan-btn");
    const backBtn = qs("back-to-edit-btn");
    const symptomsWrap = qs("symptoms");
    const symptomCount = qs("symptom-count");

    if (captureBtn) captureBtn.dataset.originalText = captureBtn.innerHTML;
    if (analyzeBtn) analyzeBtn.dataset.originalText = analyzeBtn.innerHTML;
    if (saveBtn) saveBtn.dataset.originalText = saveBtn.innerHTML;

    let currentUserId = null;
    let currentBlob = null;
    let currentPreviewUrl = null;
    let computed = null;
    let liveHandle = null;
    /** @type {any[]} */
    let fieldsListLast = [];
    /** @type {any[]} */
    let fieldContextStatesLast = [];

    const visionPanel = qs("vision-result-panel");
    const visionText = qs("vision-result-text");
    const liveToggle = qs("live-vision-toggle");
    const visionCanvas = qs("vision-overlay");
    const hdrSub = qs("sc-hdr-sub");
    let statusResetTimer = null;
    let camSwitching = false;
    let hasManyCamsCache = null;

    const showScannerStatus = (msg, warn = false, ms = 2400) => {
        if (!hdrSub) return;
        if (statusResetTimer) clearTimeout(statusResetTimer);
        hdrSub.textContent = msg;
        hdrSub.style.color = warn ? "var(--sc-amber)" : "var(--sc-dim)";
        statusResetTimer = setTimeout(() => {
            hdrSub.textContent = "Point camera at your crop";
            hdrSub.style.color = "";
        }, ms);
    };

    const resetVisionPanel = () => {
        if (visionPanel) visionPanel.classList.add("hidden");
        if (visionText) visionText.textContent = "";
    };

    const showVisionLoading = () => {
        if (!visionPanel || !visionText) return;
        visionPanel.classList.remove("hidden");
        visionText.textContent = "Running server vision model…";
    };

    const showVisionJobResult = (r) => {
        if (!visionPanel || !visionText) return;
        visionPanel.classList.remove("hidden");
        if (!r || r.skipped) {
            visionText.textContent =
                "Vision API not configured. Add <meta name=\"agri-inference-url\" content=\"https://your-api\"> or window.__AGRI_INFERENCE_URL__.";
            return;
        }
        if (r.ok) {
            const dets = r.detections || [];
            const lines = [];
            if (r.topHypothesis) {
                lines.push(`${r.topHypothesis} — ${Math.round((r.confidence || 0) * 100)}% confidence (server)`);
            }
            if (dets.length) lines.push(`Regions: ${dets.length}`);
            for (const d of dets.slice(0, 5)) {
                lines.push(`• ${d.label} (${Math.round((d.confidence || 0) * 100)}%)`);
            }
            if (r.contextualIntel?.risk_tier) {
                lines.push(
                    `Field intelligence risk: ${r.contextualIntel.risk_tier}` +
                        (r.contextualIntel.risk_score_0_100 != null
                            ? ` (score ${r.contextualIntel.risk_score_0_100})`
                            : ""),
                );
            }
            if (r.explanation) lines.push(r.explanation);
            if (r.environmentalReasoning && r.environmentalReasoning.length) {
                lines.push(`Context: ${r.environmentalReasoning.join(" ")}`);
            }
            visionText.textContent = lines.join("\n");
        } else {
            visionText.textContent = r.message || "Vision model unavailable.";
        }
    };

    const startBackgroundVision = (blob) => {
        if (!currentUserId || !blob) return;
        const cfg = getAiConfig();
        if (!cfg.inferenceBaseUrl) {
            resetVisionPanel();
            return;
        }
        showVisionLoading();
        runVisionJob(db, currentUserId, blob, {
            source: "scanner",
            fieldId: fieldSel ? fieldSel.value || null : null,
            cropSlug: cropSel ? cropSel.value || null : null,
            fieldContextStates: fieldContextStatesLast,
            fields: fieldsListLast,
            scans: [],
        })
            .then(showVisionJobResult)
            .catch((e) => {
                if (visionText) visionText.textContent = `Vision error: ${e.message || e}`;
            });
    };

    // ── Live AI detection (Gemini multimodal via Val Town proxy) ──
    // Every ~6s while the toggle is on: grab a frame, send to Gemini vision,
    // surface the diagnosis as a glowing badge in the top-left of the
    // viewfinder. We bypass scanner-live-vision.js entirely now — that
    // module needed a separately-hosted FastAPI model that most users
    // don't have configured.
    function liveErrorMessage(error) {
        const e = String(error || "").toLowerCase();
        if (e === "starting" || e === "warming_up") return "Warming up the camera…";
        if (e === "camera_not_ready") return "Camera taking longer than usual — keep it pointed at a leaf";
        if (e.startsWith("video_not_ready")) return "Camera frame not ready — retrying";
        if (e === "no_video_element") return "Camera unavailable — refresh and re-allow access";
        if (e === "draw_failed" || e.startsWith("draw_failed")) return "Couldn't read camera frame — retrying";
        if (e === "encode_failed") return "Frame encode failed — retrying";
        if (e === "all_providers_failed") return "AI reachable but returned no answer — hold steady";
        if (e.startsWith("upstream_status_")) return "AI service " + e.replace("upstream_status_", "") + " — retrying";
        if (e === "could_not_parse_json") return "AI replied but format was off — retrying";
        if (e.startsWith("network")) return "Network blip — retrying";
        if (e.startsWith("tick_threw")) return "Live loop hiccup — retrying";
        if (e === "no_frame") return "No camera frame yet — hold steady";
        return e ? "Retrying… (" + e.slice(0, 40) + ")" : "Hold steady on a leaf";
    }
    function setLiveBadge({ ok, diagnosis, error }) {
        const badge = document.getElementById("sc-live-badge");
        const titleEl = document.getElementById("sc-live-title");
        const subEl = document.getElementById("sc-live-sub");
        if (!badge || !titleEl || !subEl) return;
        badge.hidden = false;
        badge.classList.remove("is-warn", "is-bad");
        if (!ok) {
            titleEl.textContent = "AI watching…";
            subEl.textContent = liveErrorMessage(error);
            return;
        }
        const d = diagnosis;
        titleEl.textContent = d.diseaseName || "Analyzing…";
        const conf = Number.isFinite(d.confidence) ? Math.round(d.confidence) : null;
        const subBits = [];
        if (d.scientificName) subBits.push(d.scientificName);
        if (conf != null) subBits.push(conf + "% confident");
        subEl.textContent = subBits.length ? subBits.join(" · ") : (d.summary || "Live detection");
        if (d.riskLevel === "medium") badge.classList.add("is-warn");
        if (d.riskLevel === "high") badge.classList.add("is-bad");

        // The richer AI Review panel below the viewfinder mirrors every
        // detection — both live ticks and one-shot capture/upload share
        // this code path so the panel always reflects the latest verdict.
        populateAiReview(d);
    }

    // ── Rich "AI Review" panel below the viewfinder ──
    let _lastReviewAt = 0;
    function formatStamp(deltaMs) {
        if (deltaMs < 5000) return "just now";
        if (deltaMs < 60000) return Math.round(deltaMs / 1000) + "s ago";
        return Math.round(deltaMs / 60000) + "m ago";
    }
    function populateAiReview(d) {
        const panel = document.getElementById("sc-ai-review");
        if (!panel || !d) return;
        const $ = (id) => document.getElementById(id);
        panel.hidden = false;

        // Plant-type chip (only shown when AI returned one)
        const plantChip = $("sc-ai-rev-plant");
        const plantTxt  = $("sc-ai-rev-plant-text");
        if (plantChip && plantTxt) {
            if (d.plantType && d.plantType.toLowerCase() !== "unidentified plant") {
                plantTxt.textContent = d.plantType;
                plantChip.hidden = false;
            } else {
                plantChip.hidden = true;
            }
        }

        // Risk chip — color-coded by risk level
        const riskChip = $("sc-ai-rev-risk");
        const riskTxt  = $("sc-ai-rev-risk-text");
        if (riskChip && riskTxt) {
            riskChip.classList.remove("risk-healthy", "risk-low", "risk-medium", "risk-high");
            const lvl = d.riskLevel || "medium";
            riskChip.classList.add("risk-" + lvl);
            riskTxt.textContent = riskLabel(lvl);
        }

        // Confidence chip
        const confTxt = $("sc-ai-rev-conf-text");
        if (confTxt) confTxt.textContent = Math.max(0, Math.min(100, Math.round(d.confidence || 0))) + "% confident";

        // Narrative — the conversational "It looks like…" line
        const narrEl = $("sc-ai-rev-narr");
        if (narrEl) narrEl.textContent = d.narrative || d.summary || "AI couldn't articulate a verdict from this frame.";

        // Optional diagnosis row (hidden when healthy / no specific disease)
        const dxRow  = $("sc-ai-rev-dx-row");
        const dxName = $("sc-ai-rev-dx-name");
        const dxSci  = $("sc-ai-rev-dx-sci");
        if (dxRow && dxName && dxSci) {
            const showDx = d.diseaseName && !["healthy", "unknown", ""].includes(d.diseaseName.toLowerCase());
            if (showDx) {
                dxName.textContent = d.diseaseName;
                dxSci.textContent = d.scientificName || "";
                dxRow.hidden = false;
            } else {
                dxRow.hidden = true;
            }
        }

        // Recommendations list
        const recsList = $("sc-ai-rev-recs-list");
        if (recsList) {
            recsList.innerHTML = "";
            const recs = Array.isArray(d.recommendations) && d.recommendations.length
                ? d.recommendations
                : ["Take a clear close-up of the affected leaf for a sharper diagnosis."];
            for (const r of recs.slice(0, 5)) {
                const li = document.createElement("li");
                li.textContent = r;
                recsList.appendChild(li);
            }
        }

        // Timestamp on the head row
        _lastReviewAt = Date.now();
        const stampEl = $("sc-ai-rev-stamp");
        if (stampEl) stampEl.textContent = "just now";
    }
    // Keep the "just now / 12s ago" stamp ticking once per second.
    setInterval(() => {
        if (!_lastReviewAt) return;
        const stampEl = document.getElementById("sc-ai-rev-stamp");
        if (stampEl) stampEl.textContent = formatStamp(Date.now() - _lastReviewAt);
    }, 1000);
    function hideLiveBadge() {
        const badge = document.getElementById("sc-live-badge");
        if (badge) badge.hidden = true;
    }

    const stopLiveVision = () => {
        if (liveHandle && typeof liveHandle.stop === "function") liveHandle.stop();
        liveHandle = null;
        if (visionCanvas) {
            const ctx = visionCanvas.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, visionCanvas.width, visionCanvas.height);
        }
        if (liveToggle) {
            liveToggle.setAttribute("aria-pressed", "false");
            liveToggle.classList.remove("live-active", "is-active");
        }
        hideLiveBadge();
    };

    if (liveToggle) {
        liveToggle.addEventListener("click", () => {
            if (liveHandle) {
                stopLiveVision();
                showScannerStatus("Live AI scan stopped.", false, 1200);
                return;
            }
            const v = qs("videoElement");
            if (!v || !v.videoWidth) {
                showScannerStatus("Camera not ready yet — give it a moment.", true, 2200);
                return;
            }
            try {
                liveHandle = startLiveGeminiScan({
                    videoEl: v,
                    intervalMs: 6000,
                    context: {
                        cropType: cropSel?.value || "",
                        fieldName: fieldSel?.options[fieldSel.selectedIndex]?.textContent || "",
                    },
                    onDetection: setLiveBadge,
                });
                liveToggle.setAttribute("aria-pressed", "true");
                liveToggle.classList.add("live-active", "is-active");
                setLiveBadge({ ok: false, error: "starting" });
                showScannerStatus("Live AI scan running — Gemini every ~6s.", false, 1600);
            } catch (e) {
                console.warn("[scanner] live vision start:", e?.message || e);
                showScannerStatus("Could not start live scan: " + (e?.message || e), true, 2800);
            }
        });
    }

    const updateSymptomCount = () => {
        if (!symptomsWrap || !symptomCount) return;
        const selected = getSelectedSymptoms(symptomsWrap);
        symptomCount.textContent = `${selected.length} selected`;
    };

    if (symptomsWrap) renderSymptoms(symptomsWrap, updateSymptomCount);
    updateSymptomCount();

    const toAnalyzeState = () => {
        setHidden(readyState, true);
        setHidden(resultState, true);
        setHidden(analyzeState, false);
    };
    const toReadyState = () => {
        setHidden(analyzeState, true);
        setHidden(resultState, true);
        setHidden(readyState, false);
        stopLiveVision();
        computed = null;
        currentBlob = null;
        if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
        currentPreviewUrl = null;
        if (preview) preview.removeAttribute("src");
        resetVisionPanel();
        if (cropSel) cropSel.value = "";
        if (symptomsWrap) {
            for (const b of symptomsWrap.querySelectorAll("button.active")) b.click();
        }
    };
    const toResultState = () => {
        setHidden(readyState, true);
        setHidden(analyzeState, true);
        setHidden(resultState, false);
    };

    if (retakeBtn) retakeBtn.addEventListener("click", () => toReadyState());
    if (backBtn) backBtn.addEventListener("click", () => toAnalyzeState());

    // ── AI vision (Gemini multimodal via Val Town proxy) ──
    // Auto-runs after the user captures or uploads a photo. If it returns
    // a structured diagnosis, we fill the result card and jump straight to
    // the result-state. If it fails (offline, val down, JSON parse fail)
    // the user just stays in analyze-state and can fall back to the manual
    // symptoms form like before.
    let aiVisionInFlight = false;
    function riskToHealth(level) {
      // Map the AI's qualitative risk to the 0-100 health score the rest
      // of the app uses (higher = healthier).
      switch ((level || "").toLowerCase()) {
        case "healthy": return 92;
        case "low":     return 78;
        case "medium":  return 55;
        case "high":    return 28;
        default:        return 60;
      }
    }
    function riskClass(level) {
      switch ((level || "").toLowerCase()) {
        case "healthy":
        case "low":     return "risk-good";
        case "high":    return "risk-bad";
        default:        return "";
      }
    }
    function riskLabel(level) {
      switch ((level || "").toLowerCase()) {
        case "healthy": return "Healthy";
        case "low":     return "Low Risk";
        case "high":    return "High Risk";
        case "medium":  return "Medium Risk";
        default:        return "Medium Risk";
      }
    }
    function populateAiResult(diagnosis) {
      // ── Top-row fields ──
      const titleEl = qs("result-title");
      if (titleEl) {
        titleEl.textContent = diagnosis.diseaseName || "Scan result";
        // Existing scanner styling toggles `.danger` on the result-badge
        // for unhealthy outcomes — keep that behaviour for back-compat.
        titleEl.classList.toggle("danger", diagnosis.riskLevel !== "healthy");
      }
      const sciEl = document.getElementById("result-sci");
      if (sciEl) sciEl.textContent = diagnosis.scientificName || diagnosis.summary || "";

      // ── Confidence bar ──
      const confFill = document.getElementById("sc-conf-fill");
      const healthEl = qs("result-health");
      const pct = Math.max(0, Math.min(100, Math.round(diagnosis.confidence || 0)));
      if (confFill) confFill.style.width = pct + "%";
      if (healthEl) healthEl.textContent = String(pct);

      // ── Risk pill ──
      const riskWrap = document.getElementById("sc-result-risk");
      const riskLbl = document.getElementById("sc-risk-label");
      if (riskWrap) {
        riskWrap.classList.remove("risk-good", "risk-bad");
        const cls = riskClass(diagnosis.riskLevel);
        if (cls) riskWrap.classList.add(cls);
      }
      if (riskLbl) riskLbl.textContent = riskLabel(diagnosis.riskLevel);

      // ── Recommendations list ──
      const list = document.querySelector("#result-state .rec-list");
      if (list) {
        list.innerHTML = "";
        const recs = Array.isArray(diagnosis.recommendations) && diagnosis.recommendations.length
          ? diagnosis.recommendations
          : ["No recommendations from AI — try a clearer close-up of the affected leaf."];
        for (let i = 0; i < recs.length; i++) {
          const li = document.createElement("li");
          // First few items as "done" checks (planned actions), last as
          // monitoring "to-do" — matches the reference mockup pattern.
          li.className = i === recs.length - 1 ? "is-todo" : "is-done";
          li.textContent = recs[i];
          list.appendChild(li);
        }
      }
    }
    async function startAiVision(blob) {
      if (!blob || aiVisionInFlight) return;
      aiVisionInFlight = true;
      try {
        // Light farm context — the AI uses it to disambiguate (e.g. wheat vs
        // tomato yellowing has very different cause sets).
        const farmContext = {};
        if (fieldSel && fieldSel.value) {
          const f = (fieldsListLast || []).find((x) => x.id === fieldSel.value);
          if (f) farmContext.fields = [{ name: f.name, cropType: f.cropType, cropVariety: f.cropVariety, areaAcres: f.areaAcres }];
        }
        const result = await runAiVisionScan(blob, {
          farmContext: Object.keys(farmContext).length ? farmContext : null,
          cropType: cropSel?.value || "",
          observedSymptoms: symptomsWrap ? getSelectedSymptoms(symptomsWrap) : [],
        });
        if (!result.ok) {
          console.warn("[scanner] AI vision failed:", result.error, result.raw?.slice(0, 200));
          if (visionText) {
            visionPanel?.classList.remove("hidden");
            visionText.textContent = "AI vision unreachable — fill in symptoms below and tap Generate to use the local rules-based diagnosis instead.";
          }
          return;
        }

        const d = result.diagnosis;
        // Stash into `computed` so the existing Save Report button writes
        // the AI result to Firestore (same shape as the rules-based path).
        computed = {
          cropType: cropSel?.value || "Other",
          fieldId: fieldSel?.value || "",
          selectedSymptoms: symptomsWrap ? getSelectedSymptoms(symptomsWrap) : [],
          healthScore: riskToHealth(d.riskLevel),
          diagnosis: {
            code: "ai_vision",
            label: d.diseaseName,
            category: d.riskLevel === "healthy" ? "healthy" : "risk",
            scientificName: d.scientificName || "",
            summary: d.summary || "",
            aiConfidence: d.confidence,
            aiRiskLevel: d.riskLevel,
            aiProvider: result.provider,
            aiModel: result.model,
          },
          severity: {
            level: d.riskLevel === "healthy" ? "good"
                 : d.riskLevel === "low" ? "good"
                 : d.riskLevel === "high" ? "critical"
                 : "warning",
            label: riskLabel(d.riskLevel),
          },
          recommendations: (d.recommendations || []).map((text) => ({ type: "action", text })),
          analysisVersion: "ai-vision-v1",
        };

        populateAiResult(d);
        populateAiReview(d); // mirror into the rich review panel above the dock
        toResultState();
        if (navigator.vibrate) navigator.vibrate([60, 30, 60]);
      } catch (e) {
        console.warn("[scanner] AI vision error:", e?.message || e);
      } finally {
        aiVisionInFlight = false;
      }
    }

    // Auth gating + realtime field list
    onAuthStateChanged(auth, (user) => {
        if (!user) {
            window.location.href = "login.html";
            return;
        }
        currentUserId = user.uid;

        // Populate fields dropdown
        if (fieldSel) {
            const fieldsQ = query(
                collection(db, "fields"),
                where("userId", "==", user.uid),
                limit(50)
            );
            onSnapshot(fieldsQ, (snap) => {
                fieldsListLast = [];
                const prev = fieldSel.value;
                fieldSel.innerHTML = `<option value="">No field selected</option>`;
                snap.forEach((d) => {
                    fieldsListLast.push({ id: d.id, ...d.data() });
                    const f = d.data();
                    const opt = document.createElement("option");
                    opt.value = d.id;
                    opt.textContent = f.name ? f.name : `Field ${d.id.slice(0, 6).toUpperCase()}`;
                    fieldSel.appendChild(opt);
                });
                fieldSel.value = prev;
            });
            const fcQ = query(collection(db, "field_context_state"), where("userId", "==", user.uid), limit(40));
            onSnapshot(fcQ, (snap) => {
                fieldContextStatesLast = [];
                snap.forEach((d) => fieldContextStatesLast.push({ id: d.id, fieldId: d.id, ...d.data() }));
            });
        }
    });

    const runShutterFlash = () => {
        const flash = qs("cam-shutter-flash");
        if (!flash) return;
        flash.classList.add("cam-shutter-active");
        requestAnimationFrame(() => {
            setTimeout(() => flash.classList.remove("cam-shutter-active"), 95);
        });
    };

    const cameraFeed = qs("camera-feed");
    const assistBadge = qs("cam-assist-badge");
    const assistText = qs("cam-assist-text");
    if (cameraFeed && assistBadge && assistText) {
        cameraFeed.addEventListener("agri-cam-luma", (e) => {
            const luma = e.detail && typeof e.detail.luma === "number" ? e.detail.luma : null;
            if (luma == null) return;
            if (luma < 0.34) {
                assistBadge.hidden = false;
                assistText.textContent = "Low light — add light or hold steadier";
            } else if (luma > 0.72) {
                assistBadge.hidden = false;
                assistText.textContent = "Bright scene — avoid washed highlights";
            } else {
                assistBadge.hidden = true;
                assistText.textContent = "";
            }
        });
    }

    const flipBtn = qs("flip-camera");
    if (flipBtn) {
        flipBtn.addEventListener("click", async () => {
            if (camSwitching) return;
            camSwitching = true;
            flipBtn.disabled = true;
            const cam = window.__agriCamera;
            if (!cam || typeof cam.toggleFacing !== "function") {
                showScannerStatus("Camera is not ready yet.", true, 1800);
                camSwitching = false;
                flipBtn.disabled = false;
                return;
            }
            try {
                if (hasManyCamsCache == null && navigator.mediaDevices?.enumerateDevices) {
                    const devs = await navigator.mediaDevices.enumerateDevices();
                    hasManyCamsCache = devs.filter((d) => d.kind === "videoinput").length > 1;
                }
                await cam.toggleFacing();
                showScannerStatus(
                    hasManyCamsCache ? "Camera switched." : "Using available camera.",
                    !hasManyCamsCache,
                    1700,
                );
            } catch (e) {
                console.warn("[scanner] flip camera:", e?.message || e);
                try {
                    if (typeof cam.restart === "function") await cam.restart();
                } catch {}
                showScannerStatus("Could not switch camera.", true, 2600);
            } finally {
                camSwitching = false;
                flipBtn.disabled = false;
            }
        });
    }

    if (captureBtn) {
        captureBtn.addEventListener("click", async () => {
            try {
                setBtnLoading(captureBtn, true, "Capturing...");
                const videoEl = qs("videoElement");
                runShutterFlash();
                const blob = await captureFromVideo(videoEl);
                currentBlob = blob;
                currentPreviewUrl = URL.createObjectURL(blob);
                if (preview) preview.src = currentPreviewUrl;
                toAnalyzeState();
                startBackgroundVision(blob);
                startAiVision(blob); // Gemini vision → auto-populate result
            } catch (e) {
                console.error(e);
                alert("Could not capture from camera. Try Upload instead.");
            } finally {
                setBtnLoading(captureBtn, false);
            }
        });
    }

    if (uploadInput) {
        uploadInput.addEventListener("change", () => {
            const file = uploadInput.files && uploadInput.files[0];
            if (!file) return;
            if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
            currentBlob = file;
            currentPreviewUrl = URL.createObjectURL(file);
            if (preview) preview.src = currentPreviewUrl;
            toAnalyzeState();
            startBackgroundVision(file);
            startAiVision(file); // Gemini vision → auto-populate result
        });
    }

    if (analyzeBtn) {
        analyzeBtn.addEventListener("click", async () => {
            // Do not hard-block Generate on crop selection. Mobile users often
            // upload first and expect immediate analysis; fallback keeps flow smooth.
            let cropType = cropSel ? cropSel.value.trim() : "";
            if (!cropType) {
                cropType = "Other";
                if (cropSel) cropSel.value = "Other";
            }
            const selected = symptomsWrap ? getSelectedSymptoms(symptomsWrap) : [];
            const healthScore = computeHealthScore(selected);
            const diagnosis = computeDiagnosis(selected);
            const severity = computeSeverity(healthScore);
            const recommendations = buildRecommendations({ diagnosis, selectedSymptomIds: selected });

            computed = {
                cropType,
                fieldId: fieldSel ? fieldSel.value : "",
                selectedSymptoms: selected,
                healthScore,
                diagnosis,
                severity,
                recommendations,
            };

            renderResult({ healthScore, diagnosis, severity, recommendations });
            toResultState();
            if (navigator.vibrate) navigator.vibrate([60, 30, 60]);
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
            if (!currentUserId) return;
            if (!computed) {
                alert("Please generate recommendations first.");
                return;
            }

            setBtnLoading(saveBtn, true, "Saving...");

            const scanRef = doc(collection(db, "crop_scans"));
            let imageMeta = null;

            try {
                if (currentBlob) {
                    setBtnLoading(saveBtn, true, "Uploading image...");
                    imageMeta = await uploadScanImage({
                        userId: currentUserId,
                        scanId: scanRef.id,
                        blob: currentBlob,
                        onProgress: (pct) => setBtnLoading(saveBtn, true, `Uploading ${pct}%`),
                    });
                }

                const batch = writeBatch(db);
                batch.set(scanRef, {
                    userId: currentUserId,
                    fieldId: computed.fieldId || null,
                    cropType: computed.cropType,
                    observedSymptoms: computed.selectedSymptoms,
                    diagnosis: computed.diagnosis,
                    healthScore: computed.healthScore,
                    severity: computed.severity,
                    recommendations: computed.recommendations,
                    image: imageMeta,
                    createdAt: serverTimestamp(),
                    schemaVersion: 1,
                    analysisVersion: "rules-v1",
                });

                const activityRef = doc(collection(db, "activity_history"));
                batch.set(activityRef, {
                    userId: currentUserId,
                    type: "crop_scan.created",
                    createdAt: serverTimestamp(),
                    entity: { kind: "crop_scan", id: scanRef.id },
                    meta: {
                        cropType: computed.cropType,
                        fieldId: computed.fieldId || null,
                        severity: computed.severity.level,
                    },
                    schemaVersion: 1,
                });

                const scanReliability = buildSymptomScanReliability(computed, imageMeta);

                // Store recommendations as first-class realtime items
                for (const r of computed.recommendations) {
                    const recRef = doc(collection(db, "ai_recommendations"));
                    batch.set(recRef, {
                        userId: currentUserId,
                        scanId: scanRef.id,
                        fieldId: computed.fieldId || null,
                        source: "rules-v1",
                        type: r.type,
                        text: r.text,
                        status: "active",
                        createdAt: serverTimestamp(),
                        schemaVersion: 2,
                        reliability: scanReliability,
                        recommendationAudit: {
                            primaryEpistemic: scanReliability.primaryEpistemic,
                            evidenceBundle: scanReliability.evidenceBundle,
                            contributingSignals: scanReliability.contributingSignals,
                            reasoningSummary: scanReliability.reasoningSummary,
                            calibratedConfidence: scanReliability.calibratedConfidence,
                            confidenceLabel: scanReliability.confidenceLabel,
                            actionKind: r.type,
                        },
                    });
                }

                const chId = cropHealthDocId(currentUserId, computed.fieldId, computed.cropType);
                batch.set(doc(db, "crop_health", chId), {
                    userId: currentUserId,
                    fieldId: computed.fieldId || null,
                    cropType: computed.cropType,
                    healthScore: computed.healthScore,
                    diagnosis: computed.diagnosis,
                    severity: computed.severity,
                    latestScanId: scanRef.id,
                    updatedAt: serverTimestamp(),
                    analysisVersion: "rules-v1",
                    schemaVersion: 1,
                }, { merge: true });

                const pestRef = doc(collection(db, "pest_predictions"));
                const prLevel =
                    computed.severity?.level === "critical" ? "high"
                    : computed.diagnosis?.category === "risk" && computed.healthScore < 55 ? "medium"
                    : "low";
                const symptomN = computed.selectedSymptoms?.length || 0;
                const pestRaw = prLevel === "high" ? 0.58 : prLevel === "medium" ? 0.48 : 0.38;
                const pestCal = calibrateConfidence(pestRaw, {
                    evidenceStrength: symptomN >= 2 ? 0.56 : 0.42,
                    freshness01: 1,
                    penaltyStack: ["rules_only"],
                });
                batch.set(pestRef, {
                    userId: currentUserId,
                    fieldId: computed.fieldId || null,
                    scanId: scanRef.id,
                    riskLevel: prLevel,
                    threats: computed.diagnosis?.code === "pest_damage"
                        ? [{ name: "Pest pressure (symptom-based)", risk: prLevel }]
                        : [],
                    basis: {
                        diagnosisCode: computed.diagnosis?.code || null,
                        healthScore: computed.healthScore,
                        symptomCount: symptomN,
                    },
                    reliability: {
                        schemaVersion: 1,
                        primaryEpistemic: EPISTEMIC.PREDICTED,
                        rawConfidence: pestRaw,
                        calibratedConfidence: pestCal,
                        confidenceLabel: confidenceLabel(pestCal),
                        evidenceBundle: { basis: "symptom_scan_heuristic", prLevel, symptomCount: symptomN },
                    },
                    createdAt: serverTimestamp(),
                    schemaVersion: 2,
                });

                if (computed.severity?.level === "critical" || computed.healthScore < 45) {
                    const alertRef = doc(collection(db, "alerts"));
                    let alertSev = computed.severity?.level === "critical" ? "high" : "warn";
                    alertSev = gateAlertSeverity(alertSev, scanReliability.calibratedConfidence);
                    const diagnosisCode = computed.diagnosis?.code || null;
                    const homeRetention =
                        diagnosisCode === "pest_damage" || diagnosisCode === "fungal_risk"
                            ? "biosecurity"
                            : null;
                    batch.set(alertRef, {
                        userId: currentUserId,
                        severity: alertSev,
                        title: computed.diagnosis?.label || "Crop health notice",
                        body:
                            `Scan recorded ${computed.healthScore}% health for ${computed.cropType}. ` +
                            `This is an inferred signal from your logged symptoms — please verify in the field. ` +
                            `Review recommendations and schedule a scouting pass.`,
                        type: "crop_scan",
                        readAt: null,
                        entity: { kind: "crop_scan", id: scanRef.id },
                        createdAt: serverTimestamp(),
                        schemaVersion: 2,
                        reliability: scanReliability,
                        epistemicPrimary: scanReliability.primaryEpistemic,
                        dataScope: "inferred_from_symptoms",
                        diagnosisCode,
                        ...(homeRetention ? { homeRetention } : {}),
                    });
                }

                const insightRef = doc(collection(db, "ai_insights"));
                batch.set(insightRef, {
                    userId: currentUserId,
                    scanId: scanRef.id,
                    headline: `${computed.cropType} — ${computed.diagnosis?.label || "Scan complete"}`,
                    summary: (computed.recommendations && computed.recommendations[0]?.text) || "",
                    priority: computed.severity?.level === "critical" ? "high" : "normal",
                    createdAt: serverTimestamp(),
                    schemaVersion: 1,
                });

                // Notify (ambient-classified; duplicates soft-throttled for low-signal types)
                const notifRef = doc(collection(db, "notifications"));
                const notifDraft = {
                    userId: currentUserId,
                    title: "Scan saved",
                    body: `${computed.cropType} scan saved to your history.`,
                    type: "scan_saved",
                    readAt: null,
                    createdAt: serverTimestamp(),
                    entity: { kind: "crop_scan", id: scanRef.id },
                    schemaVersion: 1,
                };
                const decorated = decorateNotificationForAmbient(notifDraft, {
                    healthScore: computed.healthScore,
                    severityLevel: computed.severity?.level,
                    fieldId: computed.fieldId || null,
                });
                if (decorated) {
                    batch.set(notifRef, decorated);
                    if (decorated.ambientTier === "elevated") {
                        enqueueSensoryCue("escalation", { fieldId: computed.fieldId, scanId: scanRef.id });
                    }
                }

                await batch.commit();
                try {
                    const { ensurePostScanFollowUpTask } = await import("./ops/operations-service.js");
                    if (computed.fieldId) {
                        await ensurePostScanFollowUpTask(
                            db,
                            currentUserId,
                            computed.fieldId,
                            scanRef.id,
                            computed.healthScore,
                        );
                    }
                } catch (opErr) {
                    console.warn("[ops] follow-up task:", opErr?.message || opErr);
                }
                if (computed.fieldId) {
                    try {
                        await mergeSymptomScanIntoFieldMemory(db, currentUserId, computed.fieldId, {
                            diagnosisLabel: computed.diagnosis?.label,
                            diagnosis: computed.diagnosis,
                            healthScore: computed.healthScore,
                            cropSlug: computed.cropType,
                            severity: computed.severity?.level,
                        });
                    } catch (memErr) {
                        console.warn("field memory (symptom scan):", memErr);
                    }
                }
                try {
                    queueLearningFlush(db, currentUserId, "scan_saved");
                } catch (learErr) {
                    console.warn("[learning] scan_saved:", learErr?.message || learErr);
                }
                window.location.href = "index.html";
            } catch (e) {
                console.error(e);
                alert(`Failed to save scan: ${e.message}`);
                setBtnLoading(saveBtn, false);
            }
        });
    }

    // Default state
    toReadyState();
});
