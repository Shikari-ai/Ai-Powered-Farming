/**
 * Realtime multimodal copilot: camera (non-blocking) + throttled vision + voice (Web Speech API).
 */
import "./auth-session.js?v=32";
import { auth, db } from "./auth.js?v=32";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    doc,
    limit,
    onSnapshot,
    query,
    where,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { attachPremiumCamera } from "./camera-engine.js";
import { startLiveDiseaseScan } from "./scanner-live-vision.js?v=35";
import { buildRichVisionContextBundle } from "./ai/vision-context.js?v=34";
import { getAiConfig } from "./ai/config.js?v=49";
import { normalizeCompanionProfile } from "./ai/companion-memory.js?v=35";
import { createCopilotVoice } from "./copilot-voice.js";
import {
    answerVoiceQuery,
    buildProactiveUtterance,
    createProactiveGate,
} from "./copilot-narrator.js";

function el(id) {
    return document.getElementById(id);
}

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = "login.html";
        return;
    }

    const video = el("copilot-video");
    const canvas = el("copilot-overlay");
    const captionText = el("copilot-caption-text");
    const banner = el("copilot-banner");
    const micBtn = el("copilot-mic");
    const walkEl = el("copilot-walk");
    const proactiveEl = el("copilot-proactive");

    let fields = [];
    let scans = [];
    let fieldContextStates = [];
    let weatherLogs = [];
    let companion = normalizeCompanionProfile(null, user.uid);

    onSnapshot(query(collection(db, "fields"), where("userId", "==", user.uid), limit(80)), (snap) => {
        fields = [];
        snap.forEach((d) => fields.push({ id: d.id, ...d.data() }));
    });
    onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(400)), (snap) => {
        scans = [];
        snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
    });
    onSnapshot(query(collection(db, "field_context_state"), where("userId", "==", user.uid), limit(40)), (snap) => {
        fieldContextStates = [];
        snap.forEach((d) => fieldContextStates.push({ id: d.id, fieldId: d.id, ...d.data() }));
    });
    onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(20)), (snap) => {
        weatherLogs = [];
        snap.forEach((d) => weatherLogs.push({ id: d.id, ...d.data() }));
    });

    const walkModeRef = { current: true };
    if (walkEl) walkModeRef.current = !!walkEl.checked;

    const gate = createProactiveGate({
        walkModeRef,
        minMsNormal: 13_000,
        minMsWalk: 24_000,
    });

    const voice = createCopilotVoice({
        lang: companion.preferredLanguage === "hi" ? "hi-IN" : navigator.language || "en-US",
        onStatus(s) {
            if (s === "listening") micBtn?.classList.add("listening");
            if (s === "idle" || s === "stt_error") micBtn?.classList.remove("listening");
        },
    });

    onSnapshot(doc(db, "companion_profiles", user.uid), (snap) => {
        companion = normalizeCompanionProfile(snap.data(), user.uid);
        if (companion.preferredLanguage === "hi") voice.setLang("hi-IN");
        else voice.setLang((typeof navigator !== "undefined" && navigator.language) || "en-US");
    });

    walkEl?.addEventListener("change", () => {
        walkModeRef.current = !!walkEl.checked;
        gate.reset();
    });

    let camCtl = null;
    let liveScan = null;
    let lastVision = null;

    function showBanner(msg) {
        if (!banner) return;
        banner.textContent = msg;
        banner.classList.toggle("show", !!msg);
    }

    function updateCaptionFromVision(r) {
        if (!captionText) return;
        if (!r || !r.ok) {
            captionText.textContent = lastVision?.ok
                ? "Reconnecting to vision…"
                : "Align leaves in frame. Voice answers use your latest weather when vision is still warming up.";
            return;
        }
        const hyp = r.topHypothesis || "Screening";
        const c =
            typeof r.confidence === "number"
                ? `${Math.round(Math.min(1, r.confidence) * 100)}% model confidence`
                : "confidence updating";
        const tier = r.contextualIntel?.risk_tier ? ` • ${r.contextualIntel.risk_tier} tier` : "";
        captionText.textContent = `${hyp} — ${c}${tier}. Observed in-camera; not a substitute for lab diagnosis.`;
    }

    async function getContextOverride() {
        return buildRichVisionContextBundle({
            fieldContextStates,
            scans,
            fields,
            climateProfile: null,
        });
    }

    try {
        camCtl = await attachPremiumCamera(video, { feedRoot: el("copilot-feed") });
        captionText.textContent = "Camera live. Copilot is watching with your field memory and weather context.";
    } catch (e) {
        captionText.textContent = "Camera unavailable—check permissions or try HTTPS.";
        console.warn(e);
    }

    const cfg = getAiConfig();
    if (!cfg.inferenceBaseUrl) {
        showBanner(
            "Vision API URL not set — add <meta name=\"agri-inference-url\"> for live overlays. Voice Q&A still works with your weather logs.",
        );
    } else {
        liveScan = startLiveDiseaseScan({
            videoEl: video,
            canvasEl: canvas,
            tuning: {
                minIntervalMs: document.documentElement.dataset.agriPerf === "low" ? 1650 : 900,
            },
            getContextOverride,
            contextTtlMs: 48_000,
            uiTheme: "copilot",
            onVisionResult(r) {
                lastVision = r;
                updateCaptionFromVision(r);
                if (!proactiveEl?.checked) return;
                if (voice.isListening()) return;
                const key = [
                    r.topHypothesis || "",
                    r.contextualIntel?.risk_tier || "",
                    (r.detections || []).map((d) => d.label).join(","),
                ].join("|");
                if (!gate.shouldSpeak(key)) return;
                const line = buildProactiveUtterance(r, { weatherLogs, companion });
                if (line) void voice.speak(line, { interrupt: false });
            },
        });
        if (!liveScan.active) {
            showBanner("Live vision could not start — confirm your inference server is reachable.");
        }
    }

    el("copilot-back")?.addEventListener("click", () => {
        try {
            liveScan?.stop();
        } catch {
            /* ignore */
        }
        try {
            camCtl?.stop();
        } catch {
            /* ignore */
        }
        voice.cancelSpeech();
        window.location.href = "scanner.html";
    });

    el("copilot-flip")?.addEventListener("click", async () => {
        try {
            await camCtl?.toggleFacing();
        } catch {
            /* ignore */
        }
    });

    micBtn?.addEventListener("click", () => {
        voice.cancelSpeech();
        voice.startListen((transcript) => {
            const answer = answerVoiceQuery(transcript, lastVision, weatherLogs, {
                fields,
                scans,
                fieldContextStates,
                weatherLogs,
                interventions: [],
                regionalBriefing: "",
            });
            if (captionText) {
                captionText.textContent = `You: ${transcript}\n\nCopilot: ${answer}`;
            }
            void voice.speak(answer, { interrupt: true });
        });
    });

    window.addEventListener("pagehide", () => {
        try {
            liveScan?.stop();
        } catch {
            /* ignore */
        }
        try {
            camCtl?.stop();
        } catch {
            /* ignore */
        }
        voice.cancelSpeech();
    });
});
