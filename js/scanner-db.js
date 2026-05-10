import "./auth-session.js?v=28";
import './i18n.js';
import { auth, db, storage } from './auth.js?v=28';
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
    const ctx = canvas.getContext("2d");
    ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => {
            if (!b) reject(new Error("Could not capture image"));
            else resolve(b);
        }, "image/jpeg", 0.92);
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
        computed = null;
        currentBlob = null;
        if (currentPreviewUrl) URL.revokeObjectURL(currentPreviewUrl);
        currentPreviewUrl = null;
        if (preview) preview.removeAttribute("src");
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
                const prev = fieldSel.value;
                fieldSel.innerHTML = `<option value="">No field selected</option>`;
                snap.forEach((d) => {
                    const f = d.data();
                    const opt = document.createElement("option");
                    opt.value = d.id;
                    opt.textContent = f.name ? f.name : `Field ${d.id.slice(0, 6).toUpperCase()}`;
                    fieldSel.appendChild(opt);
                });
                fieldSel.value = prev;
            });
        }
    });

    // Ensure camera starts (if available)
    if (typeof window.initCamera === "function") {
        window.initCamera();
    }

    if (captureBtn) {
        captureBtn.addEventListener("click", async () => {
            try {
                setBtnLoading(captureBtn, true, "Capturing...");
                const videoEl = qs("videoElement");
                const blob = await captureFromVideo(videoEl);
                currentBlob = blob;
                currentPreviewUrl = URL.createObjectURL(blob);
                if (preview) preview.src = currentPreviewUrl;
                toAnalyzeState();
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
        });
    }

    if (analyzeBtn) {
        analyzeBtn.addEventListener("click", async () => {
            const cropType = cropSel ? cropSel.value.trim() : "";
            if (!cropType) {
                alert("Please select a crop type.");
                return;
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
                        schemaVersion: 1,
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
                        symptomCount: computed.selectedSymptoms?.length ?? 0,
                    },
                    createdAt: serverTimestamp(),
                    schemaVersion: 1,
                });

                if (computed.severity?.level === "critical" || computed.healthScore < 45) {
                    const alertRef = doc(collection(db, "alerts"));
                    batch.set(alertRef, {
                        userId: currentUserId,
                        severity: computed.severity?.level === "critical" ? "high" : "warn",
                        title: computed.diagnosis?.label || "Crop health alert",
                        body: `Scan recorded ${computed.healthScore}% health for ${computed.cropType}. Open recommendations and schedule a field check.`,
                        type: "crop_scan",
                        readAt: null,
                        entity: { kind: "crop_scan", id: scanRef.id },
                        createdAt: serverTimestamp(),
                        schemaVersion: 1,
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

                // Notify
                const notifRef = doc(collection(db, "notifications"));
                batch.set(notifRef, {
                    userId: currentUserId,
                    title: "Scan saved",
                    body: `${computed.cropType} scan saved to your history.`,
                    type: "scan_saved",
                    readAt: null,
                    createdAt: serverTimestamp(),
                    entity: { kind: "crop_scan", id: scanRef.id },
                    schemaVersion: 1,
                });

                await batch.commit();
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
