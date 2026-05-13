/**
 * Satellite / EO provider abstraction — swap backends without rewiring the UI.
 *
 * Configure via <meta name="agri-sentinel-hub-instance-id" content="..."> + key server-side only,
 * or a future proxy path. Client never embeds secrets for paid APIs.
 */

export const PROVIDER_IDS = Object.freeze({
    ESRI_WORLD_IMAGERY: "esri_world_imagery",
    SENTINEL2_HUB: "sentinel2_hub",
    LANDSAT_USGS: "landsat_usgs",
    GOOGLE_EARTH_ENGINE: "google_earth_engine",
    OPENWEATHER_MAPS: "openweather_maps",
});

/**
 * @returns {{ id: string, label: string, attribution: string, basemapTileUrl?: string, notes?: string }}
 */
export function getActiveBasemapDescriptor() {
    return {
        id: PROVIDER_IDS.ESRI_WORLD_IMAGERY,
        label: "Esri World Imagery",
        attribution: "© Esri",
        basemapTileUrl: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        notes: "Observed optical mosaic; scene date varies by zoom and location.",
    };
}

function readMeta(name) {
    try {
        return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content")?.trim() || "";
    } catch {
        return "";
    }
}

/**
 * NDVI / vegetation tiles — only returns a URL when a non-secret proxy base is configured.
 * @returns {{ kind: "none" } | { kind: "tiles", tiles: string[], attribution: string, provider: string }}
 */
export function getNdviTileLayerConfig() {
    const proxy = readMeta("agri-geo-tiles-proxy");
    if (proxy) {
        const base = proxy.replace(/\/$/, "");
        return {
            kind: "tiles",
            tiles: [`${base}/ndvi/{z}/{x}/{y}.png`],
            attribution: "Vegetation index via your proxy (configure backend for Sentinel-2 / Landsat / GEE export).",
            provider: "custom_proxy",
        };
    }
    return {
        kind: "none",
        hint: "Optional: set meta agri-geo-tiles-proxy to your tile endpoint for true NDVI rasters.",
    };
}

/**
 * OpenWeather map layers (requires API key — use server proxy; never ship key in static HTML).
 */
export function getOpenWeatherLayerDescriptor(_layer) {
    return {
        kind: "unconfigured",
        message: "OpenWeather GIS layers should be proxied server-side (precipitation, pressure, etc.).",
        provider: PROVIDER_IDS.OPENWEATHER_MAPS,
    };
}

/**
 * Sentinel Hub / Copernicus — client only knows instance id for UI; tokens stay on server.
 */
export function getSentinelHubClientHints() {
    const instance = readMeta("agri-sentinel-hub-instance-id");
    return {
        configured: !!instance,
        instanceId: instance || null,
        note: "Use a small server to mint OAuth tokens and serve WMS/WMTS or png tiles to the app.",
    };
}

export function getGoogleEarthEngineHints() {
    return {
        kind: "backend",
        message: "Earth Engine exports or tile services should be exposed via your FastAPI / Cloud Run layer.",
        provider: PROVIDER_IDS.GOOGLE_EARTH_ENGINE,
    };
}
