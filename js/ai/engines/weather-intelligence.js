import { fetchOpenMeteoBundle } from "../weather-fetch.js";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

/**
 * Deterministic weather + agronomy advisory. All numbers trace to Open-Meteo or stored logs.
 * @param {any} ctx
 * @param {{ lat: number, lon: number, city?: string }} loc
 */
export async function runWeatherIntelligence(ctx, loc) {
    const bundle = await fetchOpenMeteoBundle(loc.lat, loc.lon);
    const cur = bundle.current || {};
    const daily = bundle.daily || {};
    const hourly = bundle.hourly || {};

    const temp = typeof cur.temperature_2m === "number" ? cur.temperature_2m : null;
    const rh = typeof cur.relative_humidity_2m === "number" ? cur.relative_humidity_2m : null;
    const wind = typeof cur.wind_speed_10m === "number" ? cur.wind_speed_10m : null;
    const precipNow = typeof cur.precipitation === "number" ? cur.precipitation : 0;
    const uv = typeof cur.uv_index === "number" ? cur.uv_index : null;

    const rainToday =
        daily.precipitation_sum && typeof daily.precipitation_sum[0] === "number" ? daily.precipitation_sum[0] : null;
    const rainTomorrow =
        daily.precipitation_sum && typeof daily.precipitation_sum[1] === "number" ? daily.precipitation_sum[1] : null;

    // Build a 5-day day-by-day forecast array so reply builders can surface
    // multi-day questions ("rain tomorrow", "next 3 days", "this week")
    // directly instead of punting users to the Weather tab.
    /** @type {Array<{date:string, tMaxC:number|null, tMinC:number|null, precipMm:number|null, precipProbMax:number|null, weatherCode:number|null}>} */
    const forecastDaily = [];
    const dateRows = Array.isArray(daily.time) ? daily.time : [];
    for (let i = 0; i < dateRows.length; i++) {
        forecastDaily.push({
            date: dateRows[i] || null,
            tMaxC: typeof daily.temperature_2m_max?.[i] === "number" ? daily.temperature_2m_max[i] : null,
            tMinC: typeof daily.temperature_2m_min?.[i] === "number" ? daily.temperature_2m_min[i] : null,
            precipMm: typeof daily.precipitation_sum?.[i] === "number" ? daily.precipitation_sum[i] : null,
            precipProbMax: typeof daily.precipitation_probability_max?.[i] === "number" ? daily.precipitation_probability_max[i] : null,
            weatherCode: typeof daily.weather_code?.[i] === "number" ? daily.weather_code[i] : null,
        });
    }

    /** Simple fungal pressure index 0–1 from humidity + rain */
    let fungalPressure = 0;
    const reasons = [];
    if (rh != null) {
        if (rh >= 85) {
            fungalPressure += 0.42;
            reasons.push(`Relative humidity is ${Math.round(rh)}% (≥85%), which sustains fungal sporulation on leaf surfaces.`);
        } else if (rh >= 70) {
            fungalPressure += 0.22;
            reasons.push(`Humidity is ${Math.round(rh)}% — elevated leaf wetness duration risk if nights are cool.`);
        }
    }
    if (rainToday != null && rainToday > 8) {
        fungalPressure += 0.28;
        reasons.push(`Today's accumulated rain is ~${rainToday.toFixed(1)} mm — heavy leaf wetness until canopies dry.`);
    } else if (rainToday != null && rainToday > 2) {
        fungalPressure += 0.12;
        reasons.push(`Today's rain ~${rainToday.toFixed(1)} mm increases foliar wetness.`);
    }
    if (precipNow > 0.2) {
        fungalPressure += 0.08;
        reasons.push("Precipitation is active now — avoid spraying until leaves dry unless using a systemic needing rainfast timing.");
    }
    fungalPressure = clamp(fungalPressure, 0, 0.95);

    const irrigation = [];
    if (rainTomorrow != null && rainTomorrow > 5) {
        irrigation.push(`Tomorrow's forecast rain ~${rainTomorrow.toFixed(1)} mm — delay irrigation unless soil probes show deficit.`);
    } else if (rainTomorrow != null && rainTomorrow < 0.5 && temp != null && temp > 30) {
        irrigation.push("Hot, dry-looking window ahead — check soil moisture at root depth before adding water.");
    } else {
        irrigation.push("No extreme irrigation signal from rainfall alone — confirm with soil moisture / crop stage.");
    }

    const spray = [];
    if (wind != null && wind > 20) {
        spray.push(`Wind ~${Math.round(wind)} km/h — high drift risk; postpone foliar sprays if possible.`);
    } else if (wind != null && wind > 12) {
        spray.push(`Wind ~${Math.round(wind)} km/h — use coarse droplets and buffer zones.`);
    } else {
        spray.push("Wind conditions appear moderate for spraying if labels allow — still verify local safety rules.");
    }

    if (uv != null && uv > 7) {
        spray.push(`UV index ${uv.toFixed(1)} — some chemistries stress foliage; follow label timing vs heat.`);
    }

    const harvest = [];
    if (rainToday != null && rainToday > 15) {
        harvest.push("Heavy rain can delay harvest and raise grain moisture — monitor lodging if applicable.");
    }

    const dataQualityNote =
        "Weather source: Open-Meteo (global). Government IMD gridded feeds should be fused server-side for India-specific nowcasts when you connect them.";

    return {
        engine: "weather_intelligence",
        version: 1,
        location: { ...loc, provider: "open-meteo" },
        readings: {
            temperatureC: temp,
            humidityPct: rh,
            windKmh: wind,
            precipNowMm: precipNow,
            uv,
            rainTodayMm: rainToday,
            rainTomorrowMm: rainTomorrow,
            forecastDaily,
        },
        fungalDiseasePressure: {
            score: Math.round(fungalPressure * 100) / 100,
            label:
                fungalPressure >= 0.55 ? "elevated"
                : fungalPressure >= 0.3 ? "moderate"
                : "lower",
            reasons,
        },
        irrigation,
        spraying: spray,
        harvest: harvest,
        explanation: reasons.length ? reasons[0] : "Conditions do not show extreme fungal-pressure triggers from humidity/rain alone.",
        dataQualityNote,
        rawRef: {
            time: cur.time || null,
            timezone: bundle.timezone || null,
        },
    };
}
