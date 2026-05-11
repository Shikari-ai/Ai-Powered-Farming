/**
 * Central “active location” for weather, AI geo hints, and cross-page consistency.
 * Persists to localStorage + Firestore `users/{uid}.activeLocation` with timestamp merge.
 */

import { auth, db } from "../auth.js?v=32";
import { doc, onSnapshot, serverTimestamp, setDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const LS_KEY = "agri_active_location_v1";
const EVENT_NAME = "agri:active-location";

/** @typedef {"manual"|"field"|"gps"} ActiveLocationSource */

/**
 * @typedef {{
 *   lat: number,
 *   lon: number,
 *   label: string,
 *   source: ActiveLocationSource|string,
 *   fieldId?: string|null,
 *   city?: string,
 *   district?: string,
 *   state?: string,
 *   country?: string,
 *   accuracyM?: number|null,
 *   gnssSource?: string|null,
 *   updatedAt: number,
 * }} ActiveLocation
 */

let cache = null;
const listeners = new Set();
let unsubRemote = null;
let remoteSyncStarted = false;

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function readLocal() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (typeof o.lat !== "number" || typeof o.lon !== "number") return null;
    if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) return null;
    cache = {
      lat: o.lat,
      lon: o.lon,
      label: String(o.label || o.city || "Saved location").trim() || "Saved location",
      source: o.source || "manual",
      fieldId: o.fieldId ?? null,
      city: o.city,
      district: o.district,
      state: o.state,
      country: o.country,
      accuracyM: o.accuracyM ?? null,
      gnssSource: o.gnssSource ?? null,
      updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
    };
    return cache;
  } catch {
    return null;
  }
}

function writeLocal(loc) {
  cache = loc;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(loc));
    localStorage.removeItem("agri_weather_loc_mode");
    localStorage.removeItem("agri_weather_place");
  } catch {}
}

function emit(loc) {
  for (const cb of listeners) {
    try {
      cb(loc);
    } catch (e) {
      console.warn("[active-location] listener:", e);
    }
  }
  try {
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: loc ? { ...loc } : null }));
  } catch {}
}

function firestorePayload(loc) {
  return {
    lat: loc.lat,
    lon: loc.lon,
    label: loc.label,
    source: loc.source,
    fieldId: loc.fieldId ?? null,
    city: loc.city ?? null,
    district: loc.district ?? null,
    state: loc.state ?? null,
    country: loc.country ?? null,
    accuracyM: loc.accuracyM ?? null,
    gnssSource: loc.gnssSource ?? null,
    updatedAt: serverTimestamp(),
    updatedAtClient: loc.updatedAt,
  };
}

/**
 * Latest active location (local cache), or null.
 * @returns {ActiveLocation|null}
 */
export function getActiveLocation() {
  return readLocal();
}

/**
 * Shape used by weather + profile merges (`locationDetails`-compatible).
 * @returns {object|null}
 */
export function peekActiveWeatherLocation() {
  const a = readLocal();
  if (!a) return null;
  const city =
    (typeof a.city === "string" && a.city.trim()) ||
    (a.label && String(a.label).split(",")[0]?.trim()) ||
    "Saved location";
  const base = {
    city,
    district: a.district || "",
    state: a.state || "",
    country: a.country || "India",
    lat: a.lat,
    lon: a.lon,
    accuracyM: a.accuracyM ?? null,
    gnssSource: a.gnssSource ?? null,
  };
  if (a.source === "field") {
    return { ...base, source: "field-anchor" };
  }
  if (a.source === "gps") {
    return { ...base, source: "gps-pinned" };
  }
  return { ...base, source: "manual-pin" };
}

/**
 * @param {object} opts
 * @param {number} opts.lat
 * @param {number} opts.lon
 * @param {string} [opts.label]
 * @param {ActiveLocationSource|string} [opts.source]
 * @param {string|null} [opts.fieldId]
 * @param {string} [opts.city]
 * @param {string} [opts.district]
 * @param {string} [opts.state]
 * @param {string} [opts.country]
 * @param {number|null} [opts.accuracyM]
 * @param {string|null} [opts.gnssSource]
 * @param {boolean} [opts.skipFirestore]
 */
export async function setActiveLocation(opts) {
  const now = Date.now();
  const lat = Number(opts.lat);
  const lon = Number(opts.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.warn("[active-location] invalid lat/lon");
    return null;
  }
  const label = String(opts.label || opts.city || "Saved location").trim() || "Saved location";
  const loc = {
    lat,
    lon,
    label,
    source: opts.source || "manual",
    fieldId: opts.fieldId ?? null,
    city: opts.city,
    district: opts.district,
    state: opts.state,
    country: opts.country,
    accuracyM: opts.accuracyM ?? null,
    gnssSource: opts.gnssSource ?? null,
    updatedAt: now,
  };
  writeLocal(loc);
  emit(getActiveLocation());

  const user = auth.currentUser;
  if (user && !opts.skipFirestore) {
    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          activeLocation: firestorePayload(loc),
          locationDetails: {
            city: loc.city || label.split(",")[0]?.trim() || label,
            district: loc.district || "",
            state: loc.state || "",
            country: loc.country || "",
            lat: loc.lat,
            lon: loc.lon,
            accuracyM: loc.accuracyM ?? null,
            source:
              loc.source === "field"
                ? "field"
                : loc.source === "gps"
                  ? "gps"
                  : "manual",
          },
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch (e) {
      console.warn("[active-location] Firestore save failed:", e?.message || e);
    }
  }
  return loc;
}

/**
 * Clear active anchor (fall back to live GPS / IP flows).
 */
export async function clearActiveLocation() {
  cache = null;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {}
  emit(null);
  const user = auth.currentUser;
  if (user) {
    try {
      await setDoc(
        doc(db, "users", user.uid),
        {
          activeLocation: null,
          updatedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch (e) {
      console.warn("[active-location] Firestore clear failed:", e?.message || e);
    }
  }
}

/**
 * @param {(loc: ActiveLocation|null) => void} cb
 * @returns {() => void}
 */
export function subscribeActiveLocation(cb) {
  listeners.add(cb);
  try {
    cb(readLocal());
  } catch (e) {
    console.warn("[active-location] subscribe callback:", e);
  }
  return () => listeners.delete(cb);
}

export const ACTIVE_LOCATION_EVENT = EVENT_NAME;

function mergeRemoteActive(userDoc) {
  const r = userDoc?.activeLocation;
  if (!r || typeof r.lat !== "number" || typeof r.lon !== "number") return;
  const remoteMs =
    tsToMs(r.updatedAt) ||
    (typeof r.updatedAtClient === "number" ? r.updatedAtClient : 0);
  const local = readLocal();
  const localMs = local?.updatedAt || 0;
  if (remoteMs > localMs) {
    const merged = {
      lat: r.lat,
      lon: r.lon,
      label: String(r.label || r.city || "Saved location"),
      source: r.source || "manual",
      fieldId: r.fieldId ?? null,
      city: r.city,
      district: r.district,
      state: r.state,
      country: r.country,
      accuracyM: r.accuracyM ?? null,
      gnssSource: r.gnssSource ?? null,
      updatedAt: remoteMs || Date.now(),
    };
    writeLocal(merged);
    emit(getActiveLocation());
  }
}

/**
 * Firestore + auth hydration for other tabs/devices. Idempotent.
 */
export function startActiveLocationRemoteSync() {
  if (remoteSyncStarted) return;
  remoteSyncStarted = true;
  onAuthStateChanged(auth, (user) => {
    if (unsubRemote) {
      unsubRemote();
      unsubRemote = null;
    }
    if (!user) return;
    unsubRemote = onSnapshot(
      doc(db, "users", user.uid),
      (snap) => mergeRemoteActive(snap.data()),
      (err) => console.warn("[active-location] snapshot:", err?.message || err),
    );
  });
}
