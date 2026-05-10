/**
 * Open-Meteo forecast for AI engines (OpenWeather-style fields derived client-side).
 * IMD: wire server-side; browsers should not hold IMD keys. Optional `imd` block in response when backend adds it.
 */

export async function fetchOpenMeteoBundle(lat, lon) {
    if (typeof lat !== "number" || typeof lon !== "number" || Number.isNaN(lat) || Number.isNaN(lon)) {
        throw new Error("Invalid coordinates");
    }
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
        `&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,surface_pressure,uv_index,is_day` +
        `&hourly=temperature_2m,relative_humidity_2m,precipitation_probability,precipitation,weather_code` +
        `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,uv_index_max` +
        `&forecast_days=4&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Weather fetch failed (${res.status})`);
    return res.json();
}
