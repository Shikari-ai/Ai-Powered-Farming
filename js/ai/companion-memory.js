/**
 * Adaptive conversational memory + personalization for the farming assistant.
 * Single Firestore doc per user (companion_profiles/{uid}) with embedded high-signal
 * episode tail — avoids extra collection reads. Voice-ready: modalities not text-only.
 */

import { tsToMs } from "./farmer-context.js?v=34";
import { computeFlowHintsForProfile, getFlowSnapshot } from "./conversation-flow.js?v=47";

const MAX_ROLLING = 520;
const MAX_TOPIC_KEYS = 18;
const MAX_LAST_TOPICS = 10;
const MAX_EPISODES = 12;
const MAX_ACK_ALERTS = 24;

/** @typedef {"unknown"|"beginner"|"intermediate"|"advanced"} ExpertiseLevel */
/** @typedef {"concise"|"balanced"|"detailed"} ExplanationStyle */
/** @typedef {"calm"|"standard"|"urgent"} AlertSensitivity */

export function defaultCompanionProfile(uid) {
    return {
        schemaVersion: 2,
        userId: uid,
        preferredLanguage: "en",
        expertiseLevel: "unknown",
        explanationStyle: "balanced",
        alertSensitivity: "standard",
        preferredCrops: [],
        frequentConcerns: {},
        fieldAffinities: {},
        lastTopics: [],
        rollingSummary: "",
        lastInteractionAt: null,
        acknowledgedAlertIds: [],
        unresolvedNotes: [],
        episodeArchive: [],
        proactiveDigest: "",
        trustNotes: [],
        voice: {
            enabled: false,
            preferredLocale: null,
            modalities: ["text"],
        },
        /** @type {{ avgUserChars?: number, bias?: string, sampleN?: number, updatedAt?: string } | null} */
        flowHints: null,
    };
}

export function normalizeCompanionProfile(raw, uid) {
    const d = defaultCompanionProfile(uid);
    if (!raw || typeof raw !== "object") return d;
    return {
        ...d,
        ...raw,
        userId: raw.userId || uid || d.userId,
        preferredLanguage: raw.preferredLanguage || d.preferredLanguage,
        expertiseLevel: raw.expertiseLevel || d.expertiseLevel,
        explanationStyle: raw.explanationStyle || d.explanationStyle,
        alertSensitivity: raw.alertSensitivity || d.alertSensitivity,
        preferredCrops: Array.isArray(raw.preferredCrops) ? raw.preferredCrops.slice(0, 12) : d.preferredCrops,
        frequentConcerns: typeof raw.frequentConcerns === "object" && raw.frequentConcerns ? raw.frequentConcerns : {},
        fieldAffinities: typeof raw.fieldAffinities === "object" && raw.fieldAffinities ? raw.fieldAffinities : {},
        lastTopics: Array.isArray(raw.lastTopics) ? raw.lastTopics.slice(0, MAX_LAST_TOPICS) : [],
        rollingSummary: typeof raw.rollingSummary === "string" ? raw.rollingSummary : "",
        acknowledgedAlertIds: Array.isArray(raw.acknowledgedAlertIds) ? raw.acknowledgedAlertIds.slice(-MAX_ACK_ALERTS) : [],
        unresolvedNotes: Array.isArray(raw.unresolvedNotes) ? raw.unresolvedNotes.slice(0, 6) : [],
        episodeArchive: Array.isArray(raw.episodeArchive) ? raw.episodeArchive.slice(-MAX_EPISODES) : [],
        proactiveDigest: typeof raw.proactiveDigest === "string" ? raw.proactiveDigest : "",
        trustNotes: Array.isArray(raw.trustNotes) ? raw.trustNotes.slice(0, 8) : [],
        voice: {
            ...d.voice,
            ...(typeof raw.voice === "object" && raw.voice ? raw.voice : {}),
            modalities: Array.isArray(raw?.voice?.modalities) ? raw.voice.modalities : d.voice.modalities,
        },
        flowHints:
            raw.flowHints && typeof raw.flowHints === "object"
                ? {
                      avgUserChars: typeof raw.flowHints.avgUserChars === "number" ? raw.flowHints.avgUserChars : undefined,
                      bias: typeof raw.flowHints.bias === "string" ? raw.flowHints.bias.slice(0, 12) : undefined,
                      sampleN: typeof raw.flowHints.sampleN === "number" ? raw.flowHints.sampleN : undefined,
                      updatedAt: typeof raw.flowHints.updatedAt === "string" ? raw.flowHints.updatedAt : undefined,
                  }
                : d.flowHints,
    };
}

function clampTopics(concerns) {
    const entries = Object.entries(concerns || {});
    if (entries.length <= MAX_TOPIC_KEYS) return Object.fromEntries(entries);
    entries.sort((a, b) => b[1] - a[1]);
    return Object.fromEntries(entries.slice(0, MAX_TOPIC_KEYS));
}

function hashHint(s) {
    let h = 0;
    const x = String(s || "").slice(0, 80);
    for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0;
    return `e_${(h >>> 0).toString(16)}`;
}

const DEVANAGARI = /[\u0900-\u097F]/;

function inferExpertise(text) {
    const t = String(text || "");
    const lower = t.toLowerCase();
    if (t.length < 12 && /\b(how do i|what is|kya|kaise)\b/i.test(lower)) return "beginner";
    if (
        /\b(ec|rhizosphere|fdc|ipm|etiolog|chemigation|vpd|dew point|latent period|systemic fungicide)\b/i.test(lower)
    )
        return "advanced";
    if (/\b(scout|spray window|triazole|strobilurin|biofungicide)\b/i.test(lower)) return "intermediate";
    return null;
}

function inferExplanationStyle(text) {
    const t = String(text || "");
    if (/\b(short|brief|quick|tl;dr|one line)\b/i.test(t)) return "concise";
    if (/\b(details?|explain|deep|technical|why)\b/i.test(t.toLowerCase())) return "detailed";
    return null;
}

function extractTopics(text) {
    const lower = String(text || "").toLowerCase();
    const topics = [];
    const add = (k) => topics.push(k);
    if (/\b(fungal|mildew|rust|blight|rot)\b/.test(lower)) add("fungal_disease");
    if (/\b(pest|aphid|thrips|borer)\b/.test(lower)) add("pest");
    if (/\b(irrigation|water stress|drip)\b/.test(lower)) add("irrigation");
    if (/\b(yellow|deficien|nutrient|n-p-k)\b/.test(lower)) add("nutrition");
    if (/\b(heat|drought|frost)\b/.test(lower)) add("weather_stress");
    if (/\b(soil|ph|ec)\b/.test(lower)) add("soil");
    return topics;
}

function matchFieldMentions(text, fields) {
    const hits = [];
    const t = String(text || "").toLowerCase();
    for (const f of fields || []) {
        const name = (f.name || "").trim().toLowerCase();
        if (name.length > 2 && t.includes(name)) hits.push(f.id);
    }
    return hits;
}

function appendRolling(prev, line) {
    const next = `${String(prev || "").trim()}\n${line}`.trim();
    return next.length > MAX_ROLLING ? next.slice(next.length - MAX_ROLLING) : next;
}

/**
 * Compact memory block for LLM proxy / engines (keep small).
 * @param {ReturnType<typeof normalizeCompanionProfile>} profile
 */
export function compactMemoryForBundle(profile) {
    if (!profile) return null;
    const ep = (profile.episodeArchive || []).slice(-5);
    return {
        preferredLanguage: profile.preferredLanguage,
        expertiseLevel: profile.expertiseLevel,
        explanationStyle: profile.explanationStyle,
        alertSensitivity: profile.alertSensitivity,
        preferredCrops: (profile.preferredCrops || []).slice(0, 6),
        lastTopics: (profile.lastTopics || []).slice(0, 6),
        rollingSummary: String(profile.rollingSummary || "").slice(-320),
        recentEpisodes: ep.map((e) => ({
            t: e.t,
            summary: String(e.summary || "").slice(0, 160),
            priority: e.priority || "normal",
        })),
        unresolved: (profile.unresolvedNotes || []).slice(0, 3),
        voice: profile.voice || { modalities: ["text"] },
        flowHints: profile.flowHints || null,
    };
}

/**
 * Instructions for the LLM: tone, language, repetition avoidance.
 */
export function buildCompanionDirectives(profile, locale) {
    const p = profile || {};
    const lang = locale || p.preferredLanguage || "en";
    const lines = [];
    lines.push(`Primary locale for this turn: ${lang}. Keep agricultural terms accurate.`);
    if (p.preferredLanguage && p.preferredLanguage !== "en") {
        lines.push(`User’s preferred language is ${p.preferredLanguage}; respond in that language when possible.`);
    }
    if (p.expertiseLevel === "beginner") {
        lines.push(
            "User behaves like a beginner: short sentences, define jargon lightly, suggest practical next steps; offer to break down visuals/scouting steps.",
        );
    } else if (p.expertiseLevel === "advanced") {
        lines.push(
            "User behaves advanced: you may discuss confidence drivers, environmental reasoning, and trade-offs succinctly.",
        );
    } else {
        lines.push("User expertise unclear: default to clear, calm explanations with optional technical detail in a second short paragraph.");
    }
    if (p.explanationStyle === "concise") {
        lines.push("Keep answers compact; lead with the decision or observation, then one short rationale.");
    } else if (p.explanationStyle === "detailed") {
        lines.push("User asked for depth: include structured reasoning and uncertainties without alarmism.");
    }
    if (p.alertSensitivity === "calm") {
        lines.push(
            "Alert tone: calm and reassuring; avoid alarmist words (‘catastrophic’, ‘disaster’). Prefer ‘elevated risk’ and early-action framing.",
        );
    } else if (p.alertSensitivity === "urgent") {
        lines.push("User prefers direct urgency when risk is high; still state uncertainty honestly.");
    } else {
        lines.push("Balanced urgency: proportional to evidence; acknowledge uncertainty when confidence is low.");
    }
    const fh = p.flowHints;
    if (fh?.bias === "concise" && (fh.sampleN || 0) >= 2) {
        lines.push(
            "Explainable habit signal: replies have trended short — lead with the takeaway; expand only when asked.",
        );
    } else if (fh?.bias === "deep" && (fh.sampleN || 0) >= 2) {
        lines.push(
            "Explainable habit signal: user messages trend longer/analytical — a bit more reasoning structure is welcome.",
        );
    }
    const lt = (p.lastTopics || []).slice(0, 4);
    if (lt.length) {
        lines.push(`Recently covered topics (avoid repeating the same boilerplate): ${lt.join(", ")}.`);
    }
    const eps = (p.episodeArchive || []).slice(-3);
    if (eps.length) {
        lines.push(
            "Recent high-signal farm context: " +
                eps.map((e) => e.summary).join(" · ").slice(0, 400),
        );
    }
    lines.push(
        "Modalities: text chat today; architecture may add voice later — keep answers speakable (short paragraphs, not markdown tables).",
    );
    return lines.join("\n");
}

function episodePriority(intents, visionOk, topics) {
    if (visionOk) return "high";
    if (intents?.disease || intents?.pest) return "high";
    if (topics.includes("fungal_disease")) return "high";
    if (topics.length) return "normal";
    return "low";
}

function buildTrustLine(orch) {
    const w = orch?.results?.weatherIntelligence;
    if (w && !w.error && w.fungalDiseasePressure?.reasons?.[0]) {
        return `Fungal pressure cue: ${w.fungalDiseasePressure.reasons[0]}`;
    }
    const p = orch?.results?.pestPrediction;
    if (p?.reasons?.[0]) return `Pest outlook cue: ${p.reasons[0]}`;
    return null;
}

/**
 * Summarize weather × field memory for proactive, conversational openers.
 */
export function buildProactiveDigest({ fields, scans, fieldContextStates, weatherLogs, recs }) {
    const lines = [];
    const wx = (weatherLogs || []).slice().sort((a, b) => tsToMs(b.fetchedAt) - tsToMs(a.fetchedAt))[0];
    const hum = wx?.current?.relative_humidity_2m;
    const t = wx?.current?.temperature_2m;
    if (typeof hum === "number" && hum >= 82) {
        lines.push(`Humidity is elevated (~${Math.round(hum)}% RH) — worth a quick scan if fungal issues bothered this block before.`);
    }
    const fcs = fieldContextStates || [];
    const stressed = fcs.filter((s) => typeof s.stabilityScore === "number" && s.stabilityScore < 0.42);
    if (stressed.length && fields?.length) {
        const fid = stressed[0].fieldId || stressed[0].id;
        const name = fields.find((x) => x.id === fid)?.name || "a field";
        lines.push(`${name} shows a more volatile intelligence signal lately — gentle increase in scouting cadence may help.`);
    }
    const latest = (scans || []).slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))[0];
    if (latest && typeof latest.healthScore === "number" && latest.healthScore >= 72) {
        lines.push(`Latest saved scan health looks firmer (${Math.round(latest.healthScore)}%) — good moment to lock in what changed if you treated recently.`);
    }
    const openRec = (recs || []).filter((r) => (r.status || "active") === "active").length;
    if (openRec >= 3) {
        lines.push(`You have several open recommendations (${openRec}) — I can help prioritize if you tell me your time budget.`);
    }
    if (!lines.length) {
        lines.push("Conditions look steady versus what we have on file — ask about any field and I’ll tie it to your saved scans and weather logs.");
    }
    return lines.slice(0, 3).join(" ");
}

/**
 * Merge learned signals after one assistant turn (in-memory profile → caller persists with setDoc merge).
 */
export function mergeCompanionAfterTurn(profile, {
    userText,
    assistantReply,
    orch,
    locale,
    fields,
    scans,
    fieldContextStates,
    weatherLogs,
    recs,
    userId,
}) {
    const uid = userId || profile?.userId || "";
    const p = normalizeCompanionProfile(profile, uid);
    const now = new Date().toISOString();
    p.lastInteractionAt = now;
    if (locale) p.preferredLanguage = locale.split("-")[0] || p.preferredLanguage;

    const ex = inferExpertise(userText);
    if (ex && p.expertiseLevel === "unknown") p.expertiseLevel = ex;
    else if (ex === "advanced" && p.expertiseLevel === "intermediate") p.expertiseLevel = "advanced";
    else if (ex === "beginner" && p.expertiseLevel === "unknown") p.expertiseLevel = "beginner";

    const st = inferExplanationStyle(userText);
    if (st) p.explanationStyle = st;

    if (/\b(don't panic|stay calm|not an emergency)\b/i.test(String(userText || ""))) p.alertSensitivity = "calm";
    if (/\b(alert me|warn|asap)\b/i.test(String(userText || "").toLowerCase())) p.alertSensitivity = "urgent";

    if (DEVANAGARI.test(String(userText || ""))) p.preferredLanguage = "hi";

    const topics = extractTopics(userText);
    const concerns = { ...p.frequentConcerns };
    for (const t of topics) concerns[t] = (concerns[t] || 0) + 1;
    p.frequentConcerns = clampTopics(concerns);

    const lt = [...new Set([...topics, ...p.lastTopics])].slice(0, MAX_LAST_TOPICS);
    p.lastTopics = lt;

    const fieldHits = matchFieldMentions(userText, fields);
    const aff = { ...p.fieldAffinities };
    for (const id of fieldHits) aff[id] = (aff[id] || 0) + 2;
    const keys = Object.keys(aff).sort((a, b) => aff[b] - aff[a]).slice(0, 12);
    p.fieldAffinities = Object.fromEntries(keys.map((k) => [k, aff[k]]));

    const crops = new Set(p.preferredCrops || []);
    for (const s of scans || []) {
        if (s.cropType) crops.add(String(s.cropType));
    }
    p.preferredCrops = [...crops].slice(0, 12);

    const briefUser = String(userText || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const briefReply = String(assistantReply || "").replace(/\s+/g, " ").trim().slice(0, 160);
    p.rollingSummary = appendRolling(p.rollingSummary, `[${now.slice(0, 10)}] Q: ${briefUser} → A: ${briefReply}`);

    const intents = orch?.intents || {};
    const visionOk = orch?.results?.diseaseVision?.status === "ok";
    const pr = episodePriority(intents, visionOk, topics);
    if (pr === "high" || topics.length >= 2) {
        const tid = hashHint(`${briefUser}|${orch?.enginePackVersion || ""}`);
        const summary = [
            visionOk ? `Vision focus: ${orch.results.diseaseVision.topHypothesis || "analysis"}` : null,
            topics.length ? `Topics: ${topics.join(", ")}` : null,
            fieldHits.length ? `Fields mentioned` : null,
        ]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 240);
        const ep = {
            id: tid,
            t: now,
            summary,
            priority: pr,
            fieldIds: fieldHits.slice(0, 4),
            topics,
        };
        const rest = (p.episodeArchive || []).filter((e) => e.id !== tid);
        rest.push(ep);
        p.episodeArchive = rest.slice(-MAX_EPISODES);
    }

    const tn = buildTrustLine(orch);
    if (tn) {
        const rest = [...(p.trustNotes || []), { t: now, note: tn }].slice(-8);
        p.trustNotes = rest;
    }

    p.proactiveDigest = buildProactiveDigest({ fields, scans, fieldContextStates, weatherLogs, recs });

    const flowSnap = getFlowSnapshot();
    const fhNext = computeFlowHintsForProfile(p, flowSnap);
    if (fhNext) p.flowHints = fhNext;

    return p;
}
