/**
 * Time-of-day and quiet-context hints (no extra network).
 */

/**
 * @returns {"morning"|"day"|"evening"|"night"}
 */
export function getLocalDayPeriod() {
    const h = new Date().getHours();
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "day";
    if (h >= 17 && h < 21) return "evening";
    return "night";
}

function minutesFromMidnight(timeStr) {
    if (!timeStr || typeof timeStr !== "string") return null;
    const [a, b] = timeStr.split(":").map((x) => parseInt(x, 10));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return a * 60 + b;
}

/**
 * Uses the same quiet-hour fields as profile notification prefs (`notif_prefs`).
 */
export function isLikelyQuietNow() {
    try {
        const np = JSON.parse(localStorage.getItem("notif_prefs") || "{}");
        if (!np.quiet) return false;
        const start = minutesFromMidnight(np.quietStart || "22:00");
        const end = minutesFromMidnight(np.quietEnd || "06:00");
        if (start == null || end == null) return false;
        const now = new Date();
        const cur = now.getHours() * 60 + now.getMinutes();
        if (start <= end) return cur >= start && cur < end;
        return cur >= start || cur < end;
    } catch {
        return false;
    }
}
