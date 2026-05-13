/**
 * Lightweight device / motion hints for adaptive rendering (no deps).
 * Sets documentElement.dataset.agriPerf = "low" | "high"
 */
(function applyRuntimeProfile() {
  try {
    let low = false;
    if (typeof matchMedia === "function") {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) low = true;
    }
    if (typeof navigator !== "undefined") {
      const dm = navigator.deviceMemory;
      if (typeof dm === "number" && dm <= 4) low = true;
      const hc = navigator.hardwareConcurrency;
      if (typeof hc === "number" && hc <= 3) low = true;
    }
    document.documentElement.dataset.agriPerf = low ? "low" : "high";
  } catch (_) {
    document.documentElement.dataset.agriPerf = "low";
  }
})();

export function isLowPerfMode() {
  return document.documentElement.dataset.agriPerf === "low";
}
