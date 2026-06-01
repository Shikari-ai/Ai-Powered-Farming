/**
 * Entity sync helpers — deterministic IDs, weather-driven alerts, no fake payloads.
 * Used by weather page, scanner, and dashboard-oriented writers.
 */
import {
  doc,
  setDoc,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/** Stable id for merged crop health rows (one active row per user + field + crop type). */
export function cropHealthDocId(userId, fieldId, cropType) {
  const fid = (fieldId && String(fieldId)) || "unassigned";
  const c = String(cropType || "crop")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .slice(0, 48);
  const raw = `${userId}_${fid}_${c}`;
  return raw.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 450);
}

/**
 * Upsert at-most-once-per-day severe weather alerts from real forecast fields.
 * @param {import("firebase/firestore").Firestore} db
 */
export async function syncWeatherDerivedAlerts(db, userId, payload) {
  if (!userId || !payload) return;
  const dayKey = new Date().toISOString().slice(0, 10);
  const { current, today, nextHours } = payload;

  const alerts = [];

  const pop = Array.isArray(nextHours)
    ? nextHours.map((h) => h?.precipProb).filter((v) => typeof v === "number")
    : [];
  const maxPop = pop.length ? Math.max(...pop) : null;

  const tMax = typeof today?.tMax === "number" ? today.tMax : null;
  const imdTxt = (today?.imdForecast && String(today.imdForecast)) || "";
  const lowImd = imdTxt.toLowerCase();
  const code = typeof current?.weather_code === "number" ? current.weather_code : null;

  if (maxPop !== null && maxPop >= 70) {
    alerts.push({
      key: "heavy_rain_risk",
      severity: "warn",
      title: "Heavy rain risk",
      body: `Hourly model shows up to ${maxPop}% precipitation probability. Plan drainage and spraying windows.`,
      type: "weather_rain",
    });
  }

  if (/heavy rain|very heavy|extremely heavy/.test(lowImd)) {
    alerts.push({
      key: "imd_heavy_rain",
      severity: "high",
      title: "IMD heavy rainfall signal",
      body: imdTxt || "IMD forecast indicates heavy rainfall in your district cluster.",
      type: "weather_imd",
    });
  }

  if (tMax !== null && tMax >= 38) {
    alerts.push({
      key: "heat_stress",
      severity: "warn",
      title: "Heat stress watch",
      body: `Daytime peak around ${tMax}°C may stress sensitive crops. Increase irrigation checks.`,
      type: "weather_heat",
    });
  }

  if (code != null && code >= 95) {
    alerts.push({
      key: "thunderstorm",
      severity: "warn",
      title: "Thunderstorm risk",
      body: "Convective activity in the grid window. Secure field equipment and delay chemical spray.",
      type: "weather_storm",
    });
  }

  for (const a of alerts) {
    const id = `${userId}_wx_${a.key}_${dayKey}`.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 450);
    await setDoc(
      doc(db, "alerts", id),
      {
        userId,
        severity: a.severity,
        title: a.title,
        body: a.body,
        type: a.type,
        readAt: null,
        source: "weather_pipeline",
        createdAt: serverTimestamp(),
        dayKey,
        schemaVersion: 1,
      },
      { merge: true },
    );
  }
}
