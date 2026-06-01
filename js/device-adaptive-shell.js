/**
 * Device-adaptive shell — sets `document.documentElement` dataset + CSS variables
 * for cross-page responsive orchestration. Pure presentation; no backend duplication.
 * Load synchronously in <head> after css/design-tokens.css for stable first paint.
 */
(function () {
  var root = document.documentElement;
  var mqReduce = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var mqHover = typeof window.matchMedia === "function" ? window.matchMedia("(hover: hover)") : null;
  var mqCoarse = typeof window.matchMedia === "function" ? window.matchMedia("(pointer: coarse)") : null;

  function tierFor(w, h) {
    var min = Math.min(w, h);
    var max = Math.max(w, h);
    if (w >= 1680) return "ultrawide";
    if (w >= 1280) return "desktop";
    if (w >= 1024) return "laptop";
    if (w >= 768) return "tablet";
    if (min >= 540 && max / min < 1.45 && min < 900) return "foldable";
    return "mobile";
  }

  function apply() {
    var w = window.innerWidth || 390;
    var h = window.innerHeight || 800;
    var tier = tierFor(w, h);
    var orient = w >= h ? "landscape" : "portrait";
    var pointer = mqCoarse && mqCoarse.matches ? "coarse" : mqHover && mqHover.matches ? "fine" : "coarse";
    var motionIntensity = mqReduce && mqReduce.matches ? "0" : "1";

    root.dataset.deviceTier = tier;
    root.dataset.orientation = orient;
    root.dataset.pointer = pointer;
    root.style.setProperty("--motion-intensity", motionIntensity);

    var maxW = "480px";
    var padX = "clamp(14px, 3.6vw, 18px)";
    var density = "1";
    if (tier === "tablet") {
      maxW = "min(720px, 94vw)";
      padX = "clamp(16px, 2.4vw, 22px)";
      density = "1.02";
    } else if (tier === "laptop") {
      maxW = "min(900px, 92vw)";
      padX = "clamp(18px, 2vw, 26px)";
      density = "1.04";
    } else if (tier === "desktop") {
      maxW = "min(1040px, 90vw)";
      density = "1.06";
    } else if (tier === "ultrawide") {
      maxW = "min(1200px, 88vw)";
      density = "1.08";
    } else if (tier === "foldable") {
      maxW = "min(640px, 96vw)";
      density = "1.03";
    }

    root.style.setProperty("--layout-max-width", maxW);
    root.style.setProperty("--layout-content-pad-x", padX);
    root.style.setProperty("--agri-density-scale", density);

    try {
      window.dispatchEvent(
        new CustomEvent("agri-device-context", {
          detail: { tier, orient, pointer, w, h },
        }),
      );
    } catch (_) {}
  }

  var t = 0;
  function debounced() {
    clearTimeout(t);
    t = setTimeout(apply, 120);
  }

  if (typeof window.addEventListener === "function") {
    window.addEventListener("resize", debounced, { passive: true });
    window.addEventListener("orientationchange", debounced, { passive: true });
  }
  if (mqReduce && mqReduce.addEventListener) mqReduce.addEventListener("change", apply);
  if (mqCoarse && mqCoarse.addEventListener) mqCoarse.addEventListener("change", apply);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", apply);
  } else {
    apply();
  }
})();
