/**
 * Weather location: device GPS + reverse geocode, or fallback when permission/denied.
 * Uses NavIC (ISRO) automatically on compatible Android devices via enableHighAccuracy.
 */
import { NAVIC_GPS_WEATHER, detectGNSSSource } from "./navic.js";

/** Tokens that look like a place after "weather …" but are not geocodable cities. */
const WEATHER_TAIL_BLOCK = new Set(
  "today tomorrow tonight now here there please outside local home like this next again soon help me current report alert update live check last outside".split(
    /\s+/,
  ),
);

/**
 * Pull "in Raipur", "weather of Delhi", "Mumbai weather", "weather Mumbai" style hints for geocoding.
 * @param {string} text
 * @returns {string|null}
 */
export function extractNamedPlaceHint(text) {
  const t = String(text || "");
  const clean = (s) => {
    const place = String(s || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.,;:!?]+$/, "")
      .replace(/\s+(tomorrow|today|tonight|now|please)\s*$/i, "");
    return place.length >= 3 ? place : null;
  };

  let m = t.match(/\bweather\s+for\s+([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s,.'-]{2,48})/i);
  if (m) {
    const place = clean(m[1]);
    if (place && !isPlaceHintBlocked(place)) return place;
  }

  m = t.match(
    /\b(?:forecast|temperature|humidity)\s+(?:in|at|of|for)\s+([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s,.'-]{2,52})/i,
  );
  if (m) {
    const place = clean(m[1]);
    if (place && !isPlaceHintBlocked(place)) return place;
  }

  m = t.match(/\b(?:in|at|near|of)\s+([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s,.'-]{2,52})/);
  if (m) {
    const place = clean(m[1]);
    if (place && !/\bweather\b/i.test(place) && !isPlaceHintBlocked(place)) return place;
  }

  m = t.match(/\bfor\s+([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s,.'-]{2,48})\s*,?\s*(?:weather|forecast|temperature)\b/i);
  if (m) {
    const place = clean(m[1]);
    if (place && !isPlaceHintBlocked(place)) return place;
  }

  m = t.match(
    /\b([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f]{0,29}(?:\s+[A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f]{0,29}){0,2})\s+(?:weather|forecast)\b/i,
  );
  if (m) {
    const place = clean(m[1]);
    const head = place ? place.split(/\s+/)[0].toLowerCase() : "";
    if (place && !isPlaceHintBlocked(place) && !WEATHER_TAIL_BLOCK.has(head)) return place;
  }

  m = t.match(/\bweather\s+([A-Za-z\u00C0-\u024f][A-Za-z\u00C0-\u024f\s,.'-]{2,48})(?:\s*[\?!.,]|$)/i);
  if (m) {
    const place = clean(m[1]);
    const head = place ? place.split(/\s+/)[0].toLowerCase() : "";
    if (place && !isPlaceHintBlocked(place) && !WEATHER_TAIL_BLOCK.has(head)) return place;
  }

  return null;
}

/**
 * Named place suitable for geocode + weather routing (not "here" / "the farm").
 * @param {string} text
 * @returns {string|null}
 */
export function getNamedPlaceHintOrNull(text) {
  const h = extractNamedPlaceHint(text);
  if (!h || isPlaceHintBlocked(h)) return null;
  return h;
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
    // Try the bare name first. "Tokyo, India" force-fuzzes to "Takyo" (an
    // actual Indian village) and the user sees their city silently swapped.
    // Only fall back to the India-biased query if the bare query found nothing.
    const queries = [raw, `${raw}, India`];
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
      // Prefer the user's typed name when the result is a fuzzy / partial
      // match — protects "Tokyo" from being renamed by OSM's first segment.
      let city = raw;
      if (typeof hit.display_name === "string") {
        const first = hit.display_name.split(",")[0].trim();
        const rawLower = raw.toLowerCase();
        const firstLower = first.toLowerCase();
        // Use OSM label only if it shares ≥3 leading chars with the user's
        // typed city, or matches case-insensitively. Otherwise keep the user's.
        if (firstLower === rawLower || firstLower.startsWith(rawLower.slice(0, 3))) {
          city = first || raw;
        }
      } else if (typeof hit.name === "string" && hit.name.length > 1 && hit.name.length < 56) {
        city = hit.name;
      }
      return { lat, lon, city, source: "geocode" };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Multiple forward-geocode hits (Nominatim) for in-app search.
 * @param {string} placeLabel
 * @param {number} [limit]
 */
export async function searchPlacesNominatim(placeLabel, limit = 8) {
  const raw = String(placeLabel || "").trim();
  if (raw.length < 2 || isPlaceHintBlocked(raw)) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7500);
  try {
    const queries = [`${raw}, India`, raw];
    for (const q of queries) {
      const url = `https://nominatim.openstreetmap.org/search?${new URLSearchParams({
        format: "json",
        limit: String(Math.min(10, Math.max(1, limit))),
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
      const out = [];
      for (const hit of arr) {
        const lat = parseFloat(hit.lat);
        const lon = parseFloat(hit.lon);
        if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
        const shortLabel =
          typeof hit.name === "string" && hit.name.length ? hit.name : raw;
        const label =
          typeof hit.display_name === "string" && hit.display_name.length
            ? hit.display_name
            : shortLabel;
        out.push({ lat, lon, label, shortLabel });
      }
      return out;
    }
    return [];
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

/**
 * User-pinned anchor (see `geo/active-location.js`) overrides live GPS when set.
 * @returns {Promise<object>}
 */
export async function resolveWeatherLocationRespectingPin() {
  const { peekActiveWeatherLocation } = await import("./geo/active-location.js?v=1");
  const pinned = peekActiveWeatherLocation();
  if (pinned) return pinned;
  return resolveWeatherLocation();
}
