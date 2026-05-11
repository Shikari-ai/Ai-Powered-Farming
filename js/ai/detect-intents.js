/**
 * Keyword intents for orchestrator routing (no LLM).
 */
export function detectIntents(question) {
    const q = String(question || "").toLowerCase();
    return {
        weather: /\b(weather|rain|humidity|wind|irrigation|spray|frost|uv|sun)\b/.test(q),
        pest: /\b(pest|insect|larva|worm|aphid|whitefly|jassid|thrips)\b/.test(q),
        disease: /\b(disease|blight|rust|mildew|spot|fungal|rot|infection|pathogen)\b/.test(q),
        yellow: /\b(yellow|chloros|nitrogen|nutrient|deficien)\b/.test(q),
        yield: /\b(yield|harvest|ton|quintal|bushel|production)\b/.test(q),
        field: /\b(field|plot|acre|hectare)\b/.test(q),
        scan: /\b(scan|photo|image|picture|camera|leaf)\b/.test(q),
        operations: /\b(task|tasks|todo|to-do|to\s*do|intervention|interventions|alert|alerts|chore|chores)\b/.test(
            q,
        ),
    };
}
