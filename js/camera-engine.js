/**
 * High-performance scanner camera pipeline for mobile web.
 * Preview stays on a single <video> element (native decode/render).
 * Enhancement = light CSS + optional luminance-driven class toggles (no per-pixel CPU path on the main thread).
 */

const FACING_ENV = "environment";
const FACING_USER = "user";

function prefersLowTier() {
    try {
        if (typeof document !== "undefined" && document.documentElement?.dataset?.agriPerf === "low") return true;
        if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return true;
        if (navigator.deviceMemory != null && navigator.deviceMemory <= 4) return true;
        if (navigator.hardwareConcurrency != null && navigator.hardwareConcurrency <= 3) return true;
    } catch {}
    return false;
}

export function getCameraTier() {
    return prefersLowTier() ? "low" : "high";
}

function constraintCascade(facing, tier) {
    const hi = tier === "high";
    const base = { facingMode: { ideal: facing } };
    const audio = false;

    const wide = {
        video: {
            ...base,
            width: { ideal: 1920, min: 1280 },
            height: { ideal: 1080, min: 720 },
            frameRate: { ideal: 30, max: 60 },
            resizeMode: "none",
        },
        audio,
    };

    const mid = {
        video: {
            ...base,
            width: { ideal: 1280, min: 720 },
            height: { ideal: 720, min: 540 },
            frameRate: { ideal: 30, max: 30 },
        },
        audio,
    };

    const safe = {
        video: {
            facingMode: { ideal: facing },
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 24 },
        },
        audio,
    };

    const minimal = {
        video: { facingMode: facing },
        audio,
    };

    if (hi) return [wide, mid, safe, minimal];
    return [mid, safe, minimal];
}

async function acquireStream(constraintsList) {
    let lastErr;
    for (const c of constraintsList) {
        try {
            return await navigator.mediaDevices.getUserMedia(c);
        } catch (e) {
            lastErr = e;
        }
    }
    throw lastErr || new Error("Camera unavailable");
}

function normalizeFacing(c) {
    const v = c && c.video;
    if (!v) return { audio: false, video: true };
    const fm = v.facingMode;
    if (typeof fm === "string") return c;
    if (fm && typeof fm === "object" && fm.exact) return { ...c, video: { ...v, facingMode: fm.exact } };
    if (fm && typeof fm === "object" && fm.ideal) return { ...c, video: { ...v, facingMode: fm.ideal } };
    return c;
}

async function applyFastAutofocus(track) {
    if (!track || typeof track.applyConstraints !== "function") return;

    const tryAdvanced = async (pairs) => {
        try {
            await track.applyConstraints({ advanced: pairs });
            return true;
        } catch {
            return false;
        }
    };

    const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};

    if (caps.focusMode && Array.isArray(caps.focusMode)) {
        if (caps.focusMode.includes("continuous")) {
            await tryAdvanced([{ focusMode: "continuous" }]);
        } else if (caps.focusMode.includes("single-shot")) {
            await tryAdvanced([{ focusMode: "single-shot" }]);
        }
    } else {
        await tryAdvanced([{ focusMode: "continuous" }]);
    }

    await tryAdvanced([{ exposureMode: "continuous" }]);
}

async function tapRefocus(track, nx, ny) {
    if (!track || typeof track.applyConstraints !== "function") return;
    const x = Math.max(0, Math.min(1, nx));
    const y = Math.max(0, Math.min(1, ny));
    try {
        await track.applyConstraints({
            advanced: [
                { pointsOfInterest: [{ x, y }] },
                { focusMode: "single-shot" },
            ],
        });
    } catch {
        try {
            await track.applyConstraints({ advanced: [{ focusMode: "single-shot" }] });
        } catch {}
    }
}

/**
 * Lightweight live assist: samples center ROI luminance on a decimated schedule.
 * Never draws the full frame — does not replace the video preview.
 */
function createLiveAssist(videoEl, feedRoot, tier) {
    let stopped = false;
    let rvfId = 0;
    let lastTs = 0;
    const intervalMs = tier === "high" ? 220 : 420;
    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = (now) => {
        if (stopped) return;
        if (now - lastTs < intervalMs) {
            schedule();
            return;
        }
        lastTs = now;

        if (!videoEl || videoEl.readyState < 2 || !feedRoot) {
            schedule();
            return;
        }

        try {
            ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let sum = 0;
            for (let i = 0; i < data.length; i += 4) {
                sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
            }
            const luma = sum / (data.length / 4) / 255;

            feedRoot.classList.toggle("cam-low-luma", luma < 0.34);
            feedRoot.classList.toggle("cam-high-luma", luma > 0.72);

            try {
                feedRoot.dispatchEvent(new CustomEvent("agri-cam-luma", { detail: { luma } }));
            } catch {
                /* ignore */
            }
        } catch {
            // ignore sampling errors
        }

        schedule();
    };

    const schedule = () => {
        if (stopped) return;
        if (typeof videoEl.requestVideoFrameCallback === "function") {
            rvfId = videoEl.requestVideoFrameCallback(tick);
        } else {
            rvfId = requestAnimationFrame(tick);
        }
    };

    schedule();

    return () => {
        stopped = true;
        if (typeof videoEl.cancelVideoFrameCallback === "function" && rvfId) {
            try {
                videoEl.cancelVideoFrameCallback(rvfId);
            } catch {}
        } else {
            cancelAnimationFrame(rvfId);
        }
        if (feedRoot) {
            feedRoot.classList.remove("cam-low-luma", "cam-high-luma");
        }
    };
}

export async function attachPremiumCamera(videoEl, options = {}) {
    if (!videoEl || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera not supported");
    }

    const feedRoot = options.feedRoot || videoEl.closest(".camera-feed") || videoEl.parentElement;
    const tier = options.tier || getCameraTier();

    let facing = options.facing || FACING_ENV;
    let stream = null;
    let stopAssist = null;
    let tapHandlerBound = null;
    let lastTrack = null;

    const stop = () => {
        if (stopAssist) {
            stopAssist();
            stopAssist = null;
        }
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
        if (feedRoot && tapHandlerBound) {
            feedRoot.removeEventListener("click", tapHandlerBound);
            tapHandlerBound = null;
        }
        lastTrack = null;
        videoEl.removeAttribute("data-cam-ready");
        try {
            videoEl.srcObject = null;
        } catch {}
        if (feedRoot) feedRoot.classList.remove("cam-active");
    };

    const start = async () => {
        stop();
        const list = constraintCascade(facing, tier).map(normalizeFacing);
        stream = await acquireStream(list);
        videoEl.srcObject = stream;
        videoEl.muted = true;
        videoEl.setAttribute("playsinline", "");
        videoEl.setAttribute("autoplay", "");
        videoEl.playsInline = true;

        const track = stream.getVideoTracks()[0];
        lastTrack = track;
        if (track) {
            await applyFastAutofocus(track);
        }

        await videoEl.play().catch(() => {});

        feedRoot.classList.add("cam-active");
        videoEl.setAttribute("data-cam-ready", "1");

        stopAssist = createLiveAssist(videoEl, feedRoot, tier);

        tapHandlerBound = (ev) => {
            if (!lastTrack || !feedRoot.contains(videoEl)) return;
            const rect = feedRoot.getBoundingClientRect();
            const nx = (ev.clientX - rect.left) / rect.width;
            const ny = (ev.clientY - rect.top) / rect.height;
            tapRefocus(lastTrack, nx, ny);
        };
        feedRoot.addEventListener("click", tapHandlerBound, { passive: true });
    };

    await start();

    return {
        stop,
        async restart() {
            await start();
        },
        getStream() {
            return stream;
        },
        getFacing() {
            return facing;
        },
        async toggleFacing() {
            facing = facing === FACING_ENV ? FACING_USER : FACING_ENV;
            await start();
        },
        getTier() {
            return tier;
        },
    };
}
