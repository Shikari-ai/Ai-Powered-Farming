/**
 * Build a compact JSON bundle for server-side environmental fusion (Open-Meteo, cached ~4 min).
 */

let _wxCache = { t: 0, payload: null };

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
        };
        _wxCache = { t: now, payload };
        return payload;
    } catch {
        _wxCache = { t: now, payload: null };
        return null;
    }
}
