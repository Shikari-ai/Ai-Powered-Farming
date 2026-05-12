// Live-vision loop that uses our Gemini vision val for periodic AI checks
// on the camera feed. Replaces the old custom-FastAPI live scanner path
// (js/scanner-live-vision.js) which required a separately hosted model.
//
// Each "tick" grabs one frame from the <video> element, downsizes it to
// a small JPEG, and hands it to runAiVisionScan() — same code path the
// capture/upload buttons use, so we get a structured JSON diagnosis back
// from Gemini 2.5 Flash multimodal.
//
// Throttling: free Gemini quota is 15 req/min and we want headroom for
// the rest of the app, so we tick every 6 s by default = ~10 req/min.
// We also guard against overlapping calls: if the previous tick hasn't
// returned yet, we skip the next one rather than queuing.

import { runAiVisionScan } from "./vision-scan.js?v=3";

const DEFAULT_INTERVAL_MS = 6000;
const FRAME_MAX_DIM = 720; // small enough that base64 is ~80-120 KB

/**
 * @typedef {Object} LiveDetection
 * @property {boolean} ok
 * @property {ReturnType<typeof Object>=} diagnosis  diseaseName, riskLevel, confidence, summary, recommendations
 * @property {string=} error
 * @property {number} tickIndex
 */

/**
 * Capture one downsized JPEG frame from a live <video>.
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<Blob|null>}
 */
async function captureFrame(videoEl) {
  if (!videoEl || !videoEl.videoWidth || !videoEl.videoHeight) return null;
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const scale = Math.min(1, FRAME_MAX_DIM / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(videoEl, 0, 0, w, h);
  return await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82);
  });
}

/**
 * Start a live AI vision loop. Call `.stop()` on the returned handle to
 * end it. `onDetection` receives a result object on every successful or
 * failed tick.
 *
 * @param {Object} opts
 * @param {HTMLVideoElement} opts.videoEl
 * @param {(d: LiveDetection) => void} opts.onDetection
 * @param {number} [opts.intervalMs]
 * @param {{ cropType?: string, fieldName?: string }} [opts.context]
 * @returns {{ stop: () => void }}
 */
export function startLiveGeminiScan(opts) {
  const videoEl = opts.videoEl;
  const onDetection = opts.onDetection || (() => {});
  const intervalMs = Math.max(3000, Number(opts.intervalMs) || DEFAULT_INTERVAL_MS);
  const context = opts.context || {};

  let stopped = false;
  let inFlight = false;
  let tickIndex = 0;
  let timer = null;

  async function runTick() {
    if (stopped) return;
    if (inFlight) return; // skip — previous request still pending
    inFlight = true;
    tickIndex += 1;
    const myTick = tickIndex;
    try {
      const blob = await captureFrame(videoEl);
      if (!blob) {
        if (!stopped) onDetection({ ok: false, error: "no_frame", tickIndex: myTick });
        return;
      }
      const result = await runAiVisionScan(blob, {
        cropType: context.cropType || "",
        farmContext: context.fieldName ? { fields: [{ name: context.fieldName, cropType: context.cropType || "" }] } : null,
      });
      if (stopped) return;
      if (result.ok) {
        onDetection({ ok: true, diagnosis: result.diagnosis, tickIndex: myTick });
      } else {
        onDetection({ ok: false, error: result.error || "unknown", tickIndex: myTick });
      }
    } catch (e) {
      if (!stopped) onDetection({ ok: false, error: "tick_threw: " + (e?.message || e), tickIndex: myTick });
    } finally {
      inFlight = false;
    }
  }

  // Fire one immediately so the user sees a result without a 6 s wait,
  // then keep ticking at the configured interval.
  runTick();
  timer = setInterval(runTick, intervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
