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

import { runAiVisionScan } from "./vision-scan.js?v=6";

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
 * Wait up to `timeoutMs` for the video element to be drawable (has a
 * non-zero size + has actually started producing frames). Returns true
 * if ready, false on timeout. iOS Safari in particular reports
 * videoWidth=0 for several hundred ms after getUserMedia resolves, so
 * a fixed 6-second polling cadence can repeatedly catch the camera
 * mid-startup.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
async function waitForVideoReady(videoEl, timeoutMs = 5000) {
  if (!videoEl) return false;
  const deadline = Date.now() + timeoutMs;
  // readyState 2 = HAVE_CURRENT_DATA; 3 = HAVE_FUTURE_DATA; 4 = HAVE_ENOUGH_DATA
  while (Date.now() < deadline) {
    if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0 && videoEl.readyState >= 2) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  return videoEl.videoWidth > 0 && videoEl.videoHeight > 0;
}

/**
 * Capture one downsized JPEG frame from a live <video>.
 * @param {HTMLVideoElement} videoEl
 * @returns {Promise<{ blob: Blob, error?: undefined } | { blob?: undefined, error: string }>}
 */
async function captureFrame(videoEl) {
  if (!videoEl) return { error: "no_video_element" };
  if (!videoEl.videoWidth || !videoEl.videoHeight) {
    return { error: "video_not_ready (rs=" + videoEl.readyState + " vw=" + videoEl.videoWidth + ")" };
  }
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  const scale = Math.min(1, FRAME_MAX_DIM / Math.max(vw, vh));
  const w = Math.max(1, Math.round(vw * scale));
  const h = Math.max(1, Math.round(vh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  try {
    ctx.drawImage(videoEl, 0, 0, w, h);
  } catch (e) {
    return { error: "draw_failed: " + (e?.message || e) };
  }
  const blob = await new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.82);
  });
  if (!blob) return { error: "encode_failed" };
  return { blob };
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
      const captured = await captureFrame(videoEl);
      if (!captured.blob) {
        if (!stopped) onDetection({ ok: false, error: captured.error || "no_frame", tickIndex: myTick });
        return;
      }
      const result = await runAiVisionScan(captured.blob, {
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

  // Boot sequence: wait briefly for the camera to start producing frames
  // BEFORE the first real Gemini call — otherwise we burn a tick on a
  // black/zero-size frame and the user sees a generic "Hold steady"
  // message even though the camera is healthy. After the warm-up, fire
  // one immediate tick, then keep ticking at the configured interval.
  (async () => {
    onDetection({ ok: false, error: "warming_up", tickIndex: 0 });
    const ready = await waitForVideoReady(videoEl, 6000);
    if (stopped) return;
    if (!ready) {
      onDetection({ ok: false, error: "camera_not_ready", tickIndex: 0 });
    }
    runTick();
    timer = setInterval(runTick, intervalMs);
  })();

  return {
    stop() {
      stopped = true;
      if (timer) { clearInterval(timer); timer = null; }
    },
  };
}
