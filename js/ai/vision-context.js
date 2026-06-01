/**
 * Build a compact JSON bundle for server-side environmental fusion (Open-Meteo, cached ~4 min).
 */

import { tsToMs } from "./farmer-context.js?v=34";
import { summarizeFieldMemoryForVision } from "./field-context.js?v=34";

let _wxCache = { t: 0, payload: null };

function slugCrop(s) {
    if (!s) return null;
    return String(s)
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_")
        .replace(/\//g, "_");
}

export async function buildVisionContextBundle() {
    const now = Date.now();
    if (_wxCache.payload && now - _wxCache.t < 240000) return _wxCache.payload;

    try {
        const raw = localStorage.getItem("agri_location_details");
        const loc = raw ? JSON.parse(raw) : null;
        if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") {
            _wxCache = { t: now, payload: null };
            return null;
        }
        const url =
            `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(loc.lat)}&longitude=${encodeURIComponent(loc.lon)}` +
            `&current=relative_humidity_2m,temperature_2m,precipitation` +
            `&daily=precipitation_sum&forecast_days=1&timezone=auto`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const j = await res.json();
        const payload = {
            humidity_pct: typeof j.current?.relative_humidity_2m === "number" ? j.current.relative_humidity_2m : null,
            temperature_c: typeof j.current?.temperature_2m === "number" ? j.current.temperature_2m : null,
            rain_today_mm:
                j.daily?.precipitation_sum && typeof j.daily.precipitation_sum[0] === "number"
                    ? j.daily.precipitation_sum[0]
                    : null,
            city: loc.city || null,
            lat: loc.lat,
            lon: loc.lon,
        };
        _wxCache = { t: now, payload };
        return payload;
    } catch {
        _wxCache = { t: now, payload: null };
        return null;
    }
}

/**
 * Weather + field memory + season hints for contextual inference (no extra Firestore reads if states passed in).
 * @param {{ fieldContextStates?: any[], scans?: any[], fields?: any[], climateProfile?: string }} p
 */
export async function buildRichVisionContextBundle(p = {}) {
    const weather = await buildVisionContextBundle();
    const base = weather ? { ...weather } : {};
    base.context_version = 1;
    base.month = new Date().getMonth() + 1;
    if (p.climateProfile) base.climate_profile = p.climateProfile;

    const fm = summarizeFieldMemoryForVision(p.fieldContextStates || [], p.scans || [], p.fields || []);
    if (fm.length) base.field_memory = fm;

    const sorted = [...(p.scans || [])].sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    const latest = sorted[0];
    if (latest?.cropType) base.crop_slug = slugCrop(latest.cropType);

    return base;
}
