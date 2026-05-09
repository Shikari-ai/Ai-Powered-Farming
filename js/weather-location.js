/**
 * Weather location: device GPS + reverse geocode, or fallback when permission/denied.
 * Uses NavIC (ISRO) automatically on compatible Android devices via enableHighAccuracy.
 */
import { NAVIC_GPS_WEATHER, detectGNSSSource } from "./navic.js";

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
 * Browsers only allow geolocation in a “secure context”: HTTPS, or http://localhost / 127.0.0.1.
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
