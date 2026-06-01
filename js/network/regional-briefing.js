/**
 * Read regional cells (bounded) and produce calm, evidence-labeled summaries.
 * Cached in-memory + sessionStorage to limit reads.
 */
import {
    collection,
    doc,
    getDoc,
    getDocs,
    limit,
    query,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

import { isoWeekKey } from "./regional-privacy.js";

const mem = { week: null, text: null, at: 0 };
const TTL_MS = 8 * 60 * 1000;

function sessionCacheGet(weekKey) {
    try {
        const raw = sessionStorage.getItem(`regional_brief_${weekKey}`);
        if (!raw) return null;
        const o = JSON.parse(raw);
        if (Date.now() - o.at > TTL_MS) return null;
        return o.text;
    } catch {
        return null;
    }
}

function sessionCacheSet(weekKey, text) {
    try {
        sessionStorage.setItem(`regional_brief_${weekKey}`, JSON.stringify({ text, at: Date.now() }));
    } catch {
        /* quota */
    }
}

function synthesize(cells) {
    if (!cells.length) {
        return "Regional network: not enough anonymized contributions this week to describe trends. Opt in on the dashboard to help calibrate the map for everyone—your farm details stay private.";
    }
    const hiStress = cells.filter((c) => (c.stressEWMA || 0) >= 0.58).length;
    const fungal = cells.filter((c) => (c.fungalEWMA || 0) >= 0.28).length;
    const pest = cells.filter((c) => (c.pestEWMA || 0) >= 0.28).length;
    const humHigh = cells.filter(
        (c) => typeof c.humidityCoarseAvg === "number" && c.humidityCoarseAvg >= 78,
    ).length;

    const bits = [];
    bits.push(
        `Regional intelligence (inferred from anonymized grid cells, observed only at coarse scale): ${cells.length} active cells sampled.`,
    );
    if (hiStress >= 3) {
        bits.push(
            `Several cells show elevated blended stress scores (${hiStress} of ${cells.length}). This reflects fused health + humidity cues—not a confirmed outbreak map.`,
        );
    } else if (hiStress >= 1) {
        bits.push("Some cells show moderate stress elevation worth watching with local scouting.");
    }
    if (fungal >= 2) {
        bits.push("Fungal-weighted signals are clustering in multiple coarse regions—humidity timing matters; verify on the ground.");
    }
    if (pest >= 2) {
        bits.push("Pest-weighted anonymized signals are nudging upward across a few cells—consider regional scouting calendars.");
    }
    if (humHigh >= 3) {
        bits.push("Humidity proxies are high in several grid areas—resembles conditions that historically align with fungal pressure.");
    }
    if (!bits.length || bits.length === 1) {
        bits.push("Conditions appear relatively calm at network scale this snapshot—continue standard monitoring.");
    }
    bits.push("Trust: signals are aggregated; use your field intel and vision, not this alone, for treatment decisions.");
    return bits.join(" ");
}

/**
 * @param {import("firebase/firestore").Firestore} db
 * @param {string} [weekKey]
 */
export async function fetchRegionalBriefing(db, weekKey = isoWeekKey()) {
    const now = Date.now();
    if (mem.week === weekKey && mem.text && now - mem.at < TTL_MS) return mem.text;
    const sess = sessionCacheGet(weekKey);
    if (sess) {
        mem.week = weekKey;
        mem.text = sess;
        mem.at = now;
        return sess;
    }

    try {
        const snap = await getDocs(query(collection(db, "regional_index", weekKey, "cells"), limit(40)));
        const cells = [];
        snap.forEach((d) => cells.push(d.data()));
        const text = synthesize(cells);
        mem.week = weekKey;
        mem.text = text;
        mem.at = now;
        sessionCacheSet(weekKey, text);
        return text;
    } catch (e) {
        console.warn("[regional] briefing:", e?.message || e);
        return "Regional briefing unavailable (permissions or indexes). If you opted in, check Firestore rules for regional_index.";
    }
}

/**
 * For map overlay: GeoJSON FeatureCollection of cell centroids.
 */
export function cellsToGeoJsonFeatures(cellDocs) {
    return cellDocs.map((c) => ({
        type: "Feature",
        id: c.cellId,
        geometry: {
            type: "Point",
            coordinates: [c.lngBucket, c.latBucket],
        },
        properties: {
            cellId: c.cellId || "",
            stress: c.stressEWMA ?? 0,
            fungal: c.fungalEWMA ?? 0,
            pest: c.pestEWMA ?? 0,
            n: c.sampleN ?? 0,
            trust: c.trustCalibration ?? 0.5,
            scope: "inferred_regional_aggregate",
        },
    }));
}

/**
 * @param {import("firebase/firestore").Firestore} db
 */
export async function fetchRegionalCellsForMap(db, weekKey = isoWeekKey(), max = 60) {
    try {
        const snap = await getDocs(query(collection(db, "regional_index", weekKey, "cells"), limit(max)));
        const cells = [];
        snap.forEach((d) => cells.push(d.data()));
        return { type: "FeatureCollection", features: cellsToGeoJsonFeatures(cells) };
    } catch {
        return { type: "FeatureCollection", features: [] };
    }
}

/** Settings: opt-in flag per user */
export async function getRegionalOptIn(db, userId) {
    if (!userId) return false;
    try {
        const r = await getDoc(doc(db, "regional_intel_settings", userId));
        return !!(r.exists() && r.data()?.optIn === true);
    } catch {
        return false;
    }
}
