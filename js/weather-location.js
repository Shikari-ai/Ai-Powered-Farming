/**
 * Weather location: device GPS + reverse geocode, or fallback when permission/denied.
 */

export const FALLBACK_LOC = {
  city: "Bhopal",
  district: "Bhopal",
  state: "Madhya Pradesh",
  country: "India",
  lat: 23.2599,
  lon: 77.4126,
  source: "fallback",
  accuracyM: null,
};

export const GPS_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 28000,
};

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
        navigator.geolocation.getCurrentPosition(resolve, reject, GPS_OPTIONS);
      });
      gps = {
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accuracyM: typeof pos.coords.accuracy === "number" ? pos.coords.accuracy : null,
      };
    } catch {
      /* denied / timeout */
    }
  }

  if (!gps) {
    return { ...FALLBACK_LOC, source: "fallback", accuracyM: null };
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
      source: "gps-live",
    };
    persistLocationDetails(loc);
    return loc;
  }
}
