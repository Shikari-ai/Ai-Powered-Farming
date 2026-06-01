/**
 * One-line simulation hint for geo map narration (cheap path).
 */
import { buildDigitalTwinState } from "./twin-state.js";
import { runScenarioProjection } from "./simulation-engine.js";
import { tsToMs } from "../ai/farmer-context.js?v=34";

/**
 * @param {any} field
 * @param {any} scan latest scan or null
 * @param {any|null} wx weather log root doc data
 * @param {any|null} ctxState
 */
export function oneLineTwinHint(field, scan, wx, ctxState) {
    if (!field) return "";
    const twin = buildDigitalTwinState({
        field,
        scans: scan ? [{ ...scan, fieldId: field.id }] : [],
        ctxState,
        interventions: [],
    });
    const bundle = wx
        ? { current: wx.current || {}, daily: wx.daily || {}, hourly: wx.hourly || {} }
        : null;
    if (!bundle?.daily?.precipitation_sum) return "";

    const b = runScenarioProjection(twin, bundle, "baseline");
    const r = runScenarioProjection(twin, bundle, "continued_rain");
    const dh = Math.round((b.summary?.endHealth || 0) - (r.summary?.endHealth || 0));
    if (Math.abs(dh) < 2) {
        return `Twin sketch: simulated health paths stay near each other this week for ${field.name || "this field"} — keep routine scouting.`;
    }
    return `Twin sketch (simulated): a wetter week shaves ~${dh} pts vs baseline in the toy model for ${field.name || "this field"} — not a forecast.`;
}
