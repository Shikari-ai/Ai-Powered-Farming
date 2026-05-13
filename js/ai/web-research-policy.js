/**
 * When to augment internal answers with a small **public** lookup.
 * Delegates to the unified intelligence layer (confidence + gating).
 */
export {
    computeTurnConfidence,
    evaluateWebResearchGate as shouldUseWebAssistedResearch,
} from "./assistant-intelligence-layer.js?v=1";
