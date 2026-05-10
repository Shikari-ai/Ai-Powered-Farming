/**
 * Weather location: device GPS + reverse geocode, or fallback when permission/denied.
 * Uses NavIC (ISRO) automatically on compatible Android devices via enableHighAccuracy.
 */
import { NAVIC_GPS_WEATHER, detectGNSSSource } from "./navic.js";

/**
 * Pull "in Raipur", "near Mumbai" style hints for geocoding (excludes "for …" to avoid "for kharif wheat").
 * @param {string} text
 * @returns {string|null}
 */
export function extractNamedPlaceHint(text) {
  const t = String(text || "");
  const clean = (s) => {
    const place = String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.,;:!?]+$/, "");
    return place.length >= 3 ? place : null;
  };
  let m = t.match(/\b(?:in|at|near)\s+([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s,.'-]{2,52})/);
  if (m) return clean(m[1]);
  m = t.match(/\bweather\s+for\s+([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s,.'-]{2,48})/i);
  if (m) return clean(m[1]);
  return null;
}

function isPlaceHintBlocked(place) {
  const p = String(place || "").trim().toLowerCase();
  if (p.length < 3) return true;
  if (/^(home|here|there|farm|local|my\s+farm|the\s+farm|our\s+farm)$/i.test(p)) return true;
  if (/^(the\s+)?(field|fields|plot|farm)$/i.test(p)) return true;
  return false;
}

/**
 * Forward-geocode a place label (Nominatim). Prefer explicit user mentions over GPS fallback.
 * @param {string} placeLabel
 * @returns {Promise<{ lat: number, lon: number, city: string, source: string } | null>}
 */
export async function geocodePlaceName(placeLabel) {
  const raw = String(placeLabel || "").trim();
  if (!raw || isPlaceHintBlocked(raw)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);
  try {
    const queries = [`${raw}, India`, raw];
    for (const q of queries) {
      const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
        format: "json",
        limit: "1",
        q,
      })}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "SmartAgriAssistant/1.0 (https://agritech-4d1ba.web.app)",
        },
      });
      if (!res.ok) continue;
      const arr = await res.json();
      if (!Array.isArray(arr) || !arr.length) continue;
      const hit = arr[0];
      const lat = parseFloat(hit.lat);
      const lon = parseFloat(hit.lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
      let city = raw;
      if (typeof hit.name === "string" && hit.name.length > 1 && hit.name.length < 56) {
        city = hit.name;
      } else if (typeof hit.display_name === "string") {
        city = hit.display_name.split(",")[0].trim() || city;
      }
      return { lat, lon, city, source: "geocode" };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export const FALLBACK_LOC = {
  city: "Bhopal",
  district: "Bhopal",
  state: "Madhya Pradesh",
  country: "India",
  lat: 23.2599,
  lon: 77.4126,
  source: "fallback",
  accuracyM: null,
  gnssSource: null,
};

/** @deprecated Use NAVIC_GPS_WEATHER from navic.js directly */
export const GPS_OPTIONS = NAVIC_GPS_WEATHER;

export function persistLocationDetails(loc) {
  try {
    localStorage.setItem("agri_location_details", JSON.stringify(loc));
  } catch {}
}

/**
 * Browsers only allow geolocation in a “secure context” (HTTPS or other browser-defined secure origins).
 * Plain http:// on a LAN IP or hostname usually blocks GPS — not a user “denial”.
 */
export function isGeolocationSecureContext() {
  if (typeof globalThis === "undefined") return true;
  if (typeof globalThis.isSecureContext !== "boolean") return true;
  return globalThis.isSecureContext;
}

/**
 * Instant region detection via IP — no permission needed, resolves in ~0.5s.
 * Returns city-level accuracy (good enough for weather).
 */
export async function resolveLocationApprox() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(
      "https://ip-api.com/json?fields=status,city,regionName,country,lat,lon",
      { signal: controller.signal }
    );
    const d = await res.json();
    if (d.status !== "success") throw new Error("IP geo failed");
    return {
      city: d.city || d.regionName || "Your Region",
      district: d.regionName || "",
      state: d.regionName || "",
      country: d.country || "",
      lat: d.lat,
      lon: d.lon,
      source: "ip",
      accuracyM: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Fresh GPS fix + Nominatim labels, else {@link FALLBACK_LOC}. */
export async function resolveWeatherLocation() {
  try {
    localStorage.removeItem("agri_weather_loc_mode");
    localStorage.removeItem("agri_weather_place");
  } catch {}

  if (!isGeolocationSecureContext()) {
    return { ...FALLBACK_LOC, source: "insecure-context", accuracyM: null };
  }

  let gps = null;
  if ("geolocation" in navigator) {
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, NAVIC_GPS_WEATHER);
      });
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      const accuracyM = typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : null;
      gps = { lat, lon, accuracyM, gnssSource: detectGNSSSource(lat, lon, accuracyM) };
    } catch {
      /* denied / timeout */
    }
  }

  if (!gps) {
    return { ...FALLBACK_LOC, source: "fallback", accuracyM: null, gnssSource: null };
  }

  try {
    const rg = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${gps.lat}&lon=${gps.lon}&zoom=18&addressdetails=1`,
      { headers: { Accept: "application/json" } },
    );
    const data = await rg.json();
    const a = data.address || {};
    const loc = {
      city: a.city || a.town || a.village || a.county || a.suburb || "Local Area",
      district: a.state_district || a.county || "",
      state: a.state || "",
      country: a.country || "",
      lat: gps.lat,
      lon: gps.lon,
      accuracyM: gps.accuracyM,
      gnssSource: gps.gnssSource,
      source: "gps-live",
    };
    persistLocationDetails(loc);
    return loc;
  } catch {
    const loc = {
      city: "Local Area",
      district: "",
      state: "",
      country: "",
      lat: gps.lat,
      lon: gps.lon,
      accuracyM: gps.accuracyM,
      gnssSource: gps.gnssSource,
      source: "gps-live",
    };
    persistLocationDetails(loc);
    return loc;
  }
}
