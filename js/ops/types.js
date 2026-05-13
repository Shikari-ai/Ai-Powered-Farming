/** Structured intervention types (extend as needed). */
export const INTERVENTION_TYPES = [
    "fungicide",
    "pesticide",
    "irrigation",
    "fertilizer",
    "pruning",
    "soil_treatment",
    "inspection",
    "harvest",
    "other",
];

/** Display labels for UI */
export const INTERVENTION_LABELS = {
    fungicide: "Fungicide application",
    pesticide: "Pesticide application",
    irrigation: "Irrigation",
    fertilizer: "Fertilizer",
    pruning: "Pruning",
    soil_treatment: "Soil treatment",
    inspection: "Manual inspection",
    harvest: "Harvest action",
    other: "Other",
};

export const TASK_PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };
