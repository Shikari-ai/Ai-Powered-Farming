/**
 * Loads merged vision metadata from GET /v1/vision/metadata (YAML-backed on server).
 * Cache in-memory so UIs do not hardcode disease names or crop lists.
 */

/** @type {object | null} */
let _cache = null;
/** @type {string} */
let _cacheKey = "";

/**
 * @param {string} baseUrl Inference API base (no trailing slash)
 * @param {{ force?: boolean }} [opts]
 * @returns {Promise<object>}
 */
export async function fetchVisionMetadata(baseUrl, opts = {}) {
    const url = `${String(baseUrl || "").replace(/\/$/, "")}/v1/vision/metadata`;
    if (!url.startsWith("http")) {
        throw new Error("fetchVisionMetadata: invalid baseUrl");
    }
    if (!opts.force && _cache && _cacheKey === url) {
        return _cache;
    }
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) {
        throw new Error(`vision metadata ${res.status}`);
    }
    const data = await res.json();
    _cache = data;
    _cacheKey = url;
    return data;
}

/** Clear cache when switching inference endpoints (e.g. logout / settings). */
export function clearVisionMetadataCache() {
    _cache = null;
    _cacheKey = "";
}

/**
 * @param {object} meta Return value of fetchVisionMetadata
 * @returns {{ slug: string, label?: string }[]}
 */
export function cropsFromMetadata(meta) {
    const raw = meta && Array.isArray(meta.crops) ? meta.crops : [];
    return raw.map((c) =>
        typeof c === "string"
            ? { slug: c, label: c }
            : { slug: c.slug, label: c.label_en || c.label || c.slug },
    );
}

/**
 * @param {object} meta
 * @returns {string[]}
 */
export function classNamesFromMetadata(meta) {
    if (!meta || !Array.isArray(meta.names)) return [];
    return meta.names.map((n) => String(n));
}
