/**
 * MapLibre helpers for geo-intelligence overlays (stress grid, spread wedge, optional NDVI tiles).
 */

import { getNdviTileLayerConfig } from "./satellite-providers.js";

const SRC_STRESS = "agri-geo-stress";
const SRC_SPREAD = "agri-geo-spread";
const LYR_STRESS = "agri-geo-stress-fill";
const LYR_STRESS_LINE = "agri-geo-stress-line";
const LYR_SPREAD = "agri-geo-spread-fill";
const SRC_NDVI = "agri-ndvi-proxy";
const LYR_NDVI = "agri-ndvi-raster";

function emptyFC() {
    return { type: "FeatureCollection", features: [] };
}

export function removeGeoIntelLayers(map) {
    if (!map?.getStyle) return;
    try {
        [LYR_STRESS, LYR_STRESS_LINE, LYR_SPREAD, LYR_NDVI].forEach((id) => {
            if (map.getLayer(id)) map.removeLayer(id);
        });
        [SRC_STRESS, SRC_SPREAD, SRC_NDVI].forEach((id) => {
            if (map.getSource(id)) map.removeSource(id);
        });
    } catch {
        /* style switching race */
    }
}

/**
 * @param {import("maplibregl").Map} map
 * @param {{ showStress?: boolean, showSpread?: boolean, showNdviTiles?: boolean }} vis
 */
export function ensureGeoIntelLayers(map, vis = {}) {
    if (!map?.addSource) return;

    if (!map.getSource(SRC_STRESS)) {
        map.addSource(SRC_STRESS, { type: "geojson", data: emptyFC() });
    }
    if (!map.getLayer(LYR_STRESS)) {
        map.addLayer({
            id: LYR_STRESS,
            type: "fill",
            source: SRC_STRESS,
            paint: {
                "fill-color": [
                    "interpolate",
                    ["linear"],
                    ["get", "stress"],
                    0,
                    "rgba(16, 185, 129, 0.12)",
                    0.45,
                    "rgba(234, 179, 8, 0.22)",
                    0.75,
                    "rgba(244, 63, 94, 0.38)",
                ],
                "fill-opacity": 0.55,
            },
        });
    }
    if (!map.getLayer(LYR_STRESS_LINE)) {
        map.addLayer({
            id: LYR_STRESS_LINE,
            type: "line",
            source: SRC_STRESS,
            paint: {
                "line-color": "rgba(34, 211, 238, 0.55)",
                "line-width": 1,
                "line-blur": 0.4,
            },
        });
    }

    if (!map.getSource(SRC_SPREAD)) {
        map.addSource(SRC_SPREAD, { type: "geojson", data: emptyFC() });
    }
    if (!map.getLayer(LYR_SPREAD)) {
        map.addLayer({
            id: LYR_SPREAD,
            type: "fill",
            source: SRC_SPREAD,
            paint: {
                "fill-color": "rgba(167, 139, 250, 0.18)",
                "fill-outline-color": "rgba(167, 139, 250, 0.55)",
            },
        });
    }

    const ndviCfg = getNdviTileLayerConfig();
    if (vis.showNdviTiles && ndviCfg.kind === "tiles" && !map.getSource(SRC_NDVI)) {
        map.addSource(SRC_NDVI, {
            type: "raster",
            tiles: ndviCfg.tiles,
            tileSize: 256,
            attribution: ndviCfg.attribution || "",
        });
        map.addLayer({
            id: LYR_NDVI,
            type: "raster",
            source: SRC_NDVI,
            paint: { "raster-opacity": 0.72, "raster-fade-duration": 300 },
        });
    }

    const stressV = vis.showStress ? "visible" : "none";
    const spreadV = vis.showSpread ? "visible" : "none";
    if (map.getLayer(LYR_STRESS)) map.setLayoutProperty(LYR_STRESS, "visibility", stressV);
    if (map.getLayer(LYR_STRESS_LINE)) map.setLayoutProperty(LYR_STRESS_LINE, "visibility", stressV);
    if (map.getLayer(LYR_SPREAD)) map.setLayoutProperty(LYR_SPREAD, "visibility", spreadV);
    if (map.getLayer(LYR_NDVI)) map.setLayoutProperty(LYR_NDVI, "visibility", vis.showNdviTiles ? "visible" : "none");
}

export function setStressGridData(map, featureCollection) {
    const src = map?.getSource?.(SRC_STRESS);
    if (src && typeof src.setData === "function") src.setData(featureCollection || emptyFC());
}

export function setSpreadData(map, feature) {
    const src = map?.getSource?.(SRC_SPREAD);
    if (src && typeof src.setData === "function") {
        src.setData(feature ? { type: "FeatureCollection", features: [feature] } : emptyFC());
    }
}

export { SRC_STRESS, SRC_SPREAD, LYR_STRESS, LYR_SPREAD };
