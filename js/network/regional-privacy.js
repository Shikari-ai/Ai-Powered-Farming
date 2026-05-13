/**
 * Privacy-first regional grid: coarse cells only (~0.5° ≈ 55 km; adjustable).
 * No farm ownership, boundaries, or identities in shared payloads.
 *
 * Future: federated relays can POST pulses to `window.__AGRI_REGIONAL_RELAY__`
 * (same payload shape) instead of Firestore — keep consumers agnostic.
 */

export const GRID_STEP_DEG = 0.5;

/**
 * @param {number} lat
 * @param {number} lng
 */
export function coarseCellFromLatLng(lat, lng) {
    const rLat = Math.round(lat / GRID_STEP_DEG) * GRID_STEP_DEG;
    const rLng = Math.round(lng / GRID_STEP_DEG) * GRID_STEP_DEG;
    const cellId = `c_${rLat.toFixed(2)}_${rLng.toFixed(2)}`.replace(/-/g, "m");
    return { lat: rLat, lng: rLng, cellId };
}

/** ISO-like week key: 2026-W20 */
export function isoWeekKey(d = new Date()) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    const y = t.getUTCFullYear();
    const yearStart = new Date(Date.UTC(y, 0, 1));
    const week = Math.ceil(((t - yearStart) / 86400000 + 1) / 7);
    return `${y}-W${String(week).padStart(2, "0")}`;
}

/**
 * Centroid of field polygons — then snap to coarse cell (never emit raw rings).
 * @param {{ boundary?: { coordinates?: [number,number][] } }[]} fields
 */
export function anonymizedCentroidCell(fields) {
    const list = Array.isArray(fields) ? fields : [];
    let lat = 0;
    let lng = 0;
    let n = 0;
    for (const f of list) {
        const raw = f?.boundary?.coordinates;
        if (!Array.isArray(raw) || raw.length < 3) continue;
        for (const p of raw) {
            // Accept both [lat,lng] tuples (legacy) and {lat,lng} objects (current).
            let la, ln;
            if (Array.isArray(p)) { la = p[0]; ln = p[1]; }
            else if (p && typeof p === "object") { la = p.lat; ln = p.lng; }
            if (typeof la !== "number" || typeof ln !== "number") continue;
            lat += la;
            lng += ln;
            n++;
        }
    }
    if (!n) return null;
    return coarseCellFromLatLng(lat / n, lng / n);
}

/**
 * @param {{ geo?: { lat?: number, lon?: number } }} weatherLog
 */
export function cellFromWeatherLog(weatherLog) {
    const lat = weatherLog?.geo?.lat;
    const lng = weatherLog?.geo?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") return null;
    return coarseCellFromLatLng(lat, lng);
}
