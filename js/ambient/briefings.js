/**
 * Lightweight daily briefing text — cached in sessionStorage by local date (no server).
 */
import { getLocalDayPeriod, isLikelyQuietNow } from "./ambient-context.js";
import { getAmbientAttentionPrefs } from "./attention-memory.js";

function todayKey() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * @param {{
 *   fieldsCount: number,
 *   latestAvgHealth: number|null,
 *   wxLog: object|null,
 *   openTaskCount: number,
 *   regionalBriefText?: string,
 * }} input
 */
export function buildMorningBriefingText(input) {
    const prefs = getAmbientAttentionPrefs();
    if (!prefs.morningBriefOnHome) return "";

    const period = getLocalDayPeriod();
    if (period !== "morning" && period !== "day") {
        return "";
    }

    const key = `agri_brief_am_${todayKey()}`;
    try {
        const hit = sessionStorage.getItem(key);
        if (hit) return hit;
    } catch {
        /* ignore */
    }

    const parts = [];
    parts.push("Briefing — calm, evidence-anchored.");
    parts.push(
        `Fields tracked: ${input.fieldsCount}.`,
    );
    if (input.latestAvgHealth != null) {
        parts.push(`Recent scan blend ~${Math.round(input.latestAvgHealth)}% health index (model-assisted, not a lab test).`);
    } else {
        parts.push("No blended scan trend yet — first scans will anchor this line.");
    }
    if (input.openTaskCount > 0) {
        parts.push(`${input.openTaskCount} open task(s); tackle what is time-sensitive and defer the rest.`);
    } else {
        parts.push("Operational queue is clear; use the day for scheduled passes or equipment checks.");
    }
    const rb = (input.regionalBriefText || "").trim();
    if (rb.length > 12) {
        parts.push(`Regional: ${rb.length > 200 ? `${rb.slice(0, 197)}…` : rb}`);
    }
    if (isLikelyQuietNow()) parts.push("Quiet hours: non-critical nudges stay in the ambient feed.");

    const text = parts.join(" ");
    try {
        sessionStorage.setItem(key, text);
    } catch {
        /* ignore */
    }
    return text;
}
