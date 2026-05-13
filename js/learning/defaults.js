/**
 * Default shapes for per-user learning / calibration state (explainable, bounded).
 */
export const LEARNING_PROFILE_VERSION = 2;

export function defaultLearningProfile(userId) {
    return {
        schemaVersion: LEARNING_PROFILE_VERSION,
        userId,
        global: {
            recommendationComfortScale: 1,
            fungalTriggerLearned: 0,
            pestTriggerLearned: 0,
            simErrorEma: 0,
            simSampleCount: 0,
            regionalStressLearnedMul: 1,
        },
        fieldStats: {},
        knowledgeEdges: [],
        timeline: [],
        auditLog: [],
        reflections: [],
        pendingTwinCheck: null,
        sandbox: { enabled: false, note: "Experimental overlays are opt-in only." },
        lastAggregatedAt: null,
        lastReason: null,
    };
}
