import { getAiConfig, isLlmProxyConfigured } from "./config.js";
import { detectIntents } from "./detect-intents.js";
import { buildFarmerContext, tsToMs } from "./farmer-context.js";
import { runWeatherIntelligence } from "./engines/weather-intelligence.js";
import { runPestPrediction } from "./engines/pest-prediction.js";
import { runRecommendationEngine } from "./engines/recommendation-engine.js";
import { runYieldOutlook } from "./engines/yield-outlook.js";
import { runEnvironmentalIntelligence } from "./engines/environmental-intelligence.js";
import { resolveWeatherLocation, FALLBACK_LOC } from "../weather-location.js";
import { buildRichVisionContextBundle } from "./vision-context.js?v=34";
import { compactMemoryForBundle, buildCompanionDirectives } from "./companion-memory.js?v=35";
import { buildVisionReliability } from "./reliability/core.js";
import { getDegradedState } from "./system-health.js";
import { shallowTwinForBundle } from "../twin/assistant-twin-brief.js";

async function resolveGeoForAI(ctx) {
    const w = ctx.latestWeatherLog;
    if (w && typeof w.lat === "number" && typeof w.lon === "number") {
        return { lat: w.lat, lon: w.lon, city: w.city || "" };
    }
    try {
        const loc = await resolveWeatherLocation();
        return { lat: loc.lat, lon: loc.lon, city: loc.city || "" };
    } catch {
        return { lat: FALLBACK_LOC.lat, lon: FALLBACK_LOC.lon, city: FALLBACK_LOC.city };
    }
}

export { detectIntents } from "./detect-intents.js";

function shallowForFirestore(obj, maxDepth, d = 0) {
    if (d > maxDepth) return "[truncated]";
    if (obj == null) return obj;
    if (typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.slice(0, 12).map((x) => shallowForFirestore(x, maxDepth, d + 1));
    const o = {};
    for (const k of Object.keys(obj).slice(0, 40)) {
        o[k] = shallowForFirestore(obj[k], maxDepth, d + 1);
    }
    return o;
}

/**
 * @param {string} question
 * @param {{ userId: string, fields: any[], scans: any[], recs: any[], weatherLogs: any[], environmental?: any[] }} snapshot
 * @param {{ imageBlob?: Blob|null }} media
 */
export async function runAgriOrchestrator(question, snapshot, media = {}, opts = {}) {
    const routingMode = opts.routingMode === "weather_quick" ? "weather_quick" : "full";
    const cfg = getAiConfig();
    const ctx = buildFarmerContext(snapshot);
    const intents = detectIntents(question);
    const degraded = getDegradedState();
    const twinBrief = routingMode === "weather_quick" ? null : shallowTwinForBundle(snapshot);

    const geo = await resolveGeoForAI(ctx);

    let weatherIntel = null;
    let visionIntel = null;

    try {
        weatherIntel = await runWeatherIntelligence(ctx, geo);
    } catch (e) {
        weatherIntel = {
            engine: "weather_intelligence",
            error: true,
            message: `Weather intelligence unavailable: ${e.message}`,
        };
    }

    const wxReadings =
        weatherIntel && !weatherIntel.error && weatherIntel.readings
            ? weatherIntel.readings
            : {
                  temperatureC: ctx.latestWeatherLog?.current?.temperature_2m ?? null,
                  humidityPct: ctx.latestWeatherLog?.current?.relative_humidity_2m ?? null,
                  rainTodayMm: null,
                  rainTomorrowMm: null,
              };

    const pestIntel = runPestPrediction(ctx, {
        temperatureC: wxReadings.temperatureC,
        humidityPct: wxReadings.humidityPct,
        rainTodayMm: wxReadings.rainTodayMm,
        rainTomorrowMm: wxReadings.rainTomorrowMm,
    });

    const envIntel =
        routingMode === "weather_quick"
            ? { engine: "environmental", version: 1, summary: "", sensorDocCount: 0, _skippedForQuick: true }
            : runEnvironmentalIntelligence(ctx, wxReadings);

    const lp = snapshot.learningProfile || null;
    const reflectionLines =
        routingMode === "weather_quick"
            ? []
            : (() => {
                  const r = lp?.reflections;
                  if (!Array.isArray(r)) return [];
                  return r
                      .map((x) => (typeof x === "string" ? x : x && typeof x.text === "string" ? x.text : ""))
                      .map((s) => String(s).trim())
                      .filter(Boolean)
                      .slice(0, 3);
              })();
    const learningNarrative = reflectionLines.join("\n").trim();
    const knowledgeLearning =
        routingMode === "weather_quick"
            ? null
            : (() => {
                  if (!lp || typeof lp !== "object") return null;
                  const g = lp.global || {};
                  const keys = [];
                  for (const k of [
                      "recommendationComfortScale",
                      "fungalTriggerLearned",
                      "pestTriggerLearned",
                      "simErrorEma",
                      "regionalStressLearnedMul",
                  ]) {
                      if (typeof g[k] === "number") keys.push(k);
                  }
                  const edges = lp.knowledgeEdges;
                  const edgeCount = Array.isArray(edges) ? edges.length : 0;
                  return {
                      globalCalKeys: keys,
                      edgeCount,
                      lastAggregatedAtMs: lp.lastAggregatedAt ? tsToMs(lp.lastAggregatedAt) : null,
                      lastReason: typeof lp.lastReason === "string" ? lp.lastReason : null,
                  };
              })();

    const recIntel =
        routingMode === "weather_quick"
            ? { actions: [], quickWeatherMode: true }
            : runRecommendationEngine(ctx, { weatherIntel, pestIntel, degraded }, lp);

    const yieldIntel =
        routingMode === "weather_quick" ? { status: "skipped", message: null, outlook: null } : runYieldOutlook(ctx);

    if (media.imageBlob && cfg.inferenceBaseUrl) {
        try {
            const { analyzeCropImage } = await import("./vision-client.js?v=34");
            const ctxBundle = await buildRichVisionContextBundle({
                fieldContextStates: snapshot.fieldContextStates || [],
                scans: snapshot.scans || [],
                fields: snapshot.fields || [],
                climateProfile: snapshot.climateProfile || null,
            });
            const vi = await analyzeCropImage(media.imageBlob, {
                baseUrl: cfg.inferenceBaseUrl,
                contextOverride: ctxBundle,
            });
            visionIntel = {
                ...vi,
                reliability: buildVisionReliability(vi),
            };
        } catch (e) {
            visionIntel = {
                engine: "disease_vision",
                error: true,
                message: e.message,
                reliability: buildVisionReliability({ status: "error", message: e.message }),
            };
        }
    } else if (media.imageBlob) {
        visionIntel = {
            engine: "disease_vision",
            status: "unconfigured",
            message:
                "Image attached, but no inference server URL is configured (set <meta name=\"agri-inference-url\" content=\"https://your-api\"> or window.__AGRI_INFERENCE_URL__).",
            reliability: buildVisionReliability({
                status: "unconfigured",
                message: "Inference URL not configured.",
            }),
        };
    }

    let llmIntel = null;
    if (routingMode !== "weather_quick" && isLlmProxyConfigured()) {
        try {
            const { callLlmProxy } = await import("./llm-proxy.js");
            const companionBlock = snapshot.companion
                ? {
                      memory: compactMemoryForBundle(snapshot.companion),
                      directives: buildCompanionDirectives(snapshot.companion, snapshot.locale || "en"),
                  }
                : null;
            llmIntel = await callLlmProxy({
                question,
                locale: snapshot.locale || "en",
                bundle: shallowForFirestore(
                    {
                        intents,
                        weatherIntel,
                        pestIntel,
                        envIntel,
                        recIntel,
                        yieldIntel,
                        visionIntel,
                        companion: companionBlock,
                        regionalNetworkBrief: snapshot.regionalBriefing
                            ? String(snapshot.regionalBriefing).slice(0, 1400)
                            : null,
                        degradedMode: degraded.degraded,
                        degradedReasons: degraded.reasons,
                        reliabilityPolicy:
                            "Only cite facts present in evidenceBundle. Label observed vs inferred vs predicted. " +
                            "Never guarantee outcomes. If evidence is weak, say so and recommend field verification. " +
                            "Avoid catastrophic or panic language. Never imply autonomous field execution—you advise only; " +
                            "humans apply treatments.",
                        farmOperations: shallowForFirestore(
                            {
                                openTasks: (snapshot.operationalTasks || [])
                                    .filter((t) => t.status === "open")
                                    .slice(0, 8)
                                    .map((t) => ({
                                        title: String(t.title || "").slice(0, 140),
                                        priority: t.priority || "normal",
                                        fieldId: t.fieldId || null,
                                    })),
                                recentInterventions: (snapshot.interventions || []).slice(0, 6).map((i) => ({
                                    type: i.interventionType,
                                    fieldId: i.fieldId,
                                    performedAtMs: tsToMs(i.performedAt),
                                })),
                                unreadAlerts: (snapshot.alerts || []).filter((a) => !a.readAt).length,
                            },
                            3,
                        ),
                        digitalTwin: shallowForFirestore(twinBrief, 3),
                        knowledgeLearning: knowledgeLearning ? shallowForFirestore(knowledgeLearning, 2) : null,
                        learningNarrativePreview: learningNarrative ? String(learningNarrative).slice(0, 900) : null,
                    },
                    4
                ),
            });
        } catch (e) {
            llmIntel = { engine: "llm", error: true, message: e.message };
        }
    }

    return {
        enginePackVersion: cfg.enginePackVersion,
        intents,
        geo,
        degradedHints: degraded.hints,
        degradedReasons: degraded.reasons,
        weatherFresh01: degraded.weatherFresh01,
        results: {
            weatherIntelligence: weatherIntel,
            pestPrediction: pestIntel,
            environmental: envIntel,
            recommendations: recIntel,
            yieldOutlook: yieldIntel,
            diseaseVision: visionIntel,
            llm: llmIntel,
        },
        twinBrief,
        learningNarrative,
        knowledgeLearning,
        routingMode,
        persistedPreview: shallowForFirestore(
            {
                intents,
                weatherSummary: weatherIntel?.readings || null,
                pest: { index: pestIntel.pestPressureIndex, label: pestIntel.riskLabel },
                yieldStatus: yieldIntel.status,
                reliability: visionIntel?.reliability || null,
                degraded: degraded.degraded,
            },
            3
        ),
    };
}

export { shallowForFirestore };
