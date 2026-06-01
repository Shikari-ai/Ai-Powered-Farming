/** Lightweight seasonal hints for checklists (deterministic, region-agnostic). */

const CROP_BUCKETS = {
    wheat: ["wheat"],
    rice: ["rice", "paddy"],
    maize: ["maize", "corn"],
    cotton: ["cotton"],
    generic: [],
};

function bucketCrop(crop) {
    const c = String(crop || "").toLowerCase();
    for (const [k, syns] of Object.entries(CROP_BUCKETS)) {
        if (k === "generic") continue;
        if (c.includes(k) || syns.some((s) => c.includes(s))) return k;
    }
    return "generic";
}

/**
 * @returns {{ title: string, items: string[], scope: string }}
 */
export function getSeasonalWorkflowHints(cropType, date = new Date()) {
    const m = date.getMonth();
    const bucket = bucketCrop(cropType);
    const items = [];
    let title = "Seasonal monitoring rhythm";

    if (m >= 2 && m <= 4) {
        items.push("Pre-sowing/soil prep checks: drainage, residue, baseline soil moisture scouting.");
        if (bucket === "wheat") items.push("If winter wheat: watch tillering-stage humidity for rust scouting windows.");
        if (bucket === "rice") items.push("Nursery/transplant window — align irrigation with wind-free evenings when spraying.");
    } else if (m >= 5 && m <= 8) {
        title = "Mid-season execution";
        items.push("Increase scouting cadence after heat spikes or prolonged humidity.");
        items.push("Log irrigation rounds with rough duration — helps interpret fungal pressure later.");
        if (bucket === "cotton") items.push("Square/boll window — prioritize mite/whitefly underside counts.");
    } else {
        title = "Late season & harvest prep";
        items.push("Taper nitrogen according to maturity; favor scouting over blanket sprays.");
        items.push("Capture final health scans 1–2 weeks before harvest for year-over-year baselines.");
    }

    if (items.length < 3) {
        items.push("Align treatment timing with forecast dry-windows to reduce wash-off risk.");
    }

    return {
        title,
        items: items.slice(0, 6),
        scope: "Seasonal heuristics only — adapt to your local extension guidance.",
    };
}
