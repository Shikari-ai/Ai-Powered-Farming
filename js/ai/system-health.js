/**
 * Lightweight client-side AI / data health — no PII, in-memory + sessionStorage.
 * Used for degraded-mode UX and diagnostics copy.
 */
import { getAiConfig, isInferenceConfigured, isLlmProxyConfigured } from "./config.js";

const STORAGE_KEY = "agri_ai_health_v1";
const MAX_LAT_SAMPLES = 12;

const state = {
    online: typeof navigator === "undefined" ? true : navigator.onLine,
    lastWeatherSyncMs: null,
    lastSatelliteHintMs: null,
    inferenceSamplesMs: [],
    inferenceFailStreak: 0,
    lastInferenceError: null,
    companionStaleWeatherHours: null,
};

function load() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const o = JSON.parse(raw);
        if (typeof o.lastWeatherSyncMs === "number") state.lastWeatherSyncMs = o.lastWeatherSyncMs;
        if (typeof o.lastSatelliteHintMs === "number") state.lastSatelliteHintMs = o.lastSatelliteHintMs;
        if (Array.isArray(o.inferenceSamplesMs)) state.inferenceSamplesMs = o.inferenceSamplesMs.slice(-MAX_LAT_SAMPLES);
    } catch {
        /* ignore */
    }
}

function persist() {
    try {
        sessionStorage.setItem(
            STORAGE_KEY,
            JSON.stringify({
                lastWeatherSyncMs: state.lastWeatherSyncMs,
                lastSatelliteHintMs: state.lastSatelliteHintMs,
                inferenceSamplesMs: state.inferenceSamplesMs,
            }),
        );
    } catch {
        /* quota */
    }
}

load();

if (typeof window !== "undefined") {
    window.addEventListener("online", () => {
        state.online = true;
    });
    window.addEventListener("offline", () => {
        state.online = false;
    });
}

export function notifyWeatherSynced() {
    state.lastWeatherSyncMs = Date.now();
    persist();
}

/** Call when map/geo layers refresh satellite-style context */
export function notifySatelliteContextTouched() {
    state.lastSatelliteHintMs = Date.now();
    persist();
}

/**
 * @param {{ ok: boolean, ms?: number, error?: string }} evt
 */
export function recordInferenceOutcome(evt) {
    if (evt?.ok && typeof evt.ms === "number" && !Number.isNaN(evt.ms)) {
        state.inferenceFailStreak = 0;
        state.lastInferenceError = null;
        state.inferenceSamplesMs.push(evt.ms);
        if (state.inferenceSamplesMs.length > MAX_LAT_SAMPLES) state.inferenceSamplesMs.shift();
    } else {
        state.inferenceFailStreak = Math.min(20, (state.inferenceFailStreak || 0) + 1);
        state.lastInferenceError = evt?.error || "request_failed";
    }
    persist();
}

export function setCompanionWeatherStalenessHours(h) {
    if (typeof h === "number" && h >= 0) state.companionStaleWeatherHours = h;
}

function weatherFresh01() {
    if (state.lastWeatherSyncMs == null) return 0.35;
    const ageH = (Date.now() - state.lastWeatherSyncMs) / 3600000;
    if (ageH < 2) return 1;
    if (ageH < 8) return 0.75;
    if (ageH < 24) return 0.5;
    return 0.35;
}

/**
 * @returns {{ degraded: boolean, reasons: string[], hints: string[], weatherFresh01: number, avgInferenceMs: number|null }}
 */
export function getDegradedState() {
    const reasons = [];
    const hints = [];
    if (!state.online) {
        reasons.push("offline");
        hints.push("You appear offline — showing saved farm data only.");
    }
    const wf = weatherFresh01();
    if (wf < 0.55) {
        reasons.push("stale_weather");
        hints.push("Weather intelligence may be dated; refresh the Weather page when you reconnect.");
    }
    if (isInferenceConfigured() && state.inferenceFailStreak >= 3) {
        reasons.push("inference_unstable");
        hints.push("Vision API has had several failed attempts — image analysis may be unavailable.");
    }
    if (!isInferenceConfigured()) {
        hints.push("Vision server URL not configured — disease-from-photo uses fallback messaging.");
    }
    if (!isLlmProxyConfigured()) {
        hints.push("LLM proxy not configured — answers use on-device engines only.");
    }
    const avgMs =
        state.inferenceSamplesMs.length > 0
            ? Math.round(
                  state.inferenceSamplesMs.reduce((a, b) => a + b, 0) /
                      state.inferenceSamplesMs.length,
              )
            : null;
    if (avgMs != null && avgMs > 12000) {
        reasons.push("high_latency");
        hints.push("Inference responses have been slow — patience recommended for large images.");
    }

    return {
        degraded: reasons.length > 0,
        reasons,
        hints,
        weatherFresh01: wf,
        avgInferenceMs: avgMs,
        lastInferenceError: state.lastInferenceError,
    };
}

/** Plain-language lines for profile diagnostics */
export function getDiagnosticsLines() {
    const cfg = getAiConfig();
    const d = getDegradedState();
    const lines = [];
    lines.push(`Engine pack: ${cfg.enginePackVersion}`);
    lines.push(`Network: ${state.online ? "Online" : "Offline"}`);
    lines.push(
        state.lastWeatherSyncMs
            ? `Last weather sync (this device): ${new Date(state.lastWeatherSyncMs).toLocaleString()}`
            : "Last weather sync: not recorded yet this session",
    );
    lines.push(
        isInferenceConfigured()
            ? "Vision API: URL configured"
            : "Vision API: not configured (meta / window hook)",
    );
    lines.push(isLlmProxyConfigured() ? "LLM proxy: configured" : "LLM proxy: not configured");
    if (d.avgInferenceMs != null) {
        lines.push(`Recent avg vision latency: ~${d.avgInferenceMs} ms`);
    }
    if (state.inferenceFailStreak > 0) {
        lines.push(`Recent vision failures (streak): ${state.inferenceFailStreak}`);
    }
    if (d.hints.length) {
        lines.push("Notes:");
        d.hints.forEach((h) => lines.push(`· ${h}`));
    }
    return lines;
}
