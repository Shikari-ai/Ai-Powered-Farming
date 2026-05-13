/**
 * Future-ready hooks for haptics / audio / companion displays — no heavy implementation.
 * Call sites can stay lightweight; integrators may assign window.__agriSensoryDispatch.
 *
 * `kind`: "proximity_field" | "soft_nudge" | "escalation" | "briefing_ready"
 */

/** @param {string} kind @param {Record<string, unknown>} payload */
export function enqueueSensoryCue(kind, payload = {}) {
    if (typeof window === "undefined") return;
    const fn = window.__agriSensoryDispatch;
    if (typeof fn === "function") {
        try {
            fn(kind, { ...payload, at: Date.now() });
        } catch {
            /* non-fatal */
        }
    }
}

/** Document channel for low-bandwidth / WebView hosts (optional). */
export function publishAmbientChannelEvent(type, detail) {
    try {
        document.dispatchEvent(new CustomEvent("agri-ambient", { detail: { type, ...detail } }));
    } catch {
        /* ignore */
    }
}
