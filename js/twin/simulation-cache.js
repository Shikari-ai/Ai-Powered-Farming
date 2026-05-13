/**
 * Tiny in-memory cache for deterministic twin projections (avoid recomputation on tab churn).
 * Not persisted — refreshes on full page reload.
 */
const store = new Map();
const MAX = 48;

/**
 * @param {string} key
 * @param {number} ttlMs
 * @param {() => any} factory
 */
export function getCachedTwinProjection(key, ttlMs, factory) {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;

    const value = factory();
    if (store.size >= MAX) {
        const first = store.keys().next().value;
        store.delete(first);
    }
    store.set(key, { at: now, value });
    return value;
}
