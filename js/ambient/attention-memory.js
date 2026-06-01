/**
 * Client-side attention / ambient preferences (privacy-first; stays on device unless user syncs elsewhere).
 */

const PREFS_KEY = "agri_ambient_prefs";
const THROTTLE_KEY = "agri_ambient_nf";
const ACK_KEY = "agri_attention_ack";

const DEFAULT_PREFS = {
    focusMode: "balanced",
    interruptionSensitivity: "standard",
    badgeCountsPassive: false,
    morningBriefOnHome: true,
    weeklyDigestOptIn: false,
};

export function getAmbientAttentionPrefs() {
    try {
        const o = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
        return { ...DEFAULT_PREFS, ...o };
    } catch {
        return { ...DEFAULT_PREFS };
    }
}

export function mergeAmbientAttentionPrefs(patch) {
    const next = { ...getAmbientAttentionPrefs(), ...patch };
    try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
        /* ignore quota */
    }
    return next;
}

/** @returns {boolean} true if notification write should be skipped (deduped). */
export function shouldThrottleNotification(fingerprint, windowMs) {
    if (!fingerprint || !windowMs) return false;
    try {
        const raw = sessionStorage.getItem(THROTTLE_KEY);
        const o = raw ? JSON.parse(raw) : {};
        const last = o[fingerprint] || 0;
        if (Date.now() - last < windowMs) return true;
        o[fingerprint] = Date.now();
        sessionStorage.setItem(THROTTLE_KEY, JSON.stringify(o));
    } catch {
        return false;
    }
    return false;
}

export function recordInsightAck(fingerprint) {
    if (!fingerprint) return;
    try {
        const o = JSON.parse(localStorage.getItem(ACK_KEY) || "{}");
        o[fingerprint] = Date.now();
        localStorage.setItem(ACK_KEY, JSON.stringify(o));
    } catch {
        /* ignore */
    }
}

export function wasRecentlyAcked(fingerprint, maxAgeMs = 86400000 * 7) {
    try {
        const o = JSON.parse(localStorage.getItem(ACK_KEY) || "{}");
        const ts = o[fingerprint];
        if (!ts) return false;
        return Date.now() - ts < maxAgeMs;
    } catch {
        return false;
    }
}
