/**
 * Enriches Firestore notification drafts with ambient metadata and soft dedupe.
 */
import { classifyAmbientPriority } from "./priority-engine.js";
import { getAmbientAttentionPrefs, shouldThrottleNotification } from "./attention-memory.js";

function fingerprintFor(draft, signalContext) {
    const t = draft.type || "unknown";
    const eid = draft.entity?.id || "";
    const ek = draft.entity?.kind || "";
    const fid = signalContext.fieldId || "";
    return `${t}|${ek}|${eid}|${fid}`.replace(/\s+/g, "_");
}

/**
 * @param {Record<string, any>} draft — must include userId, title, body, type, createdAt, readAt, entity…
 * @param {object} [signalContext]
 * @param {number|null} [signalContext.healthScore]
 * @param {string} [signalContext.severityLevel]
 * @param {string|null} [signalContext.fieldId]
 * @param {{ lat: number, lng: number }|null} [signalContext.latLng]
 * @returns {Record<string, any>|null} null = skip write (throttled)
 */
export function decorateNotificationForAmbient(draft, signalContext = {}) {
    const prefs = getAmbientAttentionPrefs();
    const classified = classifyAmbientPriority(
        {
            notificationType: draft.type,
            healthScore: signalContext.healthScore ?? null,
            severityLevel: signalContext.severityLevel,
            fieldId: signalContext.fieldId ?? null,
        },
        prefs,
    );

    const fp = fingerprintFor(draft, signalContext);
    let throttleMs = 0;
    if (draft.type === "field_updated") throttleMs = 18 * 60 * 1000;
    else if (classified.tier === "passive" && draft.type !== "scan_saved") throttleMs = 12 * 60 * 1000;

    if (throttleMs && shouldThrottleNotification(fp, throttleMs)) return null;

    const schemaVersion = typeof draft.schemaVersion === "number" ? Math.max(draft.schemaVersion, 2) : 2;

    return {
        ...draft,
        ambientTier: classified.tier,
        ambientPriority: classified.score,
        suppressInterruption: classified.suppressInterruption,
        ambientFingerprint: fp,
        spatialContext:
            signalContext.latLng && typeof signalContext.latLng.lat === "number"
                ? { fieldId: signalContext.fieldId || null, lat: signalContext.latLng.lat, lng: signalContext.latLng.lng }
                : signalContext.fieldId
                  ? { fieldId: signalContext.fieldId }
                  : null,
        schemaVersion,
    };
}
