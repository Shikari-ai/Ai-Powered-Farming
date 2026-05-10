import { tsToMs } from "./farmer-context.js";

function pct(n) {
    if (typeof n !== "number" || Number.isNaN(n)) return "—";
    return `${Math.round(n * 100)}%`;
}

/**
 * Grounded narrative from orchestrator results (deterministic prose + optional LLM preface).
 */
export function composeAssistantReply(question, orch, { locale: _locale = "en" } = {}) {
    const q = String(question || "").trim();
    const lines = [];
    const { intents } = orch;
    const r = orch.results || {};

    const llmText = r.llm && !r.llm.error && r.llm.text ? String(r.llm.text).trim() : "";
    if (llmText) {
        lines.push(llmText);
        lines.push("");
        lines.push("— Grounded engine summary (verified inputs) —");
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
        if (r.diseaseVision.explanation) lines.push(r.diseaseVision.explanation);
        const dets = r.diseaseVision.detections;
        if (Array.isArray(dets) && dets.length) {
            lines.push(`Bounding-box regions (${dets.length}):`);
            for (const d of dets.slice(0, 6)) {
                const pct = typeof d.confidence === "number" ? `${Math.round(d.confidence * 100)}%` : "—";
                lines.push(`  - ${d.label}: ${pct}`);
            }
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

    if ((r.environmental?.sensorDocCount || 0) > 0) {
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
        const rd = w.readings || {};
        lines.push(
            `Live bundle @ ${orch.geo?.city || "location"}: ` +
                `${rd.temperatureC != null ? `${Math.round(rd.temperatureC)}°C` : "—"}, ` +
                `${rd.humidityPct != null ? `${Math.round(rd.humidityPct)}% RH` : "—"}.`
        );
        if (w.fungalDiseasePressure) {
            lines.push(
                `Fungal pressure: ${w.fungalDiseasePressure.label} (${pct(w.fungalDiseasePressure.score)} index).`
            );
            if (w.fungalDiseasePressure.reasons?.[0]) lines.push(`Why: ${w.fungalDiseasePressure.reasons[0]}`);
        }
        for (const x of (w.irrigation || []).slice(0, 1)) lines.push(`Irrigation: ${x}`);
        for (const x of (w.spraying || []).slice(0, 1)) lines.push(`Spray window: ${x}`);
        lines.push("");
    } else if (r.weatherIntelligence?.error) {
        lines.push(`Weather intelligence paused: ${r.weatherIntelligence.message}`);
        lines.push("");
    }

    if (r.pestPrediction) {
        const p = r.pestPrediction;
        lines.push(`Pest outlook: ${p.riskLabel} (index ${Math.round((p.pestPressureIndex || 0) * 100)}%).`);
        if (p.reasons?.[0]) lines.push(`Why: ${p.reasons[0]}`);
        lines.push("");
    }

    if (r.yieldOutlook) {
        const y = r.yieldOutlook;
        if (y.status === "trend_only" && y.outlook) {
            lines.push(`Yield outlook (health-trend only): ${y.interpretation || y.outlook.trend}`);
        } else if (y.message) {
            lines.push(`Yield outlook: ${y.message}`);
        }
        lines.push("");
    }

    if (r.recommendations?.actions?.length) {
        lines.push("Prioritized actions:");
        for (const a of r.recommendations.actions.slice(0, 4)) {
            lines.push(`• ${a.title} — ${a.reasoning} (confidence ${Math.round((a.confidence || 0) * 100)}%).`);
            for (const s of (a.steps || []).slice(0, 2)) lines.push(`  - ${s}`);
        }
        lines.push("");
    }

    const ctxLines = [];
    const fc = orch.snapshot?.fields?.length ?? 0;
    const sc = orch.snapshot?.scans?.length ?? 0;
    ctxLines.push(`Account snapshot: ${fc} field(s), ${sc} scan(s).`);

    const latestScan = orch.snapshot?.scans?.[0];
    if (latestScan) {
        const health = typeof latestScan.healthScore === "number" ? `${Math.round(latestScan.healthScore)}%` : "--";
        ctxLines.push(`Latest saved scan: ${latestScan.cropType || "crop"} • ${latestScan.diagnosis?.label || "logged"} • health ${health}.`);
    } else {
        ctxLines.push("No scans yet — onboarding: run Scanner once to unlock disease/pest context in this assistant.");
    }

    lines.push(ctxLines.join("\n"));

    if (!llmText && lines.filter(Boolean).length < 3) {
        lines.push(
            "\nTip: Ask about irrigation timing, spray drift risk, pest scouting, or yield trends — I route each question through the relevant farm engine."
        );
    }

    return lines.filter(Boolean).join("\n").trim();
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
    };
    return orch;
}
