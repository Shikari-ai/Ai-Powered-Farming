/**
 * Home "Recent Alerts" visibility + server prune policy (keep in sync with functions/alertPrune.js).
 */

export const ALERT_HOME_DEFAULT_TTL_MS = 86400000; // 24h
/** Pest / disease / insect outbreaks stay visible and in DB longer. */
export const ALERT_HOME_BIOSECURITY_TTL_MS = 90 * 86400000; // 90d

function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    if (typeof ts === "number") return ts;
    return 0;
}

function norm(s) {
    return String(s || "").toLowerCase();
}

function textBlob(a) {
    return `${norm(a.title)} ${norm(a.body)} ${norm(a.type)} ${norm(a.source)}`;
}

/**
 * Pest pressure, plant disease / epidemic signals, cricket & other damaging insects.
 * Uses structured fields when present, else keyword match on title/body/type.
 */
export function isBiosecurityHomeAlert(a) {
    if (!a || a.homeRetention === "biosecurity") return true;
    const code = norm(a.diagnosisCode);
    if (code === "pest_damage" || code === "fungal_risk") return true;
    const t = norm(a.type);
    if (t.includes("pest") || t.includes("disease") || t.includes("insect")) return true;
    const blob = textBlob(a);
    const needles = [
        "pest",
        "cricket",
        "grasshopper",
        "locust",
        "aphid",
        "borer",
        "caterpillar",
        "thrip",
        "whitefly",
        "mite",
        "weevil",
        "hopper",
        "armyworms",
        "armyworm",
        "insect attack",
        "insect damage",
        "insect infest",
        "disease",
        "blight",
        "fungal",
        "epidemic",
        "pandemic",
        "pathogen",
        "wilt",
        "mildew",
        "smut",
        "canker",
        "viral",
        "virus",
        "bacterial leaf",
        "downy mildew",
        "powdery mildew",
    ];
    for (const w of needles) {
        if (blob.includes(w)) return true;
    }
    if (/\b(rust|rot)\b/.test(blob) && !/\brotation\b/.test(blob)) return true;
    return false;
}

export function isAlertWithinHomeTtl(a, nowMs = Date.now()) {
    const ms = tsToMs(a.createdAt);
    if (!ms) return false;
    const age = nowMs - ms;
    const cap = isBiosecurityHomeAlert(a) ? ALERT_HOME_BIOSECURITY_TTL_MS : ALERT_HOME_DEFAULT_TTL_MS;
    return age <= cap;
}

export function filterAlertsForHomeDisplay(items, nowMs = Date.now()) {
    const sorted = [...items].sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    return sorted.filter((a) => isAlertWithinHomeTtl(a, nowMs));
}

/** True if this alert document should be removed from Firestore (matches scheduled prune logic). */
export function shouldPruneAlertDoc(a, nowMs = Date.now()) {
    const createdMs = tsToMs(a.createdAt);
    if (!createdMs) return true;
    const ageMs = nowMs - createdMs;
    if (isBiosecurityHomeAlert(a)) {
        return ageMs > ALERT_HOME_BIOSECURITY_TTL_MS;
    }
    return ageMs > ALERT_HOME_DEFAULT_TTL_MS;
}
