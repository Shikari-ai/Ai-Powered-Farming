/**
 * Debounced learning aggregation — never blocks camera/copilot hot paths.
 */
import { runLearningAggregation } from "./aggregator.js";

let debounceTimer = 0;
let chain = Promise.resolve();

/**
 * Schedule a merge (coalesced). Uses a micro-queue so burst events don’t parallel thrash Firestore.
 */
export function scheduleLearningRecompute(db, userId, reason = "debounced") {
    if (!db || !userId) return;
    clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
        chain = chain
            .then(() => runLearningAggregation(db, userId, reason))
            .catch((e) => console.warn("[learning]", e?.message || e));
    }, reason === "scan_saved" || reason === "intervention_logged" ? 900 : 55_000);
}

/** Immediate background queue (still async; call after scan save). */
export function queueLearningFlush(db, userId, reason) {
    if (!db || !userId) return;
    chain = chain
        .then(() => runLearningAggregation(db, userId, reason))
        .catch((e) => console.warn("[learning]", e?.message || e));
}
