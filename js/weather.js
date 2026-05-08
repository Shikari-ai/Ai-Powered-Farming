import { auth, db } from "./auth.js";
import { doc, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { openDeviceMaps } from "./maps-link.js";
import { resolveWeatherLocation, FALLBACK_LOC } from "./weather-location.js";

const STORAGE_IMD_KEY = "agri_imd_api_key";
const STORAGE_IMD_PROXY = "agri_imd_proxy";

/** Last location used for this weather view (for “open in maps”). */
let lastWeatherLoc = null;

const qs = (id) => document.getElementById(id);

function weatherDesc(code) {
  if (code === 0) return "Clear sky";
  if (code <= 3) return "Partly cloudy";
  if (code <= 48) return "Fog";
  if (code <= 67) return "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code >= 95) return "Thunderstorm";
  return "Variable";
}

function weatherIcon(code, isDay = 1) {
  if (code === 0) return isDay ? "ri-sun-fill" : "ri-moon-clear-fill";
  if (code <= 3) return isDay ? "ri-sun-cloudy-fill" : "ri-moon-cloudy-fill";
  if (code <= 48) return "ri-mist-fill";
  if (code <= 67) return "ri-showers-fill";
  if (code <= 77) return "ri-snowy-fill";
  if (code <= 82) return "ri-heavy-showers-fill";
  if (code >= 95) return "ri-thunderstorms-fill";
  return "ri-cloud-fill";
}

function heatIndexC(tempC, rh) {
  if (typeof tempC !== "number" || typeof rh !== "number") return null;
  const t = tempC * 9 / 5 + 32;
  const hiF =
    -42.379 +
    2.04901523 * t +
    10.14333127 * rh -
    0.22475541 * t * rh -
    0.00683783 * t * t -
    0.05481717 * rh * rh +
    0.00122874 * t * t * rh +
    0.00085282 * t * rh * rh -
    0.00000199 * t * t * rh * rh;
  return (hiF - 32) * 5 / 9;
}

function pm25Label(v) {
  if (typeof v !== "number") return { label: "N/A", cls: "info" };
  if (v <= 12) return { label: "Good", cls: "ok" };
  if (v <= 35.4) return { label: "Moderate", cls: "info" };
  if (v <= 55.4) return { label: "Unhealthy (Sensitive)", cls: "warn" };
  if (v <= 150.4) return { label: "Unhealthy", cls: "bad" };
  return { label: "Hazardous", cls: "bad" };
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function imdTextToWmoCode(text) {
  const t = (text || "").toLowerCase();
  if (/thunder|lightning|squall/.test(t)) return 95;
  if (/heavy rain|rain|shower|drizzle|precipitation/.test(t)) return 61;
  if (/fog|mist|haze/.test(t)) return 45;
  if (/snow|cold wave/.test(t)) return 71;
  if (/mainly clear|clear|mainly dry|dry/.test(t)) return 0;
  if (/cloud/.test(t)) return 3;
  return 3;
}

function imdExtractRow(json) {
  if (!json || json.error) return null;
  if (Array.isArray(json)) return json[0] || null;
  if (Array.isArray(json.data)) return json.data[0] || null;
  if (json.data && typeof json.data === "object" && !Array.isArray(json.data)) return json.data;
  if (json.Station_Name || json.Todays_Forecast) return json;
  return null;
}

function buildImdDailySeries(row) {
  if (!row) return [];
  let baseDate = new Date();
  if (row.Date) {
    const d = new Date(`${row.Date}T12:00:00`);
    if (!Number.isNaN(d.getTime())) baseDate = d;
  }
  const pairs = [
    { max: row.Todays_Forecast_Max_Temp, min: row.Todays_Forecast_Min_temp, txt: row.Todays_Forecast },
    { max: row.Day_2_Max_Temp, min: row.Day_2_Min_temp, txt: row.Day_2_Forecast },
    { max: row.Day_3_Max_Temp, min: row.Day_3_Min_temp, txt: row.Day_3_Forecast },
    { max: row.Day_4_Max_Temp, min: row.Day_4_Min_temp, txt: row.Day_4_Forecast },
    { max: row.Day_5_Max_Temp, min: row.Day_5_Min_temp, txt: row.Day_5_Forecast },
    { max: row.Day_6_Max_Temp, min: row.Day_6_Min_temp, txt: row.Day_6_Forecast },
    { max: row.Day_7_Max_Temp, min: row.Day_7_Min_temp, txt: row.Day_7_Forecast },
  ];
  const out = [];
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const tMax = num(p.max);
    const tMin = num(p.min);
    const txt = typeof p.txt === "string" ? p.txt.trim() : "";
    if (tMax == null && tMin == null && !txt) continue;
    const dt = new Date(baseDate);
    dt.setDate(dt.getDate() + i);
    const lo = tMin != null ? tMin : tMax;
    const hi = tMax != null ? tMax : tMin;
    out.push({
      date: dt,
      tMin: lo,
      tMax: hi,
      text: txt,
      source: "imd",
    });
  }
  return out;
}

async function fetchImdCityForecastLoc(lat, lon) {
  const proxy = (localStorage.getItem(STORAGE_IMD_PROXY) || "").trim().replace(/\/$/, "");
  const key = (localStorage.getItem(STORAGE_IMD_KEY) || "").trim();
  if (!proxy && !key) return { ok: false, reason: "no_imd_credentials" };

  const path = `/api/v1/cityforecastloc?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`;
  const attempts = [];

  if (proxy) {
    const base = `${proxy}${path}`;
    attempts.push({ url: base, headers: { Accept: "application/json" } });
    if (key) {
      attempts.push({ url: base, headers: { Accept: "application/json", Authorization: `Bearer ${key}` } });
      attempts.push({ url: base, headers: { Accept: "application/json", Authorization: key } });
    }
  }
  if (key) {
    const url = `https://api.imd.gov.in${path}`;
    attempts.push({ url, headers: { Accept: "application/json", Authorization: `Bearer ${key}` } });
    attempts.push({ url, headers: { Accept: "application/json", Authorization: key } });
  }

  for (const a of attempts) {
    try {
      const res = await fetch(a.url, { headers: a.headers });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json || json.error) continue;
      const row = imdExtractRow(json);
      if (row) return { ok: true, row, raw: json };
    } catch {
      /* CORS, network, or blocked */
    }
  }
  return { ok: false, reason: "imd_fetch_failed" };
}

async function fetchOpenMeteo(lat, lon) {
  const forecastUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,is_day,surface_pressure,visibility&hourly=temperature_2m,precipitation_probability,weather_code,is_day&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max&timezone=auto&forecast_days=10`;
  const aqUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=pm2_5,pm10,ozone&timezone=auto`;
  const [fRes, aqRes] = await Promise.all([fetch(forecastUrl), fetch(aqUrl)]);
  if (!fRes.ok) throw new Error("Weather API unavailable");
  const forecast = await fRes.json();
  const air = aqRes.ok ? await aqRes.json() : null;
  return { forecast, air };
}

function applyEnvironment({ weatherCode, isDay }) {
  const env = qs("env");
  const stars = qs("stars");
  const rain = qs("rain");
  const fog = qs("fog");
  const storm = qs("storm");
  if (!env || !stars || !rain || !fog || !storm) return;

  stars.style.opacity = "0";
  rain.style.opacity = "0";
  fog.style.opacity = "0";
  storm.style.opacity = "0";

  if (!isDay) {
    env.style.background = "radial-gradient(900px 460px at 60% -20%, rgba(59,130,246,.22), rgba(8,14,27,.95) 70%)";
    stars.style.opacity = ".95";
  } else if (weatherCode === 0) {
    env.style.background = "radial-gradient(900px 460px at 40% -20%, rgba(245,158,11,.3), rgba(6,16,24,.95) 70%)";
  } else if (weatherCode <= 3) {
    env.style.background = "radial-gradient(900px 460px at 50% -20%, rgba(59,130,246,.25), rgba(7,17,26,.95) 70%)";
  } else if (weatherCode <= 48) {
    env.style.background = "radial-gradient(900px 460px at 50% -20%, rgba(180,200,220,.2), rgba(6,14,20,.95) 70%)";
    fog.style.opacity = ".75";
  } else if (weatherCode <= 82) {
    env.style.background = "radial-gradient(900px 460px at 50% -20%, rgba(59,130,246,.22), rgba(4,10,16,.97) 70%)";
    rain.style.opacity = ".92";
  } else {
    env.style.background = "radial-gradient(900px 460px at 50% -20%, rgba(90,60,160,.24), rgba(4,6,10,.97) 70%)";
    rain.style.opacity = ".72";
    storm.style.opacity = ".95";
  }
}

function renderHourly(hourly) {
  const list = qs("hourly-list");
  if (!list) return;
  list.innerHTML = "";
  const nowIso = new Date().toISOString().slice(0, 13);
  let start = hourly.time.findIndex((t) => t.slice(0, 13) >= nowIso);
  if (start < 0) start = 0;
  for (let i = 0; i < 16; i++) {
    const idx = start + i;
    if (idx >= hourly.time.length) break;
    const d = new Date(hourly.time[idx]);
    const label = i === 0 ? "Now" : d.toLocaleTimeString([], { hour: "numeric" });
    const temp = Math.round(hourly.temperature_2m[idx]);
    const rain = hourly.precipitation_probability[idx];
    const icon = weatherIcon(hourly.weather_code[idx], hourly.is_day ? hourly.is_day[idx] : 1);
    list.innerHTML += `
      <div class="hour">
        <div class="t">${label}</div>
        <div style="margin-top:4px;"><i class="${icon}"></i></div>
        <div class="v">${temp}°</div>
        <div class="r">${Math.round(rain)}%</div>
      </div>
    `;
  }
}

function renderDays(imdSeries, daily) {
  const list = qs("days-list");
  if (!list) return;
  list.innerHTML = "";
  const maxRows = 10;
  const imdLen = imdSeries?.length || 0;

  for (let i = 0; i < maxRows; i++) {
    if (i < imdLen && imdSeries) {
      const e = imdSeries[i];
      const dayLabel = i === 0 ? "Today" : e.date.toLocaleDateString([], { weekday: "short" });
      const code = imdTextToWmoCode(e.text);
      const icon = weatherIcon(code, 1);
      const lo = Math.round(e.tMin);
      const hi = Math.round(e.tMax);
      const snippet = e.text
        ? (e.text.length > 42 ? `${e.text.slice(0, 42)}…` : e.text)
        : "";
      const tail = snippet || "IMD outlook";
      list.innerHTML += `
        <div class="day">
          <div class="d">${dayLabel}</div>
          <div><i class="${icon}"></i></div>
          <div class="rng">${lo}° / ${hi}°</div>
          <div class="pp" title="${e.text || ""}">${tail}</div>
        </div>
      `;
      continue;
    }

    const di = i;
    if (!daily?.time || di >= daily.time.length) break;

    const day = new Date(daily.time[di]);
    const dayLabel = di === 0 ? "Today" : day.toLocaleDateString([], { weekday: "short" });
    const icon = weatherIcon(daily.weather_code[di], 1);
    list.innerHTML += `
      <div class="day">
        <div class="d">${dayLabel}</div>
        <div><i class="${icon}"></i></div>
        <div class="rng">${Math.round(daily.temperature_2m_min[di])}° / ${Math.round(daily.temperature_2m_max[di])}°</div>
        <div class="pp">UV ${Math.round(daily.uv_index_max[di] || 0)} · Open‑Meteo</div>
      </div>
    `;
  }
}

function renderInsights({ current, daily, pm25, soilMoisture, rainSoon, imdRow }) {
  const wrap = qs("insights-list");
  if (!wrap) return;
  const items = [];

  if (imdRow && num(imdRow.Past_24_hrs_Rainfall) > 0) {
    items.push({
      cls: "ok",
      icon: "ri-contrast-drop-2-line",
      text: `IMD recorded rainfall (24h): ${imdRow.Past_24_hrs_Rainfall} mm at ${imdRow.Station_Name || "nearest station"}.`,
    });
  }

  if (typeof rainSoon === "number") {
    if (rainSoon >= 60) {
      items.push({
        cls: "warn",
        icon: "ri-showers-fill",
        text: `High rain probability (${rainSoon}%). Delay foliar sprays and drainage-check low fields.`,
      });
    } else if (rainSoon <= 15) {
      items.push({
        cls: "ok",
        icon: "ri-drop-line",
        text: "Low rain probability in upcoming hours. Good window for controlled irrigation.",
      });
    }
  }
  if (current.relative_humidity_2m >= 80) {
    items.push({
      cls: "warn",
      icon: "ri-virus-line",
      text: "High humidity increases fungal pressure. Increase airflow and scout dense canopy zones.",
    });
  }
  if (typeof daily.uv_index_max?.[0] === "number" && daily.uv_index_max[0] >= 8) {
    items.push({
      cls: "bad",
      icon: "ri-sun-line",
      text: "Very high UV expected. Avoid midday pesticide application and protect field teams.",
    });
  }
  if (typeof pm25 === "number") {
    const label = pm25Label(pm25);
    if (label.cls === "bad" || label.cls === "warn") {
      items.push({
        cls: "warn",
        icon: "ri-windy-line",
        text: `Air quality is ${label.label}. Reduce prolonged manual exposure and monitor worker comfort.`,
      });
    }
  }
  if (typeof soilMoisture === "number") {
    if (soilMoisture < 35) {
      items.push({
        cls: "info",
        icon: "ri-plant-line",
        text: "Soil moisture model suggests dry trend. Prioritize early-morning irrigation blocks.",
      });
    }
    if (soilMoisture > 80) {
      items.push({
        cls: "warn",
        icon: "ri-water-flash-line",
        text: "High moisture estimate. Check for waterlogging in low-lying plots.",
      });
    }
  }
  if (!items.length) {
    items.push({
      cls: "ok",
      icon: "ri-sparkling-line",
      text: "Conditions are currently stable. Continue standard monitoring cadence.",
    });
  }

  wrap.innerHTML = items
    .map((x) => `<div class="insight"><i class="${x.icon} ${x.cls}"></i><div>${x.text}</div></div>`)
    .join("");
}

async function syncWeatherLog(user, loc, forecast, air, imd, soilMoistureEstimate) {
  if (!user) return;
  const hourKey = new Date().toISOString().slice(0, 13).replace(/[-:T]/g, "");
  const id = `${user.uid}_${hourKey}`;
  const current = forecast.current || {};
  const daily = forecast.daily || {};
  const hourly = forecast.hourly || {};
  const aqH = air?.hourly || {};
  const pm25 = Array.isArray(aqH.pm2_5) ? aqH.pm2_5[0] : null;

  await setDoc(
    doc(db, "weather_logs", id),
    {
      userId: user.uid,
      city: loc.city,
      district: loc.district || "",
      state: loc.state || "",
      country: loc.country || "",
      geo: { lat: loc.lat, lon: loc.lon, accuracyM: loc.accuracyM ?? null },
      sources: {
        primaryGrid: "open-meteo",
        imd: imd?.ok
          ? {
              station: imd.row?.Station_Name || null,
              stationCode: imd.row?.Station_Code || null,
            }
          : null,
      },
      fetchedAt: serverTimestamp(),
      current,
      today: {
        uvMax: daily.uv_index_max?.[0] ?? null,
        sunrise: daily.sunrise?.[0] ?? null,
        sunset: daily.sunset?.[0] ?? null,
        tMin: daily.temperature_2m_min?.[0] ?? null,
        tMax: daily.temperature_2m_max?.[0] ?? null,
        pm25,
        imdForecast: imd?.ok ? imd.row?.Todays_Forecast || null : null,
      },
      nextHours: (hourly.time || []).slice(0, 8).map((t, i) => ({
        time: t,
        temp: hourly.temperature_2m?.[i] ?? null,
        precipProb: hourly.precipitation_probability?.[i] ?? null,
        code: hourly.weather_code?.[i] ?? null,
      })),
      derived: {
        soilMoistureEstimate: typeof soilMoistureEstimate === "number" ? soilMoistureEstimate : null,
      },
      schemaVersion: 2,
    },
    { merge: true },
  );
}

function setLocationLines(loc) {
  const locLine = qs("loc-line");
  const coordEl = qs("loc-coords");
  if (locLine) {
    if (loc.source === "insecure-context") {
      locLine.textContent = "Serve this app over HTTPS (or use localhost) for GPS";
    } else if (loc.source === "fallback") {
      locLine.textContent = "Allow location for this site, then tap refresh";
    } else {
      const place = [loc.city, loc.state || "", loc.country || ""].filter(Boolean).join(", ");
      locLine.textContent = place || "Location";
    }
  }
  if (coordEl) {
    const ns = loc.lat >= 0 ? `${loc.lat.toFixed(5)}°N` : `${Math.abs(loc.lat).toFixed(5)}°S`;
    const ew = loc.lon >= 0 ? `${loc.lon.toFixed(5)}°E` : `${Math.abs(loc.lon).toFixed(5)}°W`;
    let tag = "";
    if (loc.source === "insecure-context") tag = " · not a secure page (needs HTTPS)";
    else if (loc.source === "fallback") tag = " · GPS off — approximate area";
    else if (typeof loc.accuracyM === "number" && Number.isFinite(loc.accuracyM))
      tag = ` · GPS ±${Math.round(loc.accuracyM)} m`;
    coordEl.textContent = `${ns} · ${ew}${tag}`;
  }
}

function setSourceLine(imdOk, hasImdCreds, loc) {
  const el = qs("data-source-line");
  if (!el) return;
  let base;
  if (imdOk) {
    base = "Forecast: IMD (7-day) · grid: Open‑Meteo (ECMWF blend)";
  } else if (hasImdCreds) {
    base = "IMD unavailable — Open‑Meteo grid at this lat/lon (check proxy / key)";
  } else {
    base = "Forecast: Open‑Meteo high-res grid at this lat/lon · optional IMD below";
  }
  const locBit =
    loc?.source === "insecure-context"
      ? " · Location: need HTTPS for GPS"
      : loc?.source === "fallback"
        ? " · Location: GPS blocked — fallback"
        : " · Location: device GPS";
  el.textContent = base + locBit;
}

function bindImdSetup() {
  const keyIn = qs("imd-key-input");
  const proxyIn = qs("imd-proxy-input");
  const save = qs("imd-save-btn");
  const clear = qs("imd-clear-btn");
  if (keyIn) keyIn.value = localStorage.getItem(STORAGE_IMD_KEY) || "";
  if (proxyIn) proxyIn.value = localStorage.getItem(STORAGE_IMD_PROXY) || "";
  save?.addEventListener("click", () => {
    localStorage.setItem(STORAGE_IMD_KEY, (keyIn?.value || "").trim());
    localStorage.setItem(STORAGE_IMD_PROXY, (proxyIn?.value || "").trim());
    loadWeather().catch(console.error);
  });
  clear?.addEventListener("click", () => {
    localStorage.removeItem(STORAGE_IMD_KEY);
    localStorage.removeItem(STORAGE_IMD_PROXY);
    if (keyIn) keyIn.value = "";
    if (proxyIn) proxyIn.value = "";
    loadWeather().catch(console.error);
  });
}

async function renderWeatherForLoc(loc) {
  lastWeatherLoc = loc;
  setLocationLines(loc);

  const hasImdCreds =
    !!(localStorage.getItem(STORAGE_IMD_KEY) || "").trim() ||
    !!(localStorage.getItem(STORAGE_IMD_PROXY) || "").trim();

  const [{ forecast, air }, imd] = await Promise.all([
    fetchOpenMeteo(loc.lat, loc.lon),
    fetchImdCityForecastLoc(loc.lat, loc.lon),
  ]);

  const imdOk = !!imd.ok;
  const imdRow = imdOk ? imd.row : null;
  const imdSeries = imdOk ? buildImdDailySeries(imdRow) : null;

  setSourceLine(imdOk, hasImdCreds, loc);

  const current = forecast.current;
  const hourly = forecast.hourly;
  const daily = forecast.daily;

  const curTemp = qs("cur-temp");
  const curDesc = qs("cur-desc");
  const curMeta = qs("cur-meta");
  const curIcon = qs("cur-icon");

  if (curTemp) curTemp.textContent = `${Math.round(current.temperature_2m)}°`;
  const imdTodayText = imdRow?.Todays_Forecast ? String(imdRow.Todays_Forecast).trim() : "";
  if (curDesc) {
    if (imdTodayText) {
      curDesc.textContent = imdTodayText;
    } else {
      curDesc.textContent = weatherDesc(current.weather_code);
    }
  }

  if (curMeta) {
    const station = imdRow?.Station_Name ? `IMD station: ${imdRow.Station_Name}` : "High-res grid at your coordinates";
    const sr = daily.sunrise?.[0] ? new Date(daily.sunrise[0]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--";
    const ss = daily.sunset?.[0] ? new Date(daily.sunset[0]).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "--";
    curMeta.textContent = `${station} · Sunrise ${sr} · Sunset ${ss}`;
  }
  if (curIcon) curIcon.innerHTML = `<i class="${weatherIcon(current.weather_code, current.is_day)}"></i>`;

  qs("cur-hum").textContent = `${Math.round(current.relative_humidity_2m)}%`;
  qs("cur-wind").textContent = `${Math.round(current.wind_speed_10m)} km/h`;
  const rainNow = Array.isArray(hourly.precipitation_probability) ? Math.round(hourly.precipitation_probability[0]) : null;
  qs("cur-rain").textContent = rainNow == null ? "--" : `${rainNow}%`;
  qs("cur-uv").textContent = `${Math.round(daily.uv_index_max?.[0] || 0)}`;

  renderHourly(hourly);
  renderDays(imdSeries, daily);

  const vis = typeof current.visibility === "number" ? (current.visibility / 1000).toFixed(1) : "--";
  qs("m-vis").textContent = `${vis}`;

  const aqH = air?.hourly || {};
  const pm25 = Array.isArray(aqH.pm2_5) ? aqH.pm2_5[0] : null;
  qs("m-pm25").textContent = pm25 == null ? "--" : `${Math.round(pm25)}`;
  const aql = pm25Label(pm25);
  const aqiLabel = qs("m-aqi-label");
  if (aqiLabel) {
    aqiLabel.textContent = aql.label;
    aqiLabel.className = `s ${aql.cls}`;
  }

  const hi = heatIndexC(current.temperature_2m, current.relative_humidity_2m);
  qs("m-heat").textContent = hi == null ? "--" : `${Math.round(hi)}°`;

  const r3 = (hourly.precipitation_probability || []).slice(0, 3).reduce((a, b) => a + (b || 0), 0) / 3;
  const soilMoisture = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        current.relative_humidity_2m * 0.45 + r3 * 0.4 + (24 - Math.min(24, current.temperature_2m)) * 1.1 - current.wind_speed_10m * 0.6,
      ),
    ),
  );
  qs("m-soil").textContent = `${soilMoisture}%`;

  renderInsights({
    current,
    daily,
    pm25,
    soilMoisture,
    rainSoon: rainNow,
    imdRow,
  });
  applyEnvironment({ weatherCode: current.weather_code, isDay: current.is_day === 1 });

  if (auth.currentUser) {
    await syncWeatherLog(auth.currentUser, loc, forecast, air, imd, soilMoisture);
    await setDoc(
      doc(db, "users", auth.currentUser.uid),
      {
        village: loc.city,
        locationDetails: {
          city: loc.city,
          district: loc.district || "",
          state: loc.state || "",
          country: loc.country || "",
          lat: loc.lat,
          lon: loc.lon,
          accuracyM: loc.accuracyM ?? null,
          source: loc.source || "gps",
        },
        updatedAt: serverTimestamp(),
      },
      { merge: true },
    );
  }
}

async function loadWeather() {
  // Show fallback data immediately so the page never looks blank.
  // Then silently upgrade when GPS resolves (within 6 s) or keep fallback.
  const fallback = { ...FALLBACK_LOC, source: "fallback" };
  renderWeatherForLoc(fallback).catch(() => {});

  try {
    const loc = await resolveWeatherLocation();
    // If we got a real GPS fix (not just the same fallback), re-render with better coords.
    if (loc.source !== "fallback" && loc.source !== "insecure-context") {
      await renderWeatherForLoc(loc);
    }
  } catch (e) {
    console.error("GPS upgrade failed:", e);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  bindImdSetup();
  qs("maps-btn")?.addEventListener("click", () => {
    const loc = lastWeatherLoc;
    if (!loc || typeof loc.lat !== "number" || typeof loc.lon !== "number") return;
    const label = [loc.city, loc.state || loc.district].filter(Boolean).join(", ") || "Weather location";
    openDeviceMaps(loc.lat, loc.lon, label);
  });
  const btn = qs("refresh-btn");
  btn?.addEventListener("click", () => loadWeather().catch(console.error));
  loadWeather().catch((e) => {
    console.error(e);
    const d = qs("cur-desc");
    if (d) d.textContent = "Unable to load weather right now";
  });
});
