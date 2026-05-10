/**
 * Lightweight “knowledge graph” edges from scan + weather co-occurrence (deterministic, capped).
 */
import { tsToMs } from "../ai/farmer-context.js?v=34";

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

const MAX_EDGES = 24;

/**
 * @param {any[]} scans
 * @param {any|null} weatherLog latest bundle root
 * @returns {{ edges: { from: string, to: string, weight: number, count: number, kind: string }[] }}
 */
export function buildKnowledgeEdges(scans, weatherLog) {
    const now = Date.now();
    const windowMs = 120 * 86400000;
    const recent = (scans || []).filter((s) => now - tsToMs(s.createdAt) <= windowMs);
    if (!recent.length) return { edges: [] };

    const rh = weatherLog?.current?.relative_humidity_2m;
    const humid = typeof rh === "number" && rh >= 72;
    const rain0 = weatherLog?.daily?.precipitation_sum?.[0];
    const wet = typeof rain0 === "number" && rain0 >= 4;

    const tally = new Map();
    const bump = (from, to, w) => {
        const k = `${from}>${to}`;
        const cur = tally.get(k) || { from, to, acc: 0, n: 0 };
        cur.acc += w;
        cur.n += 1;
        tally.set(k, cur);
    };

    for (const s of recent) {
        const code = s.diagnosis?.code || "unknown";
        bump("scan_signal", code, 1);
        if (humid && (code === "fungal_risk" || /fungal|mildew|blight/i.test(String(s.diagnosis?.label || "")))) {
            bump("humidity_band", "fungal_risk", 1.2);
        }
        if (wet && code === "fungal_risk") {
            bump("rain_window", "fungal_risk", 1.1);
        }
        if (code === "pest_damage") {
            bump("canopy_stress", "pest_damage", 0.9);
        }
    }

    const edges = [];
    for (const v of tally.values()) {
        edges.push({
            from: v.from,
            to: v.to,
            weight: clamp(v.acc / Math.max(1, v.n), 0.2, 2.4),
            count: v.n,
            kind: "cooccurrence",
        });
    }
    edges.sort((a, b) => b.count * b.weight - a.count * a.weight);
    return { edges: edges.slice(0, MAX_EDGES) };
}
