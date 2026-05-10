import { tsToMs } from "./farmer-context.js?v=34";
import { isLlmProxyConfigured } from "./config.js?v=65";
import { softenOverclaimProse } from "./reliability/core.js";
import { summarizeOperationsAnalytics } from "../ops/effectiveness.js";
import { INTERVENTION_LABELS } from "../ops/types.js";
import { formatShallowTwinReplyLines } from "../twin/assistant-twin-brief.js";

function pct(n) {

    if (typeof n !== "number" || Number.isNaN(n)) return "—";
    return `${Math.round(n * 100)}%`;
}

function formatAgoBrief(ms) {
    if (!ms) return "";
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
}

function knowledgeLearningReplyLines(kl) {
    if (!kl || typeof kl !== "object") return [];
    const lines = [];
    if (typeof kl.edgeCount === "number" && kl.edgeCount > 0) {
        lines.push(`Co-occurrence links distilled from recent scans: ${kl.edgeCount} (internal audit graph; not causal).`);
    }
    if (Array.isArray(kl.globalCalKeys) && kl.globalCalKeys.length) {
        lines.push(`Active calibration fields: ${kl.globalCalKeys.join(", ")}.`);
    }
    const ms = typeof kl.lastAggregatedAtMs === "number" ? kl.lastAggregatedAtMs : 0;
    if (ms) {
        lines.push(`Last learning merge: ${formatAgoBrief(ms)}${kl.lastReason ? ` (${kl.lastReason})` : ""}.`);
    }
    return lines;
}

/** @param {any} snapshot orch.snapshot after attach @param {{ compact?: boolean }} [opts] */
function buildOperationsReplyLines(snapshot, opts = {}) {
    const compact = !!opts.compact;
    if (!snapshot) return [];
    const scans = snapshot.scans || [];
    const intr = snapshot.interventions || [];
    const tasks = snapshot.operationalTasks || [];
    const alerts = snapshot.alerts || [];
    const lines = [];
    const open = tasks
        .filter((t) => t.status === "open")
        .slice()
        .sort((a, b) => {
            const order = { urgent: 0, high: 1, normal: 2, low: 3 };
            return (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
        });
    const openCap = compact ? 2 : 5;
    if (open.length) {
        lines.push(`Open tasks (${open.length}):`);
        for (const t of open.slice(0, openCap)) {
            const fieldNote = t.fieldId ? " · field-linked" : "";
            lines.push(`• ${t.priority || "normal"}: ${t.title}${fieldNote}`);
        }
    }
    const recentCap = compact ? 1 : 3;
    const recent = intr
        .slice()
        .sort((a, b) => tsToMs(b.performedAt) - tsToMs(a.performedAt))
        .slice(0, recentCap);
    if (recent.length && !compact) {
        lines.push("Recent interventions (trends from your scans are advisory, not proof a product worked):");
        for (const i of recent) {
            const lab = INTERVENTION_LABELS[i.interventionType] || i.interventionType;
            lines.push(`• ${lab} · ${formatAgoBrief(tsToMs(i.performedAt))}`);
        }
    } else if (recent.length && compact) {
        const i = recent[0];
        const lab = INTERVENTION_LABELS[i.interventionType] || i.interventionType;
        lines.push(`Latest intervention noted: ${lab} · ${formatAgoBrief(tsToMs(i.performedAt))}`);
    }
    const unread = alerts.filter((a) => !a.readAt).length;
    if (unread) {
        lines.push(compact ? `Unread alerts: ${unread}.` : `Unread alerts: ${unread} — worth a glance in the app.`);
    }
    if (!compact) {
        const analytics = summarizeOperationsAnalytics(intr, scans);
        if (analytics?.summary) lines.push(analytics.summary);
    }
    return lines;
}

function softenAlarmistProse(text, profile) {
    if (!text || !profile) return text;
    const calm = profile.alertSensitivity === "calm";
    if (!calm) return text;
    return String(text)
        .replace(/\bcritical disease detected\b/gi, "Elevated disease risk is present")
        .replace(/\bcritical disease\b/gi, "serious disease risk")
        .replace(/\bimminent disaster\b/gi, "a situation worth prompt attention")
        .replace(/\bcatastrophic\b/gi, "severe");
}

function modalityPreamble(profile) {
    const m = profile?.voice?.modalities;
    if (Array.isArray(m) && m.length && !m.includes("text")) return "";
    return "";
}

function composeMinimalAgriReply(question, orch, profile, extra = {}) {
    const q = String(question || "").trim();
    const lines = [];
    const r = orch.results || {};

    let llmText = r.llm && !r.llm.error && r.llm.text ? String(r.llm.text).trim() : "";
    llmText = softenOverclaimProse(softenAlarmistProse(llmText, profile));
    if (llmText && isLlmProxyConfigured()) {
        return llmText;
    }

    if (Array.isArray(orch.degradedHints) && orch.degradedHints.length) {
        lines.push(softenAlarmistProse("Note: " + orch.degradedHints.slice(0, 2).join(" "), profile));
    }

    if (llmText) {
        const prefix = lines.length ? `${lines.join("\n\n")}\n\n` : "";
        return softenOverclaimProse(prefix + llmText);
    }

    if (isLlmProxyConfigured()) {
        return "Could not get a reply from the AI backend. Confirm POST /v1/chat/grounded is deployed with GITHUB_TOKEN (Cloud Function secret or FastAPI .env) and reachable.";
    }

    if (r.weatherIntelligence && !r.weatherIntelligence.error) {
        const w = r.weatherIntelligence;
        const rd = w.readings || {};
        const city = orch.geo?.city || "your area";
        const t = rd.temperatureC != null ? `${Math.round(rd.temperatureC)}°C` : "—";
        const h = rd.humidityPct != null ? `${Math.round(rd.humidityPct)}% RH` : "—";
        if (extra.routingReason === "named_place_weather_needs_full_context") {
            lines.push(
                "You named a specific place — the quick readout follows your **saved farm weather anchor**, not an auto city lookup.",
            );
        }
        let one = `Quick weather (${city}): ~${t}, ${h}.`;
        if (w.fungalDiseasePressure?.label) {
            one += ` Fungal pressure: ${w.fungalDiseasePressure.label}.`;
        }
        lines.push(one);
    } else if (r.weatherIntelligence?.error) {
        lines.push("Weather didn’t refresh — try the Weather page when you’re online.");
    }

    if (r.pestPrediction?.riskLabel) {
        lines.push(`Pest outlook: ${r.pestPrediction.riskLabel}.`);
    }

    const fc = orch.snapshot?.fields?.length ?? 0;
    const sc = orch.snapshot?.scans?.length ?? 0;
    lines.push(`— ${fc} field(s), ${sc} scan(s) on file. Say “full breakdown” if you want the detailed engines.`);

    const out = lines.filter(Boolean).join("\n\n").trim();
    return softenOverclaimProse(out || "Ask a longer question when you want the full farm breakdown.");
}

/**
 * Grounded narrative from orchestrator results (deterministic prose + optional LLM preface).
 */
export function composeAssistantReply(
    question,
    orch,
    { locale: _locale = "en", companionProfile = null, replyVerbosity = "full", routingReason = "" } = {},
) {
    if (!orch) return "";
    if (replyVerbosity === "minimal") {
        return composeMinimalAgriReply(question, orch, companionProfile, { routingReason });
    }
    const compact = replyVerbosity === "compact";
    const profile = companionProfile;
    const q = String(question || "").trim();
    const lines = [];
    const { intents } = orch;
    const r = orch.results || {};

    let llmTextEarly = r.llm && !r.llm.error && r.llm.text ? String(r.llm.text).trim() : "";
    llmTextEarly = softenOverclaimProse(softenAlarmistProse(llmTextEarly, profile));
    if (llmTextEarly && isLlmProxyConfigured()) {
        return llmTextEarly;
    }

    if (profile?.expertiseLevel === "beginner" && !compact) {
        lines.push("I’ll stay practical—tell me if you want the deeper technical version.\n");
    }

    if (profile?.expertiseLevel === "beginner" && compact) {
        lines.push("Keeping this tight — say if you want the longer version.\n");
    }

    const modalityNote = modalityPreamble(profile);
    if (modalityNote) lines.push(modalityNote);

    if (Array.isArray(orch.degradedHints) && orch.degradedHints.length) {
        lines.push("Status: " + orch.degradedHints.join(" "));
        lines.push("");
    }

    let llmText = r.llm && !r.llm.error && r.llm.text ? String(r.llm.text).trim() : "";
    llmText = softenOverclaimProse(softenAlarmistProse(llmText, profile));
    if (llmText) {
        const head = lines.length ? lines.join("\n") + "\n\n" : "";
        return softenOverclaimProse(head + llmText);
    }

    if (isLlmProxyConfigured()) {
        return "Could not get a reply from the AI backend. Confirm POST /v1/chat/grounded is deployed with GITHUB_TOKEN (Cloud Function secret or FastAPI .env) and reachable.";
    }

    const epEarly = !compact && profile?.episodeArchive?.length ? profile.episodeArchive[profile.episodeArchive.length - 1] : null;
    if (epEarly?.summary && profile?.expertiseLevel !== "beginner") {
        lines.push(`Picking up from earlier: ${epEarly.summary.slice(0, 220)}`);
        lines.push("");
    }

    if (intents.disease && r.diseaseVision?.status !== "ok") {
        const latest = orch.snapshot?.scans?.[0];
        if (latest?.diagnosis?.label) {
            lines.push(
                `Symptom-based context (from your saved scan, not camera AI): **${latest.diagnosis.label}**.`
            );
            const hl = latest.observedSymptoms || latest.selectedSymptoms || [];
            if (hl.length) lines.push(`Logged symptoms: ${hl.join(", ")}.`);
            lines.push("");
        } else {
            lines.push(
                "No vision-model or saved scan diagnosis yet. Use Scanner to log symptoms, or deploy the `/v1/vision/disease` service for image labels."
            );
            lines.push("");
        }
    }

    if (r.diseaseVision?.status === "ok" && r.diseaseVision.topHypothesis) {
        const c =
            r.diseaseVision.confidence != null
                ? ` — ${Math.round(r.diseaseVision.confidence * 100) / 100} confidence (server model)`
                : "";
        lines.push(`Vision model top hypothesis: ${r.diseaseVision.topHypothesis}${c}.`);
        const visionRel = r.diseaseVision.reliability;
        if (visionRel?.confidenceLabel) {
            lines.push(
                `Reliability (calibrated): ${visionRel.confidenceLabel}. (${visionRel.primaryEpistemic || "inferred"} signal.)`,
            );
        }
        if (r.diseaseVision.explanation && !compact) lines.push(r.diseaseVision.explanation);
        const dets = r.diseaseVision.detections;
        const detLimit = compact ? 2 : profile?.expertiseLevel === "beginner" ? 3 : 6;
        if (Array.isArray(dets) && dets.length) {
            lines.push(`Bounding-box regions (${dets.length}):`);
            for (const d of dets.slice(0, detLimit)) {
                const pct = typeof d.confidence === "number" ? `${Math.round(d.confidence * 100)}%` : "—";
                const mc =
                    typeof d.model_confidence === "number"
                        ? ` (model ${Math.round(d.model_confidence * 100)}%)`
                        : "";
                lines.push(`  - ${d.label}: ${pct}${mc}`);
            }
        }
        const ci = r.diseaseVision.contextualIntel;
        if (ci && typeof ci === "object") {
            lines.push(
                `Contextual risk: **${ci.risk_tier || "n/a"}**` +
                    (ci.risk_score_0_100 != null ? ` (score ${ci.risk_score_0_100})` : "") +
                    ".",
            );
            const fac = ci.confidence_factors;
            if (Array.isArray(fac) && fac.length) {
                lines.push("Why the score adapted:");
                for (const f of fac.slice(0, compact ? 3 : 6)) lines.push(`  · ${String(f).replace(/\*\*/g, "")}`);
            }
            if (Array.isArray(ci.field_memory_snippets) && ci.field_memory_snippets.length) {
                lines.push(
                    `Field timeline cues: ${ci.field_memory_snippets.slice(0, compact ? 1 : 3).join(" ")}`,
                );
            }
        }
        const predRel = r.diseaseVision.predictionReliability;
        if (predRel && predRel.field_memory_used) {
            lines.push("(Field memory was supplied to the vision service for this answer.)");
        }
        lines.push("");
    } else if (r.diseaseVision?.status === "unconfigured") {
        lines.push(`${r.diseaseVision.message}`);
        lines.push("");
    } else if (r.diseaseVision?.status === "model_unavailable") {
        lines.push("Disease vision server is reachable but no model is loaded yet — deploy weights to enable detections.");
        lines.push("");
    }

    if (intents.yellow || q.toLowerCase().includes("yellow")) {
        const ls = orch.results?.yieldOutlook;
        const latest = orch.snapshot?.scans?.[0];
        const syms = latest?.observedSymptoms || latest?.selectedSymptoms || [];
        const hasYellow = Array.isArray(syms) && syms.includes("yellowing");
        lines.push("Yellowing interpretation:");
        if (hasYellow) {
            lines.push(
                "Your latest saved scan already tags **yellowing** — pair that with a soil test before large nitrogen applications."
            );
        } else {
            lines.push("I don’t see yellowing tagged on your latest saved scan — capture leaves in Scanner and log symptoms so advice stays specific.");
        }
        if (ls?.status === "trend_only" && ls.outlook) {
            lines.push(`Health-score trend: ${ls.outlook.trend} (recent avg ${ls.outlook.recentAvgHealth}%).`);
        }
        lines.push("");
    }

    if ((r.environmental?.sensorDocCount || 0) > 0 && !compact) {
        lines.push(`Environmental records in your account: ${r.environmental.sensorDocCount} document(s).`);
        lines.push("");
    }

    if (r.environmental?.summary && r.weatherIntelligence?.error) {
        lines.push(`Environmental: ${r.environmental.summary}`);
        lines.push("");
    }

    if (r.weatherIntelligence && !r.weatherIntelligence.error) {
        const w = r.weatherIntelligence;
        lines.push("Weather intelligence:");
        if (routingReason === "named_place_weather_needs_full_context" && !compact) {
            lines.push(
                "You asked about a named location — these readings follow your **farm’s saved weather anchor** (Open‑Meteo), not an automatic geocode of that city name.",
            );
        }
        const rd = w.readings || {};
        lines.push(
            `Live bundle @ ${orch.geo?.city || "location"}: ` +
                `${rd.temperatureC != null ? `${Math.round(rd.temperatureC)}°C` : "—"}, ` +
                `${rd.humidityPct != null ? `${Math.round(rd.humidityPct)}% RH` : "—"}.`
        );
        if (w.fungalDiseasePressure) {
            lines.push(
                `Fungal pressure: ${w.fungalDiseasePressure.label} (${pct(w.fungalDiseasePressure.score)} index).`,
            );
            if (!compact && w.fungalDiseasePressure.reasons?.[0]) lines.push(`Why: ${w.fungalDiseasePressure.reasons[0]}`);
        }
        for (const x of (w.irrigation || []).slice(0, compact ? 0 : 1)) lines.push(`Irrigation: ${x}`);
        for (const x of (w.spraying || []).slice(0, compact ? 0 : 1)) lines.push(`Spray window: ${x}`);
        lines.push("");
    } else if (r.weatherIntelligence?.error) {
        lines.push(`Weather intelligence paused: ${r.weatherIntelligence.message}`);
        lines.push("");
    }

    if (r.pestPrediction) {
        const p = r.pestPrediction;
        lines.push(
            compact
                ? `Pest outlook: ${p.riskLabel}.`
                : `Pest outlook: ${p.riskLabel} (index ${Math.round((p.pestPressureIndex || 0) * 100)}%).`,
        );
        if (!compact && p.reasons?.[0]) lines.push(`Why: ${p.reasons[0]}`);
        lines.push("");
    }

    const opsLines = buildOperationsReplyLines(orch.snapshot, { compact });
    if (opsLines.length) {
        lines.push("Farm operations (you execute all field work; I only organize and interpret signals):");
        for (const L of opsLines) lines.push(L);
        lines.push("");
    }

    const twinLines = !compact ? formatShallowTwinReplyLines(orch.twinBrief) : [];
    if (twinLines.length) {
        lines.push("Digital twin (simulated week contrast, not certainty):");
        for (const L of twinLines) lines.push(L);
        lines.push("");
    }

    const learnNar = !compact && orch.learningNarrative && String(orch.learningNarrative).trim();
    const kLines = !compact ? knowledgeLearningReplyLines(orch.knowledgeLearning) : [];
    if (learnNar || kLines.length) {
        lines.push("Learning / knowledge evolution:");
        lines.push(
            "The app maintains bounded, explainable notes from your own scan/intervention timeline — advisory only.",
        );
        if (learnNar) {
            for (const ln of learnNar.split("\n").filter(Boolean)) lines.push(`• ${ln}`);
        }
        for (const L of kLines) lines.push(`• ${L}`);
        lines.push("");
    }

    const rb = orch.snapshot?.regionalBriefing;
    if (
        rb &&
        String(rb).trim() &&
        (intents.disease || intents.pest || intents.weather || /\b(region|regional|network|outbreak)\b/i.test(q))
    ) {
        lines.push("Regional network context (anonymized coarse cells — inferred aggregates, not your exact farm):");
        lines.push(String(rb).replace(/\s+/g, " ").trim().slice(0, compact ? 420 : 900));
        lines.push("");
    }

    if (r.yieldOutlook && r.yieldOutlook.status !== "skipped") {
        const y = r.yieldOutlook;
        if (y.status === "trend_only" && y.outlook) {
            let yline = `Yield outlook (health-trend only): ${y.interpretation || y.outlook.trend}`;
            yline = softenAlarmistProse(yline, profile);
            lines.push(yline);
        } else if (y.message) {
            lines.push(softenAlarmistProse(`Yield outlook: ${y.message}`, profile));
        }
        lines.push("");
    }

    if (r.recommendations?.actions?.length) {
        lines.push("Prioritized actions:");
        const maxA = compact ? 2 : profile?.explanationStyle === "concise" ? 2 : 4;
        for (const a of r.recommendations.actions.slice(0, maxA)) {
            const c =
                typeof a.calibratedConfidence === "number" ? a.calibratedConfidence : a.confidence || 0;
            const lbl = a.confidenceLabel || "";
            lines.push(
                `• ${a.title} — ${a.reasoning} (${lbl}; reliability index ${Math.round(c * 100)}%).`,
            );
            const maxS = compact ? 1 : profile?.expertiseLevel === "beginner" ? 1 : 2;
            for (const s of (a.steps || []).slice(0, maxS)) lines.push(`  - ${s}`);
        }
        lines.push("");
    }

    const ctxLines = [];
    const fc = orch.snapshot?.fields?.length ?? 0;
    const sc = orch.snapshot?.scans?.length ?? 0;
    ctxLines.push(`Account snapshot: ${fc} field(s), ${sc} scan(s).`);

    const sortedFields = (orch.snapshot?.fieldContextStates || [])
        .map((s) => {
            const fid = s.fieldId || s.id;
            const name = (orch.snapshot?.fields || []).find((f) => f.id === fid)?.name;
            return { fid, lab: s.lastTopHypothesis || s.lastVisionLabels?.[0], name };
        })
        .filter((x) => x.lab);

    if (sortedFields.length && profile?.expertiseLevel !== "beginner" && !compact) {
        const ref = sortedFields[0];
        ctxLines.push(
            `If this reminds you of prior stress: ${ref.name || "A field"} recently showed **${ref.lab}** in your intelligence timeline — humidity and season matter for recurrence.`,
        );
    }

    const latestScan = orch.snapshot?.scans?.[0];
    if (latestScan) {
        const health = typeof latestScan.healthScore === "number" ? `${Math.round(latestScan.healthScore)}%` : "--";
        ctxLines.push(`Latest saved scan: ${latestScan.cropType || "crop"} • ${latestScan.diagnosis?.label || "logged"} • health ${health}.`);
    } else {
        ctxLines.push("No scans yet — onboarding: run Scanner once to unlock disease/pest context in this assistant.");
    }

    const fcs = orch.snapshot?.fieldContextStates;
    if (Array.isArray(fcs) && fcs.length && !compact) {
        const first = fcs[0];
        const lab = first.lastTopHypothesis || first.lastVisionLabels?.[0];
        if (lab || first.stabilityScore != null) {
            ctxLines.push(
                `Field intelligence snapshot: ${lab ? `recent focus ${lab}` : "history building"}${first.stabilityScore != null ? `; stability ~${first.stabilityScore}` : ""}.`,
            );
        }
    }

    const lastTrust = !compact && profile?.trustNotes?.length ? profile.trustNotes[profile.trustNotes.length - 1] : null;
    if (lastTrust?.note && profile?.expertiseLevel === "advanced") {
        lines.push(`Why weights shifted this turn: ${lastTrust.note}`);
        lines.push("");
    }

    lines.push(ctxLines.join("\n"));

    if (profile?.expertiseLevel === "beginner" && r.recommendations?.actions?.[0]) {
        const a0 = r.recommendations.actions[0];
        lines.push("");
        lines.push(`In plain terms: start with “${a0.title}” because ${a0.reasoning}`.slice(0, 320));
    }

    if (!llmText && lines.filter(Boolean).length < 3 && !compact) {
        lines.push(
            "\nTip: Ask about irrigation timing, spray drift risk, pest scouting, or yield trends — I route each question through the relevant farm engine.",
        );
    }

    if (!llmText && lines.filter(Boolean).length < 3 && compact) {
        lines.push("\nSay **more depth** anytime if you want the full engine pass.");
    }

    return softenOverclaimProse(lines.filter(Boolean).join("\n").trim());
}

/**
 * Attach snapshot reference for composeAssistantReply (scans array in context order).
 */
export function attachSnapshotForReply(orch, snapshot) {
    const sortedScans = (snapshot.scans || []).slice().sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
    orch.snapshot = {
        fields: snapshot.fields || [],
        scans: sortedScans,
        recs: snapshot.recs || [],
        weatherLogs: snapshot.weatherLogs || [],
        environmental: snapshot.environmental || [],
        fieldContextStates: snapshot.fieldContextStates || [],
        companion: snapshot.companion || null,
        regionalBriefing: snapshot.regionalBriefing || null,
        interventions: snapshot.interventions || [],
        operationalTasks: snapshot.operationalTasks || [],
        alerts: snapshot.alerts || [],
        learningProfile: snapshot.learningProfile || null,
    };
    return orch;
}
