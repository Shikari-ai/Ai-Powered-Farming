/**
 * Client-side geo intelligence: fuses field polygons, scans, context, and weather into
 * spatial overlays. Clearly labels INFERRED vs OBSERVED in GeoJSON properties.
 */

// Boundary coords may be persisted as either [{lat,lng}, …] (current shape,
// required by Firestore which forbids nested arrays) or [[lat,lng], …]
// (legacy in-memory shape). Normalize once at read.
function normalizeCoords(coords) {
    if (!Array.isArray(coords)) return [];
    const out = [];
    for (const p of coords) {
        if (Array.isArray(p) && p.length >= 2 && typeof p[0] === "number" && typeof p[1] === "number") out.push([p[0], p[1]]);
        else if (p && typeof p === "object" && typeof p.lat === "number" && typeof p.lng === "number") out.push([p.lat, p.lng]);
    }
    return out;
}

/** @param {[number,number][]} ring [lng,lat] closed or open ring */
export function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
        if (intersect) inside = !inside;
    }
    return inside;
}

function hash01(x, y) {
    let h = x * 374761393 + y * 668265263;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * @param {object} field
 * @param {{ healthScore?: number|null, diagnosis?: { code?: string } }} scan
 * @param {{ current?: { relative_humidity_2m?: number, temperature_2m?: number } } | null} weatherLog
 * @param {{ lastTopHypothesis?: string, stabilityScore?: number } | null} fieldCtx
 */
export function computeFusionSignals(field, scan, weatherLog, fieldCtx) {
    const sig = [];
    const hum = weatherLog?.current?.relative_humidity_2m;
    const t = weatherLog?.current?.temperature_2m;
    if (typeof hum === "number" && hum >= 78) sig.push({ id: "humidity_elevated", weight: 0.22, detail: `${Math.round(hum)}% RH` });
    if (typeof t === "number" && t >= 34) sig.push({ id: "heat_elevated", weight: 0.18, detail: `${Math.round(t)}°C` });

    const hs = typeof scan?.healthScore === "number" ? scan.healthScore : null;
    if (hs != null && hs < 55) sig.push({ id: "scan_health_low", weight: 0.35, detail: `health ${hs}%` });
    else if (hs != null && hs < 72) sig.push({ id: "scan_health_moderate", weight: 0.2, detail: `health ${hs}%` });

    const code = scan?.diagnosis?.code || "";
    if (/fungal|pest|water/.test(code)) sig.push({ id: `diagnosis_${code}`, weight: 0.25, detail: code });

    if (typeof fieldCtx?.stabilityScore === "number" && fieldCtx.stabilityScore < 0.42) {
        sig.push({ id: "intel_volatile", weight: 0.15, detail: "field intelligence stability low" });
    }
    if (fieldCtx?.lastTopHypothesis) {
        sig.push({ id: "vision_focus", weight: 0.12, detail: fieldCtx.lastTopHypothesis });
    }
    if (field?.soilMoisture != null && field.soilMoisture < 28) {
        sig.push({ id: "soil_moisture_low_field", weight: 0.14, detail: `${field.soilMoisture}% recorded` });
    }
    return sig;
}

/**
 * Inferred NDVI-like vigor 0..1 (NOT observed satellite NDVI unless you attach provider tiles).
 */
export function computeNdviProxy(signals, baseHealth) {
    let ndvi = typeof baseHealth === "number" ? baseHealth / 100 : 0.58;
    for (const s of signals) {
        ndvi -= s.weight * 0.12;
    }
    ndvi += (hash01(1, signals.length) - 0.5) * 0.04;
    return Math.max(0.12, Math.min(0.95, ndvi));
}

/**
 * Build hex-ish stress grid clipped to field polygon.
 * @returns {import("geojson").FeatureCollection}
 */
export function buildStressGridGeoJson(field, scan, weatherLog, fieldCtx, options = {}) {
    const coords = normalizeCoords(field?.boundary?.coordinates);
    if (coords.length < 3) {
        return { type: "FeatureCollection", features: [] };
    }
    const ring = coords.map(([lat, lng]) => [lng, lat]);
    if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) ring.push([...ring[0]]);

    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);

    const grid = options.gridN || (typeof window !== "undefined" && window.innerWidth < 640 ? 5 : 7);
    const dlng = (maxLng - minLng) / grid;
    const dlat = (maxLat - minLat) / grid;

    const signals = computeFusionSignals(field, scan, weatherLog, fieldCtx);
    const baseHealth = typeof scan?.healthScore === "number" ? scan.healthScore : null;
    let ndviProxy = computeNdviProxy(signals, baseHealth ?? 70);
    const monthsAgo = Math.max(0, Math.min(24, Number(options.historyMonthsAgo) || 0));
    ndviProxy = Math.max(0.1, Math.min(0.98, ndviProxy + monthsAgo * 0.012));

    const features = [];
    for (let i = 0; i < grid; i++) {
        for (let j = 0; j < grid; j++) {
            const cx = minLng + (i + 0.5) * dlng;
            const cy = minLat + (j + 0.5) * dlat;
            const openRing = ring.slice(0, -1);
            if (!pointInRing(cx, cy, openRing)) continue;

            const jitter = hash01(i * 31 + j * 17, Number(field.id?.length || 0)) - 0.5;
            let stress = 0.35 + jitter * 0.2;
            for (const s of signals) stress += s.weight * (0.35 + jitter * 0.1);
            stress -= ndviProxy * 0.25;
            stress += monthsAgo * 0.012;
            stress = Math.max(0.05, Math.min(0.95, stress));

            const halfW = dlng * 0.42;
            const halfH = dlat * 0.42;
            const poly = [
                [cx - halfW, cy - halfH],
                [cx + halfW, cy - halfH],
                [cx + halfW, cy + halfH],
                [cx - halfW, cy + halfH],
                [cx - halfW, cy - halfH],
            ];

            features.push({
                type: "Feature",
                geometry: { type: "Polygon", coordinates: [poly] },
                properties: {
                    stress,
                    ndviProxy,
                    kind: "inferred_stress_cell",
                    label:
                        stress > 0.72
                            ? "Elevated stress (inferred)"
                            : stress > 0.48
                              ? "Watch zone (inferred)"
                              : "Relative calm (inferred)",
                },
            });
        }
    }

    return { type: "FeatureCollection", features };
}

export function summarizeStressGrid(fc) {
    const f = fc?.features || [];
    if (!f.length) return { meanStress: null, meanNdvi: null };
    let s = 0;
    let nv = 0;
    const n = f.length;
    for (const x of f) {
        s += x.properties?.stress || 0;
        nv += x.properties?.ndviProxy || 0;
    }
    return { meanStress: s / n, meanNdvi: nv / n };
}

export function buildGeoNarration({ fieldLabel, monthsAgo, meanStress, meanNdvi, bearing }) {
    const parts = [];
    parts.push(
        monthsAgo > 0
            ? `Timeline: ~${monthsAgo} month(s) back — synthetic mesh drift for replay (not a new satellite acquisition).`
            : "Live fusion: stress grid is inferred from polygons + your data, overlaid on observed Esri basemap.",
    );
    if (fieldLabel) parts.push(`Focus: ${fieldLabel}.`);
    if (typeof meanStress === "number") parts.push(`Mean inferred stress: ${Math.round(meanStress * 100)}%.`);
    if (typeof meanNdvi === "number") parts.push(`Mean vigor proxy (not satellite NDVI unless tile proxy is set): ${Math.round(meanNdvi * 100)}%.`);
    if (typeof bearing === "number") parts.push(`Spread cone bearing ≈ ${Math.round(bearing)}° (meteorological wind when available).`);
    parts.push("Limitation: sub-field cells are a screening model—calibrate with drone or Planet/Sentinel exports for ground truth.");
    return parts.join(" ");
}

/**
 * Wedge polygon for outbreak spread hint (inferred bearing from dominant humidity/windstress).
 * @param {object} field
 * @param {number} windDegFromNorth meteorological degrees
 */
export function buildSpreadWedgeFeature(field, windDegFromNorth = 45, options = {}) {
    const coords = normalizeCoords(field?.boundary?.coordinates);
    if (coords.length < 3) return null;
    const ring = coords.map(([lat, lng]) => [lng, lat]);
    const lngs = ring.map((p) => p[0]);
    const lats = ring.map((p) => p[1]);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const cx = (minLng + maxLng) / 2;
    const cy = (minLat + maxLat) / 2;
    const span = Math.max(maxLng - minLng, maxLat - minLat);
    const r = typeof options.reachDeg === "number" ? options.reachDeg : span * 0.55;

    const rad = ((90 - windDegFromNorth) * Math.PI) / 180;
    const arcPts = [];
    const steps = 12;
    const spread = 38;
    for (let k = 0; k <= steps; k++) {
        const ang = rad + ((k / steps - 0.5) * (spread * Math.PI)) / 180;
        arcPts.push([cx + r * 1.1 * Math.cos(ang), cy + r * 0.9 * Math.sin(ang)]);
    }
    arcPts.push([cx, cy]);

    return {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [arcPts] },
        properties: {
            kind: "inferred_spread_cone",
            bearingDeg: windDegFromNorth,
            confidence: 0.45,
            label: "Possible downwind stress corridor (inferred)",
        },
    };
}
