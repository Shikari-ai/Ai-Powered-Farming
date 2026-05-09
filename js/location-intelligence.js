/**
 * Location Intelligence Engine
 * GPS → Nominatim reverse-geocode → Overpass API nearby POIs → Firestore
 * 100% free stack: OpenStreetMap / Nominatim / Overpass / Firebase
 */

import { db } from "./auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

/* ─── Category definitions ──────────────────────────────────────── */
export const CATEGORIES = {
  store:    { label: "General Store",    icon: "🏪", color: "#34D399", tag: '[shop~"general|convenience|supermarket|grocery"]' },
  agri:     { label: "Agri / Fertilizer",icon: "🌾", color: "#F59E0B", tag: '[shop~"agrarian|agricultural|farm|seeds"]' },
  hospital: { label: "Medical",          icon: "🏥", color: "#F87171", tag: '[amenity~"hospital|clinic|doctors|pharmacy|health_centre"]' },
  school:   { label: "School",           icon: "🏫", color: "#60A5FA", tag: '[amenity~"school|college|university|kindergarten"]' },
  fuel:     { label: "Petrol Pump",      icon: "⛽", color: "#A78BFA", tag: '[amenity="fuel"]' },
  worship:  { label: "Temple / Mosque",  icon: "🛕", color: "#FCD34D", tag: '[amenity="place_of_worship"]' },
  market:   { label: "Market",           icon: "🛒", color: "#6EE7B7", tag: '[amenity~"marketplace|market"]' },
  water:    { label: "Water Canal",      icon: "💧", color: "#38BDF8", tag: '[waterway~"canal|stream|river|drain"]' },
  village:  { label: "Village / Town",   icon: "🏘️", color: "#C4B5FD", tag: '[place~"village|hamlet|suburb|town|neighbourhood"]' },
  road:     { label: "Main Road",        icon: "🛣️", color: "#94A3B8", tag: '[highway~"primary|secondary|trunk|tertiary"]' },
};

/* ─── Overpass API mirrors ───────────────────────────────────────── */
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
let _overpassIdx = 0;

async function fetchOverpass(query) {
  for (let i = 0; i < OVERPASS_ENDPOINTS.length; i++) {
    const url = OVERPASS_ENDPOINTS[(_overpassIdx + i) % OVERPASS_ENDPOINTS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn(`[LI] Overpass mirror ${url} failed:`, e.message);
    }
  }
  throw new Error("All Overpass mirrors failed");
}

/* ─── Haversine distance (metres) ───────────────────────────────── */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}

/* ─── Reverse geocode via Nominatim ─────────────────────────────── */
async function reverseGeocode(lat, lng) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`;
    const res  = await fetch(url, { headers: { "Accept-Language": "en", "User-Agent": "SmartAgriApp/1.0" } });
    const data = await res.json();
    const a    = data.address || {};
    return {
      displayName : data.display_name || "",
      village     : a.village || a.hamlet || a.suburb || a.neighbourhood || "",
      locality    : a.city_district || a.quarter || a.suburb || "",
      town        : a.city || a.town || a.municipality || "",
      district    : a.county || a.district || a.state_district || "",
      state       : a.state || "",
      country     : a.country || "",
      road        : a.road || a.footway || a.path || "",
      postcode    : a.postcode || "",
      raw         : a,
    };
  } catch (e) {
    console.warn("[LI] Reverse geocode failed:", e.message);
    return null;
  }
}

/* ─── Overpass nearby POI query ─────────────────────────────────── */
function buildOverpassQuery(lat, lng, radius = 2500) {
  const parts = Object.values(CATEGORIES)
    .map(c => `  node(around:${radius},${lat},${lng})${c.tag};`)
    .join("\n");
  // ways for waterways and roads (lines not just nodes)
  const ways = `
  way(around:${radius},${lat},${lng})[waterway~"canal|stream|river"];
  way(around:${radius},${lat},${lng})[highway~"primary|secondary|trunk"];`;

  return `[out:json][timeout:28];\n(\n${parts}${ways}\n);\nout body;\n>;\nout skel qt;`;
}

function resolveElementLatLng(el) {
  if (el.lat !== undefined) return { lat: el.lat, lng: el.lon };
  if (el.center) return { lat: el.center.lat, lng: el.center.lon };
  return null;
}

function classifyElement(el) {
  const t = el.tags || {};
  if (t.waterway) return "water";
  if (t.highway)  return "road";
  if (t.place)    return "village";
  if (t.amenity === "fuel") return "fuel";
  if (t.amenity === "place_of_worship") return "worship";
  if (/hospital|clinic|doctors|pharmacy|health/.test(t.amenity)) return "hospital";
  if (/school|college|university|kindergarten/.test(t.amenity)) return "school";
  if (/marketplace|market/.test(t.amenity)) return "market";
  if (/agrarian|agricultural|farm|seeds/.test(t.shop)) return "agri";
  if (/general|convenience|supermarket|grocery/.test(t.shop)) return "store";
  return "store"; // fallback
}

function elementName(el) {
  const t = el.tags || {};
  return t.name || t["name:en"] || t.ref || t.description || t.amenity || t.shop || t.waterway || t.highway || t.place || "Unnamed";
}

async function fetchNearbyPlaces(lat, lng, radius = 2500) {
  const query = buildOverpassQuery(lat, lng, radius);
  const data  = await fetchOverpass(query);
  const seen  = new Set();
  const results = [];

  for (const el of (data.elements || [])) {
    const pos = resolveElementLatLng(el);
    if (!pos) continue;
    const dist = haversine(lat, lng, pos.lat, pos.lng);
    if (dist > radius) continue;

    const name = elementName(el);
    const key  = `${name}|${el.type}|${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const cat = classifyElement(el);
    results.push({
      id       : `${el.type}/${el.id}`,
      name,
      category : cat,
      dist,
      distLabel: fmtDist(dist),
      lat      : pos.lat,
      lng      : pos.lng,
      tags     : el.tags || {},
    });
  }

  results.sort((a, b) => a.dist - b.dist);
  return results.slice(0, 40); // top 40 closest
}

/* ─── GPS: precise device coordinates ───────────────────────────── */
function getCurrentPosition(highAccuracy = true) {
  return new Promise((resolve, reject) => {
    if (!("geolocation" in navigator)) {
      reject(new Error("Geolocation not supported"));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: highAccuracy,
      timeout           : 15000,
      maximumAge        : 0,
    });
  });
}

/* ─── Firestore sync ─────────────────────────────────────────────── */
async function syncToFirestore(uid, payload) {
  try {
    const ref = doc(db, "location_intelligence", uid);
    await setDoc(ref, {
      ...payload,
      updatedAt: serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.warn("[LI] Firestore sync failed:", e.message);
  }
}

/* ─── AI insights derived from location data ──────────────────────
   Returns contextual hints for weather, pest, irrigation modules.   */
export function deriveAIInsights(address, places) {
  const hints = [];

  const hasCanal   = places.some(p => p.category === "water" && p.dist < 1000);
  const hasMarket  = places.some(p => ["store","market","agri"].includes(p.category) && p.dist < 2000);
  const nearVillage = places.find(p => p.category === "village");

  if (hasCanal) {
    hints.push({ type: "irrigation", icon: "💧", text: "Irrigation canal nearby — consider canal-based drip irrigation.", priority: "high" });
  }
  if (hasMarket) {
    hints.push({ type: "supply",     icon: "🛒", text: "Agricultural markets within 2 km — inputs are accessible.", priority: "medium" });
  }
  if (nearVillage) {
    hints.push({ type: "community",  icon: "🏘️", text: `Near ${nearVillage.name} — local cooperative resources may be available.`, priority: "low" });
  }
  if (places.some(p => p.category === "agri" && p.dist < 1500)) {
    hints.push({ type: "fertilizer", icon: "🌾", text: "Fertilizer / agri shop close by — stock before season.", priority: "high" });
  }
  return hints;
}

/* ─── Main entry point ───────────────────────────────────────────── */
let _cache = null;
let _running = false;

/**
 * Run a full location intelligence cycle.
 * @param {string}   uid       Firebase user ID (for Firestore)
 * @param {function} onUpdate  callback({ address, coords, places, insights, accuracy })
 * @param {object}   opts      { radius:2500, persist:true }
 */
export async function runLocationIntelligence(uid, onUpdate, opts = {}) {
  if (_running) return _cache;
  _running = true;

  const { radius = 2500, persist = true } = opts;
  let result = null;

  try {
    /* Phase 1 — fast IP-based approximate */
    let approxCoords = null;
    try {
      const ip = await fetch("https://ip-api.com/json/?fields=lat,lon,city,regionName,country", { signal: AbortSignal.timeout(4000) });
      const ipData = await ip.json();
      if (ipData.lat) {
        approxCoords = { lat: ipData.lat, lng: ipData.lon, accuracy: 5000, source: "ip" };
        onUpdate?.({ coords: approxCoords, address: { town: ipData.city, state: ipData.regionName }, places: [], insights: [], accuracy: 5000, phase: "approximate" });
      }
    } catch (_) {}

    /* Phase 2 — precise GPS */
    let gpsPos;
    try {
      gpsPos = await getCurrentPosition(true);
    } catch (_) {
      // Try low-accuracy fallback
      gpsPos = await getCurrentPosition(false).catch(() => null);
    }

    const coords = gpsPos
      ? { lat: gpsPos.coords.latitude, lng: gpsPos.coords.longitude, accuracy: gpsPos.coords.accuracy, source: "gps" }
      : approxCoords;

    if (!coords) throw new Error("No location available");

    /* Phase 3 — reverse geocode */
    const address = await reverseGeocode(coords.lat, coords.lng);

    /* Phase 4 — nearby POIs via Overpass */
    let places = [];
    try {
      places = await fetchNearbyPlaces(coords.lat, coords.lng, radius);
    } catch (e) {
      console.warn("[LI] Overpass fetch failed:", e.message);
    }

    /* Phase 5 — AI insights */
    const insights = deriveAIInsights(address, places);

    result = { coords, address, places, insights, accuracy: coords.accuracy, phase: "precise", timestamp: Date.now() };
    _cache = result;

    onUpdate?.(result);

    /* Phase 6 — Firestore persistence */
    if (persist && uid) {
      await syncToFirestore(uid, {
        coords    : { lat: coords.lat, lng: coords.lng, accuracy: coords.accuracy },
        address   : address || {},
        nearbyCount: places.length,
        insights  : insights.map(i => ({ type: i.type, text: i.text })),
        radius,
      });
    }
  } catch (e) {
    console.error("[LI] Location intelligence error:", e.message);
    onUpdate?.({ error: e.message, phase: "error" });
  } finally {
    _running = false;
  }
  return result;
}

export function getLastLocationData() { return _cache; }
