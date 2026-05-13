/**
 * NavIC — ISRO Navigation with Indian Constellation
 * India's Regional Navigation Satellite System (formerly IRNSS)
 *
 * Coverage : India + ~1500 km surrounding area
 * Accuracy : ≤5 m Standard Positioning Service (SPS)
 *            ≤0.5 m Restricted Service (military / licensed)
 *
 * Compatible hardware  : Qualcomm Snapdragon 720G+, MediaTek Dimensity 7020+
 * Compatible OS        : Android 11+ on NavIC-capable device
 *
 * How it works in a browser
 * ─────────────────────────
 * The Web Geolocation API (`navigator.geolocation`) does not expose which
 * GNSS constellation the device is using. However, when `enableHighAccuracy`
 * is set to `true`, the OS location stack automatically leverages NavIC on
 * compatible hardware inside the coverage region. We detect NavIC usage
 * heuristically: NavIC region + reported accuracy ≤ 5 m → NavIC SPS lock.
 */

/**
 * Extended NavIC coverage bounding box (India + 1500 km buffer).
 * Primary coverage: lat 8–37, lng 68–97 (India mainland).
 */
export const NAVIC_BOUNDS = {
  latMin: -5,
  latMax: 50,
  lngMin: 50,
  lngMax: 120,
};

/** Returns true if the coordinate falls inside NavIC coverage. */
export function isInNavICRegion(lat, lng) {
  return (
    lat >= NAVIC_BOUNDS.latMin && lat <= NAVIC_BOUNDS.latMax &&
    lng >= NAVIC_BOUNDS.lngMin && lng <= NAVIC_BOUNDS.lngMax
  );
}

/**
 * Heuristic GNSS source label.
 *   NavIC · Precise → ≤5 m accuracy in NavIC region (SPS lock confirmed)
 *   NavIC + GPS     → ≤15 m, likely multi-constellation
 *   NavIC / GPS     → in coverage area but accuracy unknown
 *   GPS             → outside NavIC coverage
 *
 * @param {number}      lat
 * @param {number}      lng
 * @param {number|null} accuracyM  — metres from `pos.coords.accuracy`
 * @returns {string}
 */
export function detectGNSSSource(lat, lng, accuracyM) {
  if (!isInNavICRegion(lat, lng)) return "GPS";
  if (accuracyM !== null && accuracyM <= 5)  return "NavIC · Precise";
  if (accuracyM !== null && accuracyM <= 15) return "NavIC + GPS";
  return "NavIC / GPS";
}

/**
 * GPS options that allow the OS to use NavIC.
 * `enableHighAccuracy: true` is mandatory — without it the OS may bypass NavIC.
 * A 14 s timeout accommodates a cold-start NavIC fix.
 */
export const NAVIC_GPS_OPTIONS = {
  enableHighAccuracy: true,
  timeout           : 14000,
  maximumAge        : 0,
};

/**
 * Faster GPS options (weather / background use): allows cached fix up to 60 s.
 * Still keeps `enableHighAccuracy: true` so NavIC is active on capable devices.
 */
export const NAVIC_GPS_WEATHER = {
  enableHighAccuracy: true,
  timeout           : 8000,
  maximumAge        : 60000,
};

/**
 * Returns an inline HTML badge string for use in UI elements.
 *
 * NavIC (any variant) → orange "ISRO · NavIC" badge
 * GPS                 → plain grey "GPS" badge
 *
 * @param {string} source  — from detectGNSSSource()
 * @returns {string}
 */
export function navicBadgeHTML(source) {
  if (!source || !source.startsWith("NavIC")) {
    return `<span class="gnss-badge gnss-gps">GPS</span>`;
  }
  const precise = source === "NavIC · Precise";
  return `<span class="gnss-badge gnss-navic${precise ? " gnss-navic-precise" : ""}">
    <span class="gnss-isro-dot"></span><span class="gnss-isro">ISRO</span>\u00a0NavIC
  </span>`;
}
