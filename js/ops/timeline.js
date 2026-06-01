import { tsToMs } from "../ai/farmer-context.js";

const KIND_SCORE = {
    intervention: 3,
    task_done: 2.5,
    task_open: 2.6,
    alert: 2.2,
    scan: 2,
    recommendation: 1.5,
    weather: 1,
    activity: 1,
};

/**
 * Merge heterogeneous farm events for a single chronological feed (client-side cap).
 */
export function buildOperationsTimeline({
    interventions = [],
    tasks = [],
    alerts = [],
    scans = [],
    recs = [],
    activities = [],
    weatherLogs = [],
}, maxItems = 60) {
    const items = [];

    for (const x of interventions) {
        items.push({
            kind: "intervention",
            ts: tsToMs(x.performedAt),
            label: x.interventionType || "intervention",
            text: x.notes || INTERVENTION_FALLBACK(x),
            ref: { interventionId: x.id },
            payload: x,
        });
    }
    for (const x of tasks) {
        items.push({
            kind: x.status === "done" ? "task_done" : "task_open",
            ts: tsToMs(x.createdAt),
            label: `Task · ${x.status}`,
            text: x.title + (x.detail ? ` — ${x.detail.slice(0, 160)}` : ""),
            ref: { taskId: x.id },
            payload: x,
        });
    }
    for (const x of alerts) {
        items.push({
            kind: "alert",
            ts: tsToMs(x.createdAt),
            label: x.type || "alert",
            text: x.title || x.body || "",
            ref: { alertId: x.id },
            payload: x,
        });
    }
    for (const x of scans) {
        items.push({
            kind: "scan",
            ts: tsToMs(x.createdAt),
            label: "Crop scan",
            text:
                typeof x.healthScore === "number"
                    ? `Health ${Math.round(x.healthScore)}%`
                    : "Scan saved",
            ref: { scanId: x.id },
            payload: x,
        });
    }
    for (const x of recs) {
        items.push({
            kind: "recommendation",
            ts: tsToMs(x.createdAt),
            label: x.type || "recommendation",
            text: x.text || "",
            ref: { recommendationId: x.id },
            payload: x,
        });
    }
    for (const x of activities) {
        items.push({
            kind: "activity",
            ts: tsToMs(x.createdAt),
            label: x.type || "activity",
            text: JSON.stringify(x.meta || {}).slice(0, 120),
            ref: { activityId: x.id },
            payload: x,
        });
    }
    const w = weatherLogs?.[0];
    if (w && tsToMs(w.fetchedAt)) {
        items.push({
            kind: "weather",
            ts: tsToMs(w.fetchedAt),
            label: "Weather sync",
            text: w.city ? `Bundle updated (${w.city})` : "Weather bundle updated",
            ref: { weatherLogId: w.id },
            payload: w,
        });
    }

    items.sort((a, b) => {
        const t = (b.ts || 0) - (a.ts || 0);
        if (t !== 0) return t;
        return (KIND_SCORE[b.kind] || 0) - (KIND_SCORE[a.kind] || 0);
    });

    return items.slice(0, maxItems);
}

function INTERVENTION_FALLBACK(x) {
    const hrs = x.expectedOutcomeWindowHours;
    return hrs ? `Logged · watch outcomes ~${hrs}h window.` : "Intervention logged.";
}
