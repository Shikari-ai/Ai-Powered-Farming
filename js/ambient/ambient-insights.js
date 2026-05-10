/**
 * Calm, non-spammy insight lines for ambient UI (deterministic + local).
 */
import { getLocalDayPeriod, isLikelyQuietNow } from "./ambient-context.js";

function humidityFromWx(wx) {
    if (!wx || typeof wx !== "object") return null;
    const cur = wx.current;
    if (cur && typeof cur.relative_humidity_2m === "number") return cur.relative_humidity_2m;
    const h = wx.hourly?.relative_humidity_2m;
    if (Array.isArray(h) && typeof h[0] === "number") return h[0];
    const d = wx.daily?.relative_humidity_2m_max;
    if (Array.isArray(d) && typeof d[0] === "number") return d[0];
    return null;
}

function tempFromWx(wx) {
    const cur = wx?.current;
    if (cur && typeof cur.temperature_2m === "number") return cur.temperature_2m;
    const h = wx?.hourly?.temperature_2m;
    if (Array.isArray(h) && typeof h[0] === "number") return h[0];
    return null;
}

/**
 * @param {{
 *   fieldsList?: Array<{ id: string, name?: string }>,
 *   scansByField?: Record<string, { healthScore?: number, createdAt?: any }>,
 *   wxLog?: object|null,
 *   learningProfile?: { reflections?: string[] }|null,
 *   regionalBriefText?: string,
 *   openTaskCount?: number,
 * }} ctx
 * @returns {string[]} max ~4 short lines
 */
export function buildAmbientInsightLines(ctx) {
    const lines = [];
    const fields = ctx.fieldsList || [];
    const scansByField = ctx.scansByField || {};
    const wx = ctx.wxLog;

    const period = getLocalDayPeriod();
    if (period === "morning") lines.push("Morning context: a quick glance at fields and weather is usually enough when conditions are stable.");
    if (period === "evening" && isLikelyQuietNow()) {
        lines.push("Quiet hours on — ambient summaries stay soft; urgent field risks still surface in alerts.");
    }

    const rh = humidityFromWx(wx);
    if (typeof rh === "number") {
        if (rh >= 45 && rh <= 75) lines.push("Humidity looks in a typical mid-range band for many crops today.");
        else if (rh > 80) lines.push("Humidity is elevated — fungal drivers often respond slowly; scouting beats guessing.");
        else lines.push("Air is on the dry side — stress can creep in if soil moisture lags; cross-check irrigation timing.");
    }

    const temps = tempFromWx(wx);
    if (typeof temps === "number") {
        lines.push(`Current air temperature ~${Math.round(temps)}°C (model point forecast — verify locally).`);
    }

    let bestImprove = null;
    let bestName = "";
    for (const f of fields) {
        const s = scansByField[f.id];
        const hs = typeof s?.healthScore === "number" ? s.healthScore : null;
        if (hs != null && hs >= 62 && hs <= 92) {
            if (bestImprove == null || hs > bestImprove) {
                bestImprove = hs;
                bestName = f.name || "Field";
            }
        }
    }
    if (bestImprove != null) {
        lines.push(`Vegetation signals from recent scans look steady in ${bestName} (~${Math.round(bestImprove)}% health index).`);
    }

    const refl = ctx.learningProfile?.reflections;
    if (Array.isArray(refl) && refl[0] && typeof refl[0] === "string") {
        const short = refl[0].length > 120 ? `${refl[0].slice(0, 117)}…` : refl[0];
        lines.push(short);
    }

    const rb = (ctx.regionalBriefText || "").trim();
    if (rb.length > 20) {
        const clip = rb.length > 140 ? `${rb.slice(0, 137)}…` : rb;
        lines.push(`Regional read: ${clip}`);
    }

    const oc = typeof ctx.openTaskCount === "number" ? ctx.openTaskCount : 0;
    if (oc > 0) lines.push(`${oc} open operational item(s) — the queue keeps priorities without extra noise.`);

    const uniq = [];
    const seen = new Set();
    for (const L of lines) {
        const k = L.slice(0, 48);
        if (seen.has(k)) continue;
        seen.add(k);
        uniq.push(L);
        if (uniq.length >= 4) break;
    }
    return uniq.slice(0, 4);
}
