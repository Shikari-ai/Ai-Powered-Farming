/**
 * MapLibre layers for anonymized regional intelligence (heatmap + soft glow).
 * Inserts below field polygons when `beforeId` is `field-fills`.
 */

const SRC = "regional-intel-src";
const HEAT = "regional-intel-heat";
const GLOW = "regional-intel-glow";

/**
 * @param {import("maplibre-gl").Map} map
 * @param {string} [beforeId]
 */
export function ensureRegionalMapLayers(map, beforeId = "field-fills") {
  if (!map || map.getSource(SRC)) return;

  map.addSource(SRC, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  const insertBefore = map.getLayer(beforeId) ? beforeId : undefined;

  map.addLayer(
    {
      id: HEAT,
      type: "heatmap",
      source: SRC,
      maxzoom: 16,
      layout: { visibility: "none" },
      paint: {
        "heatmap-weight": ["interpolate", ["linear"], ["get", "stress"], 0, 0, 1, 1],
        "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 6, 0.6, 12, 1.8],
        "heatmap-color": [
          "interpolate",
          ["linear"],
          ["heatmap-density"],
          0,
          "rgba(6,182,212,0)",
          0.15,
          "rgba(34,211,238,0.15)",
          0.45,
          "rgba(245,158,11,0.35)",
          1,
          "rgba(248,113,113,0.55)",
        ],
        "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 4, 12, 14, 48],
        "heatmap-opacity": 0.88,
      },
    },
    insertBefore,
  );

  map.addLayer(
    {
      id: GLOW,
      type: "circle",
      source: SRC,
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 10, 12, 28],
        "circle-color": [
          "interpolate",
          ["linear"],
          ["get", "stress"],
          0,
          "#22d3ee",
          0.45,
          "#fbbf24",
          1,
          "#f87171",
        ],
        "circle-opacity": 0.4,
        "circle-blur": 0.85,
        "circle-stroke-width": 1,
        "circle-stroke-color": "rgba(34,211,238,0.45)",
      },
    },
    insertBefore,
  );
}

/**
 * @param {import("maplibre-gl").Map} map
 * @param {GeoJSON.FeatureCollection} fc
 */
export function setRegionalMapData(map, fc) {
  const src = map?.getSource?.(SRC);
  if (src && typeof src.setData === "function") {
    src.setData(fc || { type: "FeatureCollection", features: [] });
  }
}

/**
 * @param {import("maplibre-gl").Map} map
 * @param {boolean} show
 */
export function setRegionalMapVisible(map, show) {
  if (!map?.getLayer) return;
  const vis = show ? "visible" : "none";
  if (map.getLayer(HEAT)) map.setLayoutProperty(HEAT, "visibility", vis);
  if (map.getLayer(GLOW)) map.setLayoutProperty(GLOW, "visibility", vis);
}
