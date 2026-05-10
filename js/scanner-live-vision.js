/**
 * Live camera disease overlay: requestVideoFrameCallback + throttled server inference.
 * Preview stays native <video>; overlay is a <canvas>. Never awaits inference on rVFC path.
 */

import { getAiConfig } from "./ai/config.js?v=34";
import { postDiseaseVision } from "./ai/vision-client.js?v=34";

export class DetectionStabilizer {
    /**
     * @param {{ minConf?: number; emaAlpha?: number; minHits?: number }} p
     */
    constructor(p = {}) {
        this.minConf = p.minConf ?? 0.65;
        this.emaAlpha = p.emaAlpha ?? 0.45;
        this.minHits = p.minHits ?? 2;
        /** @type {Map<string, { ema: number; hits: number; last: any }>} */
        this.byKey = new Map();
    }

    /**
     * @param {any[]} raw
     */
    push(raw) {
        const seen = new Set();
        const out = [];
        for (const d of raw) {
            const key = `${d.class_id ?? d.label}`;
            seen.add(key);
            let st = this.byKey.get(key);
            const conf = typeof d.confidence === "number" ? d.confidence : 0;
            if (!st) {
                st = { ema: conf, hits: conf >= this.minConf ? 1 : 0, last: d };
                this.byKey.set(key, st);
            } else {
                st.ema = this.emaAlpha * conf + (1 - this.emaAlpha) * st.ema;
                st.hits = conf >= this.minConf ? st.hits + 1 : Math.max(0, st.hits - 1);
                st.last = { ...d, confidence: conf };
            }
            const displayConf = st.ema;
            if (displayConf >= this.minConf && st.hits >= this.minHits) {
                out.push({
                    ...d,
                    confidence: Math.min(0.97, displayConf),
                    stable: true,
                });
            }
        }
        for (const k of this.byKey.keys()) {
            if (!seen.has(k)) {
                const st = this.byKey.get(k);
                if (st) {
                    st.hits = Math.max(0, st.hits - 2);
                    if (st.hits <= 0) this.byKey.delete(k);
                }
            }
        }
        return out;
    }

    reset() {
        this.byKey.clear();
    }
}

/**
 * @param {object} opts
 * @param {HTMLVideoElement} opts.videoEl
 * @param {HTMLCanvasElement} opts.canvasEl
 * @param {{ minIntervalMs?: number; confThreshold?: number; lowPerfSkip?: number }} [opts.tuning]
 * @param {string} [opts.trackingId] Optional; default session id used for server-side temporal smoothing.
 * @param {(dets: any[]) => void} [opts.onDetections]
 * @param {(result: any) => void} [opts.onVisionResult] Called with vision `postDiseaseVision` result when `ok`.
 * @param {() => Promise<object|null|undefined>} [opts.getContextOverride] Merged as `context_json` (refreshed every `contextTtlMs`).
 * @param {number} [opts.contextTtlMs]
 * @param {"default"|"copilot"} [opts.uiTheme] Bounding-box / label styling.
 */
export function startLiveDiseaseScan(opts) {
    const cfg = getAiConfig();
    const baseUrl = cfg.inferenceBaseUrl;
    if (!baseUrl) {
        return { stop() {}, active: false, reason: "no_inference_url" };
    }

    const videoEl = opts.videoEl;
    const canvasEl = opts.canvasEl;
    const tuning = opts.tuning || {};
    const minIntervalMs = tuning.minIntervalMs ?? (document.documentElement.dataset.agriPerf === "low" ? 1400 : 850);
    const confThreshold = tuning.confThreshold ?? 0.68;
    const skipEvery = tuning.lowPerfSkip ?? (document.documentElement.dataset.agriPerf === "low" ? 2 : 1);

    let stopped = false;
    let inflight = false;
    let lastRun = 0;
    let rvf = 0;
    let frameIdx = 0;
    const stabilizer = new DetectionStabilizer({ minConf: confThreshold, emaAlpha: 0.5, minHits: 2 });
    const wcap = document.createElement("canvas");
    const wctx = wcap.getContext("2d", { alpha: false });

    let lastDetections = [];
    let ctxCache = null;
    let ctxCacheAt = 0;
    let lastRiskTier = null;
    const sessionTrackingId =
        opts.trackingId ||
        `live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;

    const layoutCanvas = () => {
        const r = videoEl.getBoundingClientRect();
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        canvasEl.style.width = `${r.width}px`;
        canvasEl.style.height = `${r.height}px`;
        canvasEl.width = Math.round(r.width * dpr);
        canvasEl.height = Math.round(r.height * dpr);
        return { r, dpr };
    };

    const draw = () => {
        const ctx = canvasEl.getContext("2d");
        if (!ctx) return;
        const { r, dpr } = layoutCanvas();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, r.width, r.height);

        const vw = videoEl.videoWidth || 1;
        const vh = videoEl.videoHeight || 1;
        const ar = vw / vh;
        const cr = r.width / r.height;
        let dw = r.width;
        let dh = r.height;
        let ox = 0;
        let oy = 0;
        if (ar > cr) {
            dh = r.width / ar;
            oy = (r.height - dh) / 2;
        } else {
            dw = r.height * ar;
            ox = (r.width - dw) / 2;
        }

        const theme = opts.uiTheme || "default";
        const tier = (lastRiskTier || "").toLowerCase();
        const riskWarm = tier === "high" || tier === "critical" || tier === "elevated";

        for (const d of lastDetections) {
            const b = d.box;
            if (!b) continue;
            const x1 = ox + b.x1 * dw;
            const y1 = oy + b.y1 * dh;
            const x2 = ox + b.x2 * dw;
            const y2 = oy + b.y2 * dh;
            if (theme === "copilot") {
                ctx.strokeStyle = riskWarm ? "rgba(251, 113, 133, 0.95)" : "rgba(34, 211, 238, 0.92)";
                ctx.shadowColor = riskWarm ? "rgba(251, 113, 133, 0.35)" : "rgba(34, 211, 238, 0.3)";
                ctx.shadowBlur = 10;
                ctx.lineWidth = 1.5;
            } else {
                ctx.strokeStyle = "rgba(16, 185, 129, 0.95)";
                ctx.shadowBlur = 0;
                ctx.lineWidth = 2;
            }
            ctx.beginPath();
            if (typeof ctx.roundRect === "function") {
                ctx.roundRect(x1, y1, x2 - x1, y2 - y1, 6);
            } else {
                ctx.rect(x1, y1, x2 - x1, y2 - y1);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;

            const confPct = `${Math.round((d.confidence || 0) * 100)}%`;
            const label = `${d.label || "det"} · ${confPct}`;
            ctx.font = theme === "copilot" ? "11px Outfit, Inter, system-ui, sans-serif" : "12px Inter, system-ui, sans-serif";
            const tw = Math.min(ctx.measureText(label).width + 12, r.width - x1);
            ctx.fillStyle =
                theme === "copilot" ? "rgba(6, 10, 14, 0.78)" : "rgba(7, 12, 9, 0.72)";
            ctx.fillRect(x1, y1 - 22, tw, 22);
            ctx.fillStyle = "rgba(255,255,255,0.95)";
            ctx.fillText(label, x1 + 6, y1 - 7);
        }
    };

    const maybeInfer = async () => {
        if (stopped || inflight) return;
        const now = performance.now();
        if (now - lastRun < minIntervalMs) return;
        if (!videoEl.videoWidth) return;

        frameIdx += 1;
        if (frameIdx % (skipEvery + 1) !== 0) return;

        lastRun = now;
        inflight = true;

        const maxW = 640;
        const scale = Math.min(1, maxW / videoEl.videoWidth);
        wcap.width = Math.round(videoEl.videoWidth * scale);
        wcap.height = Math.round(videoEl.videoHeight * scale);
        if (!wctx) {
            inflight = false;
            return;
        }
        wctx.drawImage(videoEl, 0, 0, wcap.width, wcap.height);

        let blob;
        try {
            blob = await new Promise((res, rej) =>
                wcap.toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/jpeg", 0.82)
            );
        } catch {
            inflight = false;
            return;
        }

        let ctxOv = null;
        if (typeof opts.getContextOverride === "function") {
            const ttl = typeof opts.contextTtlMs === "number" ? opts.contextTtlMs : 45000;
            const nowMs = Date.now();
            if (!ctxCache || nowMs - ctxCacheAt > ttl) {
                try {
                    ctxCache = await opts.getContextOverride();
                    ctxCacheAt = nowMs;
                } catch {
                    ctxCache = null;
                }
            }
            ctxOv = ctxCache;
        }

        try {
            const result = await postDiseaseVision(blob, {
                baseUrl,
                confThreshold,
                includeContext: !ctxOv,
                contextOverride: ctxOv || undefined,
                trackingId: sessionTrackingId,
                timeoutMs: 35000,
            });
            if (result.ok) {
                lastRiskTier = result.contextualIntel?.risk_tier || null;
                if (opts.onVisionResult) opts.onVisionResult(result);
            } else {
                lastRiskTier = null;
            }
            if (result.ok && Array.isArray(result.detections)) {
                lastDetections = stabilizer.push(result.detections);
                if (opts.onDetections) opts.onDetections(lastDetections);
            } else {
                lastDetections = [];
                if (opts.onDetections) opts.onDetections([]);
            }
        } catch {
            /* network / server — keep last stable boxes briefly */
        } finally {
            inflight = false;
            draw();
        }
    };

    const ro = new ResizeObserver(() => draw());
    ro.observe(videoEl);

    const tick = () => {
        if (stopped) return;
        draw();
        void maybeInfer().catch(() => {});
        if (typeof videoEl.requestVideoFrameCallback === "function") {
            rvf = videoEl.requestVideoFrameCallback(tick);
        } else {
            rvf = requestAnimationFrame(tick);
        }
    };

    tick();

    return {
        active: true,
        stop() {
            stopped = true;
            stabilizer.reset();
            lastDetections = [];
            lastRiskTier = null;
            ctxCache = null;
            ctxCacheAt = 0;
            ro.disconnect();
            if (typeof videoEl.cancelVideoFrameCallback === "function") {
                try {
                    videoEl.cancelVideoFrameCallback(rvf);
                } catch {
                    /* ignore */
                }
            } else {
                cancelAnimationFrame(rvf);
            }
            const ctx = canvasEl.getContext("2d");
            if (ctx) ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
        },
    };
}
