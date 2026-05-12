import "./auth-session.js?v=33";
import "./i18n.js?v=12";
import { auth, db, storage } from "./auth.js?v=32";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";
import { FieldIntelligenceViz } from "./field-intelligence-viz.js?v=1";
import { reliabilityRowHTML } from "./ai/reliability/ui.js";
import {
  logIntervention,
  createOperationalTask,
  completeOperationalTask,
  dismissOperationalTask,
} from "./ops/operations-service.js";
import { INTERVENTION_TYPES, INTERVENTION_LABELS, TASK_PRIORITY_ORDER } from "./ops/types.js";
import { proposeFieldTasks } from "./ops/task-proposals.js";
import { assessInterventionOutcome, summarizeOperationsAnalytics } from "./ops/effectiveness.js";
import { decorateNotificationForAmbient } from "./ambient/notification-decorator.js";
import { buildOperationsTimeline } from "./ops/timeline.js";
import { getSeasonalWorkflowHints } from "./ops/seasonal-workflows.js";
import { buildDigitalTwinState } from "./twin/twin-state.js";
import { compareScenarios, explainSimulationDifference, SCENARIO_PRESETS } from "./twin/simulation-engine.js";
import { buildTwinTrajectorySvg, formatScenarioCard } from "./twin/twin-visualization.js";
import { getRecommendationCalibration } from "./learning/calibration-apply.js";
import { queueLearningFlush } from "./learning/scheduler.js";

const qs = (s) => document.querySelector(s);
const el = (id) => document.getElementById(id);

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function fieldIdFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return p.get("f") || p.get("field") || "";
}

function formatAgo(ms) {
  if (!ms) return "";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pestRiskFromScan(scan) {
  if (!scan) return null;
  let p = 12;
  const sev = scan.severity?.level;
  if (sev === "critical") p += 40;
  else if (sev === "moderate") p += 22;
  else if (sev === "good") p += 0;
  const obs = Array.isArray(scan.observedSymptoms) ? scan.observedSymptoms.join(" ").toLowerCase() : "";
  const diag = String(scan.diagnosis || "").toLowerCase();
  if (/pest|insect|borer|aphid/.test(obs + diag)) p += 28;
  if (/fungal|rust|blight/.test(obs + diag)) p += 15;
  return Math.min(96, Math.round(p));
}

function diseaseProbFromScan(scan) {
  if (!scan) return null;
  let p = 10;
  const sev = scan.severity?.level;
  if (sev === "critical") p += 35;
  else if (sev === "moderate") p += 20;
  const obs = Array.isArray(scan.observedSymptoms) ? scan.observedSymptoms.join(" ").toLowerCase() : "";
  const diag = String(scan.diagnosis || "").toLowerCase();
  if (/fungal|disease|rot|mildew|rust|blight|wil/.test(obs + diag)) p += 32;
  return Math.min(95, Math.round(p));
}

function renderSparkline(scansAsc) {
  const host = el("fd-sparkline");
  if (!host) return;
  const pts = scansAsc
    .map((s) => (typeof s.healthScore === "number" ? s.healthScore : null))
    .filter((n) => n != null);
  if (pts.length < 2) {
    host.innerHTML = '<div class="empty" style="padding:12px;">Need at least two scans to plot a trend</div>';
    return;
  }
  const w = 300;
  const h = 72;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const pad = 6;
  const dx = (w - pad * 2) / (pts.length - 1);
  const path = pts
    .map((v, i) => {
      const x = pad + i * dx;
      const t = max === min ? 0.5 : (v - min) / (max - min);
      const y = pad + (1 - t) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  host.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#39ff14" stop-opacity="0.35"/><stop offset="100%" stop-color="#39ff14" stop-opacity="0"/></linearGradient></defs><path d="${path}" fill="none" stroke="#39ff14" stroke-width="2"/><path d="${path} L ${w - pad},${h} L ${pad},${h} Z" fill="url(#g)" stroke="none"/></svg>`;
}

function buildInsights(field, latest, scansDesc, soilMoisture) {
  const items = [];
  if (latest && typeof latest.healthScore === "number") {
    if (latest.healthScore < 50) {
      items.push({ cls: "bad", icon: "ri-alarm-warning-line", text: "Latest scan health is low. Re-run a scan after any treatment or irrigation change." });
    } else if (latest.healthScore >= 80) {
      items.push({ cls: "", icon: "ri-plant-line", text: "Latest scan indicates strong canopy health. Maintain current scouting rhythm." });
    }
  }
  const pr = pestRiskFromScan(latest);
  if (pr != null && pr >= 55) {
    items.push({ cls: "warn", icon: "ri-bug-line", text: `Elevated pest pressure signal (${pr}%) from symptom patterns — prioritize field edges and stressed rows.` });
  }
  const dp = diseaseProbFromScan(latest);
  if (dp != null && dp >= 50) {
    items.push({ cls: "warn", icon: "ri-virus-line", text: `Disease risk estimate ${dp}% from recent scan — improve airflow and avoid overhead irrigation when humid.` });
  }
  if (typeof soilMoisture === "number") {
    if (soilMoisture < 35) items.push({ cls: "", icon: "ri-drop-line", text: "Regional moisture model is dry — align irrigation with early morning blocks." });
    if (soilMoisture > 78) items.push({ cls: "warn", icon: "ri-water-flash-line", text: "Moisture model is high — check drainage in low spots after rain." });
  }
  if (field?.irrigationType === "Rain-fed" && typeof soilMoisture === "number" && soilMoisture < 40) {
    items.push({ cls: "warn", icon: "ri-cloud-off-line", text: "Rain-fed field with dry moisture estimate — monitor soil crusting and consider contingency irrigation." });
  }
  if (!items.length) {
    items.push({ cls: "", icon: "ri-sparkling-line", text: "Keep scanning after major weather or input changes to sharpen field intelligence." });
  }
  return items;
}

let detach = null;

let _intelTabCallback = null;
let _fieldTabsBound = false;

function bindFieldTabsGlobal() {
  if (_fieldTabsBound) return;
  const t = qs(".tabs");
  if (!t) return;
  _fieldTabsBound = true;
  t.addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    const id = tab.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === `panel-${id}`));
    _intelTabCallback?.(id);
  });
}

function attachFieldDetail(user, fieldId) {
  const unsubs = [];
  let fieldSnap = null;
  let scans = [];
  let recs = [];
  let activities = [];
  let latestWeatherMoisture = null;
  /** @type {any | null} */
  let latestWeatherLogDoc = null;
  /** @type {any} */
  let ctxState = null;
  let ctxEvents = [];
  let inferenceJobs = [];
  let fieldInterventions = [];
  let fieldTasks = [];
  let fieldAlerts = [];
  /** @type {any | null} */
  let learningProfileDoc = null;
  /** @type {FieldIntelligenceViz | null} */
  let fiViz = null;

  _intelTabCallback = (tabId) => {
    if (tabId === "intelligence") rerenderAll();
    if (tabId === "operations") rerenderAll();
    if (tabId === "twin") rerenderAll();
  };
  bindFieldTabsGlobal();

  const unsubField = onSnapshot(doc(db, "fields", fieldId), (snap) => {
    if (!snap.exists()) {
      window.location.href = "fields.html";
      return;
    }
    const data = snap.data();
    if (data.userId !== user.uid) {
      window.location.href = "fields.html";
      return;
    }
    fieldSnap = { id: snap.id, ...data };
    paintFieldHeader(fieldSnap);
    fillEditForm(fieldSnap);
    rerenderAll();
  });
  unsubs.push(unsubField);

  unsubs.push(
    onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(400)), (snap) => {
      scans = [];
      snap.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        if (x.fieldId === fieldId) scans.push(x);
      });
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "ai_recommendations"), where("userId", "==", user.uid), limit(300)), (snap) => {
      recs = [];
      snap.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        if (x.fieldId === fieldId) recs.push(x);
      });
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "activity_history"), where("userId", "==", user.uid), limit(300)), (snap) => {
      activities = [];
      const seen = new Set();
      snap.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        const e = x.entity;
        const matchField = e && e.kind === "field" && e.id === fieldId;
        const matchMeta = x.meta?.fieldId === fieldId;
        if ((matchField || matchMeta) && !seen.has(d.id)) {
          seen.add(d.id);
          activities.push(x);
        }
      });
      activities.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(40)), (snap) => {
      let best = 0;
      let moisture = null;
      let bestDoc = null;
      snap.forEach((d) => {
        const x = d.data();
        const t = tsToMs(x.fetchedAt);
        if (t >= best) {
          best = t;
          bestDoc = { id: d.id, ...x };
          moisture =
            typeof x.derived?.soilMoistureEstimate === "number"
              ? x.derived.soilMoistureEstimate
              : null;
        }
      });
      latestWeatherMoisture = moisture;
      latestWeatherLogDoc = bestDoc;
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(doc(db, "field_context_state", fieldId), (snap) => {
      ctxState = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, "field_context_events"),
        where("userId", "==", user.uid),
        where("fieldId", "==", fieldId),
        orderBy("createdAt", "desc"),
        limit(100),
      ),
      (snap) => {
        ctxEvents = [];
        snap.forEach((d) => ctxEvents.push({ id: d.id, ...d.data() }));
        rerenderAll();
      },
    ),
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, "ai_inference_jobs"),
        where("userId", "==", user.uid),
        where("fieldId", "==", fieldId),
        orderBy("createdAt", "desc"),
        limit(45),
      ),
      (snap) => {
        inferenceJobs = [];
        snap.forEach((d) => inferenceJobs.push({ id: d.id, ...d.data() }));
        rerenderAll();
      },
    ),
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, "farm_interventions"),
        where("userId", "==", user.uid),
        where("fieldId", "==", fieldId),
        orderBy("performedAt", "desc"),
        limit(36),
      ),
      (snap) => {
        fieldInterventions = [];
        snap.forEach((d) => fieldInterventions.push({ id: d.id, ...d.data() }));
        rerenderAll();
      },
    ),
  );

  unsubs.push(
    onSnapshot(
      query(
        collection(db, "farm_operational_tasks"),
        where("userId", "==", user.uid),
        where("fieldId", "==", fieldId),
        orderBy("createdAt", "desc"),
        limit(40),
      ),
      (snap) => {
        fieldTasks = [];
        snap.forEach((d) => fieldTasks.push({ id: d.id, ...d.data() }));
        rerenderAll();
      },
    ),
  );

  unsubs.push(
    onSnapshot(query(collection(db, "alerts"), where("userId", "==", user.uid), limit(50)), (snap) => {
      fieldAlerts = [];
      snap.forEach((d) => {
        const x = { id: d.id, ...d.data() };
        if (x.fieldId === fieldId || !x.fieldId) fieldAlerts.push(x);
      });
      rerenderAll();
    }),
  );

  unsubs.push(
    onSnapshot(doc(db, "learning_profiles", user.uid), (snap) => {
      learningProfileDoc = snap.exists() ? snap.data() : null;
      rerenderAll();
    }),
  );

  /** @type {string[]} */
  let twinScenarioIds = ["baseline", "continued_rain", "immediate_intervention"];
  let lastOpsProposals = [];

  const twinPanelRoot = el("panel-twin");
  if (twinPanelRoot && !twinPanelRoot.dataset.twinUiBound) {
    twinPanelRoot.dataset.twinUiBound = "1";
    twinPanelRoot.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-twin-scenario]");
      if (!chip) return;
      const id = chip.dataset.twinScenario;
      if (!id) return;
      const on = twinScenarioIds.includes(id);
      if (on) twinScenarioIds = twinScenarioIds.filter((x) => x !== id);
      else {
        twinScenarioIds.push(id);
        if (twinScenarioIds.length > 3) twinScenarioIds = twinScenarioIds.slice(-3);
      }
      if (!twinScenarioIds.length) twinScenarioIds = ["baseline"];
      renderTwinPanel();
    });
    el("fd-twin-replay")?.addEventListener("input", () => renderTwinPanel());
  }

  function renderTwinPanel() {
    const panel = el("panel-twin");
    const f = fieldSnap;
    if (!panel || !f) return;
    const sumEl = el("fd-twin-summary");
    const twin = buildDigitalTwinState({
      field: f,
      scans,
      ctxState,
      interventions: fieldInterventions,
    });
    const stage = twin.growth?.label || "—";
    if (sumEl) {
      sumEl.innerHTML = `Crop <strong style="color:var(--neon)">${escapeHtml(f.cropType || "—")}</strong> · growth stage <strong>${escapeHtml(stage)}</strong> (heuristic) · twin data confidence <strong>${escapeHtml(twin.dataConfidence)}</strong> · scans <strong>${twin.scanCount}</strong>.`;
    }

    const hostChips = el("fd-twin-scenarios");
    if (hostChips) {
      hostChips.innerHTML = SCENARIO_PRESETS.map((p) => {
        const active = twinScenarioIds.includes(p.id);
        return `<button type="button" class="twin-chip${active ? " twin-chip-active" : ""}" data-twin-scenario="${escapeHtml(p.id)}">${escapeHtml(p.label)}</button>`;
      }).join("");
    }

    const wx = latestWeatherLogDoc;
    const bundle = wx ? { current: wx.current, daily: wx.daily, hourly: wx.hourly, fetchedAt: wx.fetchedAt } : null;

    const chartEl = el("fd-twin-chart");
    const cardsEl = el("fd-twin-cards");
    const explainEl = el("fd-twin-explain");
    const replay = el("fd-twin-replay");

    if (!bundle?.daily?.precipitation_sum) {
      if (chartEl) chartEl.innerHTML = '<div class="empty">Weather bundle missing — open the app with location once, then return.</div>';
      if (cardsEl) cardsEl.innerHTML = "";
      if (explainEl) explainEl.innerHTML = "";
      return;
    }

    const ids = twinScenarioIds.length ? twinScenarioIds : ["baseline"];
    const learningCal = getRecommendationCalibration(learningProfileDoc);
    const suite = compareScenarios(twin, bundle, ids, { regionalStress01: 0.14, learningCal });
    const horizon = suite[0]?.projection?.steps?.length ? suite[0].projection.steps.length - 1 : 7;
    if (replay) replay.max = String(horizon);

    const day = replay ? Number(replay.value) : horizon;
    if (chartEl) chartEl.innerHTML = buildTwinTrajectorySvg(suite, { replayDay: day });

    if (cardsEl) {
      cardsEl.innerHTML = suite
        .map((item) => {
          const c = formatScenarioCard(item);
          return `<div class="twin-card"><h4>${escapeHtml(c.title)}</h4><p style="color:var(--dim);">${escapeHtml(c.body)}</p><ul>${c.metrics.map((m) => `<li>${escapeHtml(m)}</li>`).join("")}</ul></div>`;
        })
        .join("");
    }

    if (explainEl) {
      const baseItem = suite.find((s) => s.meta.id === "baseline") || suite[0];
      const baseProj = baseItem?.projection;
      const altItem = suite.find((s) => s.meta.id !== baseItem?.meta?.id) || suite[1];
      const altProj = altItem?.projection;
      const lines =
        baseProj && altProj && baseItem?.meta?.id !== altItem?.meta?.id
          ? explainSimulationDifference(baseProj, altProj)
          : ["Select two distinct scenarios to compare explanatory notes."];
      explainEl.innerHTML = lines.map((x) => `<li>${escapeHtml(x)}</li>`).join("");
    }
  }

  function latestScan() {
    let best = null;
    let bestT = 0;
    for (const s of scans) {
      const t = tsToMs(s.createdAt);
      if (t >= bestT) {
        bestT = t;
        best = s;
      }
    }
    return best;
  }

  function renderOperationsPanel() {
    const root = el("panel-operations");
    if (!root || !fieldSnap) return;

    const sel = el("fd-ops-type");
    if (sel && sel.options.length === 0) {
      for (const t of INTERVENTION_TYPES) {
        const o = document.createElement("option");
        o.value = t;
        o.textContent = INTERVENTION_LABELS[t] || t;
        sel.appendChild(o);
      }
    }

    const f = fieldSnap;
    const fieldOnlyAlerts = fieldAlerts.filter((a) => a.fieldId === fieldId);
    const proposals = proposeFieldTasks({
      scans,
      alerts: fieldOnlyAlerts,
      ctxState,
      weatherLog: latestWeatherLogDoc,
      fieldId,
      fieldName: f.name || "Field",
    });
    lastOpsProposals = proposals;

    const openTasks = fieldTasks
      .filter((t) => t.status === "open")
      .slice()
      .sort((a, b) => {
        const oa = TASK_PRIORITY_ORDER[a.priority] ?? 9;
        const ob = TASK_PRIORITY_ORDER[b.priority] ?? 9;
        if (oa !== ob) return oa - ob;
        return tsToMs(a.dueAt || a.createdAt) - tsToMs(b.dueAt || b.createdAt);
      });

    const seasonal = getSeasonalWorkflowHints(f.cropType, new Date());
    const timeline = buildOperationsTimeline(
      {
        interventions: fieldInterventions,
        tasks: fieldTasks,
        alerts: fieldOnlyAlerts,
        scans,
        recs,
        activities,
        weatherLogs: latestWeatherLogDoc ? [{ id: latestWeatherLogDoc.id || "wx", ...latestWeatherLogDoc }] : [],
      },
      40,
    );

    const intvHost = el("fd-ops-interventions");
    if (intvHost) {
      const intvRows = fieldInterventions
        .slice()
        .sort((a, b) => tsToMs(b.performedAt) - tsToMs(a.performedAt))
        .slice(0, 14)
        .map((inv) => {
          const assessed = assessInterventionOutcome(inv, scans);
          const label = INTERVENTION_LABELS[inv.interventionType] || inv.interventionType;
          const eff =
            typeof assessed.effectivenessScore === "number"
              ? `${Math.round(assessed.effectivenessScore * 100)}% (${String(assessed.recoveryConfidence).replace(/_/g, " ")})`
              : String(assessed.recoveryConfidence).replace(/_/g, " ");
          const trig = inv.aiTriggerSource?.kind || "manual";
          return `
        <div class="scan-card">
          <div class="score">${escapeHtml(label)}</div>
          <div style="margin-top:6px;font-size:10px;color:var(--dim);">Source: ${escapeHtml(trig)}</div>
          <div style="margin-top:6px;font-size:11px;color:var(--dim);line-height:1.45;">${escapeHtml(assessed.narrative)}</div>
          <div style="margin-top:8px;font-size:10px;opacity:.9;"><strong>Inferred trend</strong>: ${escapeHtml(eff)} · not proof of causation</div>
          ${
            inv.followUpRecommendation
              ? `<div style="margin-top:6px;font-size:10px;">Follow-up: ${escapeHtml(inv.followUpRecommendation)}</div>`
              : ""
          }
          ${inv.notes ? `<div style="margin-top:6px;font-size:11px;">${escapeHtml(inv.notes)}</div>` : ""}
          <div class="t">${formatAgo(tsToMs(inv.performedAt))}</div>
        </div>`;
        })
        .join("");
      intvHost.innerHTML = intvRows || '<div class="empty">No interventions logged yet.</div>';
    }

    const tasksHost = el("fd-ops-tasks");
    if (tasksHost) {
      tasksHost.innerHTML = openTasks.length
        ? openTasks
            .map(
              (t) => `
      <div class="insight-row">
        <i class="ri-task-line"></i>
        <div style="flex:1;min-width:0;">
          <div><span style="color:var(--neon);font-size:10px;">${escapeHtml(t.priority || "normal")}</span> · ${escapeHtml(t.title)}</div>
          ${t.detail ? `<div style="font-size:11px;color:var(--dim);margin-top:4px;line-height:1.4;">${escapeHtml(t.detail)}</div>` : ""}
          <div class="t">${t.dueAt ? `Due ${new Date(tsToMs(t.dueAt)).toLocaleString()}` : formatAgo(tsToMs(t.createdAt))}</div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <button type="button" class="btn-ghost fd-ops-task-done" data-id="${escapeHtml(t.id)}" style="margin:0;flex:1;padding:8px;font-size:11px;">Done</button>
            <button type="button" class="btn-ghost fd-ops-task-dismiss" data-id="${escapeHtml(t.id)}" style="margin:0;flex:1;padding:8px;font-size:11px;">Dismiss</button>
          </div>
        </div>
      </div>`,
            )
            .join("")
        : '<div class="empty">No open tasks. Suggested actions appear below.</div>';
    }

    const propHost = el("fd-ops-proposals");
    if (propHost) {
      propHost.innerHTML = proposals.length
        ? proposals
            .map(
              (p, i) => `
      <div class="insight-row">
        <i class="ri-sparkling-line"></i>
        <div style="flex:1;min-width:0;">
          <div>${escapeHtml(p.title)}</div>
          <div style="font-size:11px;color:var(--dim);margin-top:4px;line-height:1.4;">${escapeHtml(p.detail || "")}</div>
          <button type="button" class="btn-ghost fd-ops-add-proposal" data-idx="${i}" style="margin-top:8px;padding:8px;font-size:11px;">Add as task</button>
        </div>
      </div>`,
            )
            .join("")
        : '<div class="empty">No suggested tasks from current signals. Scan or sync weather to refresh.</div>';
    }

    const seasHost = el("fd-ops-seasonal");
    if (seasHost) {
      const items = seasonal.items || [];
      seasHost.innerHTML =
        items.length > 0
          ? `<p style="font-size:11px;color:var(--neon);margin-bottom:8px;">${escapeHtml(seasonal.title || "")}</p>
            <ul style="font-size:11px;padding-left:18px;line-height:1.55;color:var(--text);">${items.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>
            <p style="font-size:9px;color:var(--dim);margin-top:10px;line-height:1.4;">${escapeHtml(seasonal.scope || "")}</p>`
          : '<div class="empty">Set crop type on this field for seasonal rhythm hints.</div>';
    }

    const tlHost = el("fd-ops-timeline");
    if (tlHost) {
      tlHost.innerHTML = timeline.length
        ? timeline
            .map(
              (ev) => `
      <div class="activity-item">
        <div><span style="color:var(--neon);font-size:10px;">${escapeHtml(ev.label)}</span><br/>${escapeHtml((ev.text || "").slice(0, 220))}</div>
        <div class="t">${ev.ts ? new Date(ev.ts).toLocaleString() : ""}</div>
      </div>`,
            )
            .join("")
        : '<div class="empty">Operational timeline will appear as you log work.</div>';
    }

    const brief = el("fd-ops-brief");
    if (brief) {
      const analytics = summarizeOperationsAnalytics(fieldInterventions, scans);
      brief.textContent = analytics.summary;
    }
  }

  function paintFieldHeader(f) {
    el("fd-name").textContent = f.name || "Field";
    const crop = f.cropType || "Crop not set";
    const area = typeof f.areaAcres === "number" ? `${f.areaAcres.toFixed(1)} acres` : "Area not set";
    el("fd-sub").textContent = `${crop} · ${area}`;
    const img = el("fd-hero-img");
    const fb = el("fd-hero-fallback");
    if (f.imageUrl && img && fb) {
      img.src = f.imageUrl;
      img.classList.remove("hidden");
      fb.classList.add("hidden");
      img.onload = () => {
        img.classList.remove("hidden");
        fb.classList.add("hidden");
      };
      img.onerror = () => {
        img.classList.add("hidden");
        fb.classList.remove("hidden");
      };
    } else if (img && fb) {
      img.classList.add("hidden");
      fb.classList.remove("hidden");
    }
  }

  function fillEditForm(f) {
    el("fd-in-name").value = f.name || "";
    el("fd-in-crop").value = f.cropType || "";
    el("fd-in-soil").value = f.soilType || "";
    el("fd-in-irr").value = f.irrigationType || "";
    el("fd-in-area").value = typeof f.areaAcres === "number" ? String(f.areaAcres) : "";
    el("fd-in-planted").value = f.plantedAt || "";
    el("fd-in-notes").value = f.notes || "";
  }

  function rerenderAll() {
    const f = fieldSnap;
    if (!f) return;
    const latest = latestScan();
    const health = latest && typeof latest.healthScore === "number" ? `${Math.round(latest.healthScore)}%` : "—";
    el("fd-health").textContent = health;
    el("fd-area").textContent = typeof f.areaAcres === "number" ? `${f.areaAcres.toFixed(1)} ac` : "—";
    const moist =
      latestWeatherMoisture != null ? `${Math.round(latestWeatherMoisture)}%` : "—";
    el("fd-moisture").textContent = moist;
    const pr = pestRiskFromScan(latest);
    el("fd-pest").textContent = pr != null ? `${pr}%` : "—";

    const scansChrono = scans.slice().sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt));
    renderSparkline(scansChrono);

    const cropEl = el("fd-crop-summary");
    cropEl.innerHTML = `
      <strong style="color:var(--neon)">${f.cropType || "Not set"}</strong><br/>
      Soil: ${f.soilType || "—"} · Irrigation: ${f.irrigationType || "—"}<br/>
      Planted: ${f.plantedAt ? new Date(f.plantedAt).toLocaleDateString() : "—"}
    `;

    const recHost = el("fd-recs-list");
    const fieldRecs = recs
      .slice()
      .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
      .slice(0, 12);
    if (!fieldRecs.length) {
      recHost.innerHTML = '<div class="empty">No recommendations yet. Run a scan linked to this field.</div>';
    } else {
      recHost.innerHTML = fieldRecs
        .map((r) => {
          const relBlock = r.reliability?.schemaVersion ? reliabilityRowHTML(r.reliability) : "";
          const audit = r.recommendationAudit;
          const evJson = audit?.evidenceBundle
            ? JSON.stringify(audit.evidenceBundle).slice(0, 480)
            : "";
          const why = audit
            ? `<details class="rel-details" style="margin-top:6px;"><summary class="rel-detail-toggle">Why &amp; audit</summary><div class="rel-detail-body open" style="display:block;margin-top:6px;">${escapeHtml(audit.reasoningSummary || "")}${
                audit.contributingSignals?.length
                  ? `<div style="margin-top:8px;font-size:10px;opacity:.88;">Contributors: ${escapeHtml(audit.contributingSignals.join(" · "))}</div>`
                  : ""
              }${
                evJson
                  ? `<div style="margin-top:8px;font-size:10px;opacity:.75;">Evidence (snapshot): ${escapeHtml(evJson)}</div>`
                  : ""
              }</div></details>`
            : "";
          return `
        <div class="insight-row"><i class="ri-lightbulb-flash-line"></i><div>
          <div><span style="color:var(--neon);font-size:10px;">${escapeHtml(r.type || "tip")}</span><br/>${escapeHtml(r.text || "")}</div>
          ${relBlock}
          ${why}
          <div class="t">${formatAgo(tsToMs(r.createdAt))}</div>
        </div></div>`;
        })
        .join("");
    }

    const latestHost = el("fd-latest-scan");
    if (!latest) {
      latestHost.innerHTML = '<div class="empty">No scans for this field yet. Use Scan from the nav.</div>';
    } else {
      latestHost.innerHTML = `
        <div class="scan-card">
          <div class="score">Health ${Math.round(latest.healthScore)}% · ${latest.severity?.label || latest.severity?.level || ""}</div>
          <div style="margin-top:6px;color:var(--dim);font-size:11px;">${escapeHtml(latest.diagnosis || "")}</div>
          <div class="t">${formatAgo(tsToMs(latest.createdAt))}</div>
        </div>
      `;
    }

    const ins = buildInsights(f, latest, scans, latestWeatherMoisture);
    el("fd-insights").innerHTML = ins
      .map(
        (x) =>
          `<div class="insight-row ${x.cls}"><i class="${x.icon}"></i><div>${escapeHtml(x.text)}</div></div>`,
      )
      .join("");

    const actHost = el("fd-activity-list");
    const acts = activities.slice(0, 25);
    if (!acts.length) {
      actHost.innerHTML = '<div class="empty">No activity for this field yet.</div>';
    } else {
      actHost.innerHTML = acts
        .map((a) => {
          const msg =
            a.type === "field.created"
              ? "Field created"
              : a.type === "field.updated"
                ? "Field updated"
                : a.type === "crop_scan.created"
                  ? "Crop scan saved"
                  : a.type || "Activity";
          return `<div class="activity-item"><div>${escapeHtml(msg)}</div><div class="t">${formatAgo(tsToMs(a.createdAt))}</div></div>`;
        })
        .join("");
    }

    const scanHost = el("fd-scans-list");
    const sdesc = scans
      .slice()
      .sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt))
      .slice(0, 15);
    if (!sdesc.length) {
      scanHost.innerHTML = '<div class="empty">No scans yet.</div>';
    } else {
      scanHost.innerHTML = sdesc
        .map(
          (s) => `
        <div class="scan-card">
          <span class="score">${Math.round(s.healthScore)}%</span> · ${escapeHtml(s.cropType || "")}
          <div style="color:var(--dim);font-size:11px;margin-top:4px;">${formatAgo(tsToMs(s.createdAt))}</div>
        </div>`,
        )
        .join("");
    }
    renderOperationsPanel();
    renderTwinPanel();
    refreshIntelPanel();
  }

  function refreshIntelPanel() {
    const root = el("fi-command-root");
    const panel = el("panel-intelligence");
    if (!root || !panel?.classList.contains("active")) {
      if (fiViz) fiViz.stop();
      return;
    }
    if (!fiViz) fiViz = new FieldIntelligenceViz({ host: root, fieldId });
    const latest = latestScan();
    let scanPestHint = 0;
    if (latest) {
      const obs = Array.isArray(latest.observedSymptoms) ? latest.observedSymptoms.join(" ").toLowerCase() : "";
      if (/pest|hole|chew|insect|borer|aphid/.test(obs)) scanPestHint = 0.35;
    }
    fiViz.update({
      ctxState,
      ctxEvents,
      scans,
      field: fieldSnap,
      inferenceJobs,
      latestScan: latest,
      latestMoisture: latestWeatherMoisture,
      scanPestHint,
    });
    fiViz.render();
    try {
      const raw = localStorage.getItem("agri_location_details");
      const loc = raw ? JSON.parse(raw) : null;
      if (loc && typeof loc.lat === "number" && typeof loc.lon === "number") {
        void fiViz.ensureWeather(loc.lat, loc.lon);
      }
    } catch (_) {
      /* ignore */
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  el("fd-save-meta").onclick = async () => {
    const btn = el("fd-save-meta");
    const name = el("fd-in-name").value.trim();
    if (!name) {
      alert("Name is required.");
      return;
    }
    btn.disabled = true;
    try {
      const area = parseFloat(el("fd-in-area").value);
      await updateDoc(doc(db, "fields", fieldId), {
        name,
        cropType: el("fd-in-crop").value.trim() || null,
        soilType: el("fd-in-soil").value || null,
        irrigationType: el("fd-in-irr").value || null,
        areaAcres: Number.isFinite(area) ? area : null,
        plantedAt: el("fd-in-planted").value || null,
        notes: el("fd-in-notes").value.trim() || null,
        updatedAt: serverTimestamp(),
        schemaVersion: 2,
      });
      const file = el("fd-cover-file").files?.[0];
      if (file) {
        if (file.size > 6 * 1024 * 1024) {
          alert("Image must be under 6MB.");
        } else {
          const storageRef = ref(storage, `field_covers/${user.uid}/${fieldId}/banner_${Date.now()}`);
          await uploadBytes(storageRef, file);
          const url = await getDownloadURL(storageRef);
          await updateDoc(doc(db, "fields", fieldId), { imageUrl: url, updatedAt: serverTimestamp() });
        }
        el("fd-cover-file").value = "";
      }
      const batch = writeBatch(db);
      batch.set(doc(collection(db, "activity_history")), {
        userId: user.uid,
        type: "field.updated",
        createdAt: serverTimestamp(),
        entity: { kind: "field", id: fieldId },
        meta: { fieldId, source: "field_detail" },
        schemaVersion: 1,
      });
      const notifDraft = {
        userId: user.uid,
        title: "Field updated",
        body: `${name} was updated.`,
        type: "field_updated",
        readAt: null,
        createdAt: serverTimestamp(),
        entity: { kind: "field", id: fieldId },
        schemaVersion: 1,
      };
      const decorated = decorateNotificationForAmbient(notifDraft, { fieldId });
      if (decorated) {
        batch.set(doc(collection(db, "notifications")), decorated);
      }
      await batch.commit();
    } catch (e) {
      console.error(e);
      alert(e.message || "Save failed");
    } finally {
      btn.disabled = false;
    }
  };

  el("fd-delete-field").onclick = async () => {
    if (!confirm("Delete this field permanently? Scans remain but lose this link.")) return;
    try {
      await deleteDoc(doc(db, "fields", fieldId));
      window.location.href = "fields.html";
    } catch (e) {
      alert(e.message || "Delete failed");
    }
  };

  el("fd-edit-map-btn").onclick = () => {
    window.location.href = `fields.html?edit=${encodeURIComponent(fieldId)}`;
  };

  const opsRoot = el("panel-operations");
  if (opsRoot && !opsRoot.dataset.opsBound) {
    opsRoot.dataset.opsBound = "1";
    opsRoot.addEventListener("click", async (e) => {
      const doneBtn = e.target.closest(".fd-ops-task-done");
      const dismissBtn = e.target.closest(".fd-ops-task-dismiss");
      const addProp = e.target.closest(".fd-ops-add-proposal");
      try {
        if (doneBtn?.dataset.id) {
          await completeOperationalTask(db, doneBtn.dataset.id);
        } else if (dismissBtn?.dataset.id) {
          await dismissOperationalTask(db, dismissBtn.dataset.id);
        } else if (addProp && addProp.dataset.idx != null) {
          const idx = Number(addProp.dataset.idx);
          const p = lastOpsProposals[idx];
          if (p) await createOperationalTask(db, user.uid, p);
        }
      } catch (err) {
        console.error(err);
        alert(err?.message || "Action failed");
      }
    });
  }

  const logOpsBtn = el("fd-ops-log");
  if (logOpsBtn) {
    logOpsBtn.onclick = async () => {
      const type = el("fd-ops-type")?.value;
      if (!type) {
        alert("Choose an intervention type.");
        return;
      }
      const notes = el("fd-ops-notes")?.value?.trim() || "";
      const fu = el("fd-ops-followup")?.value?.trim() || "";
      const wv = parseInt(el("fd-ops-window")?.value, 10);
      const windowHrs = Number.isFinite(wv) && wv > 0 ? wv : 72;
      logOpsBtn.disabled = true;
      try {
        const latest = latestScan();
        await logIntervention(db, user.uid, {
          fieldId,
          interventionType: type,
          notes,
          aiTriggerSource: { kind: "manual", page: "field_detail" },
          expectedOutcomeWindowHours: windowHrs,
          followUpRecommendation: fu || `Re-scan or scout within ~${windowHrs}h to compare canopy trend.`,
          preScanSnapshot: latest
            ? {
                healthScore: latest.healthScore,
                scanId: latest.id,
                severity: latest.severity?.level || null,
              }
            : null,
        });
        const batch = writeBatch(db);
        batch.set(doc(collection(db, "activity_history")), {
          userId: user.uid,
          type: "field.intervention_logged",
          createdAt: serverTimestamp(),
          entity: { kind: "field", id: fieldId },
          meta: { fieldId, interventionType: type, source: "field_detail" },
          schemaVersion: 1,
        });
        await batch.commit();
        el("fd-ops-notes").value = "";
        el("fd-ops-followup").value = "";
        try {
          queueLearningFlush(db, user.uid, "intervention_logged");
        } catch (le) {
          console.warn("[learning]", le?.message || le);
        }
      } catch (err) {
        console.error(err);
        alert(err?.message || "Could not log intervention");
      } finally {
        logOpsBtn.disabled = false;
      }
    };
  }

  return () => {
    if (fiViz) fiViz.stop();
    unsubs.forEach((u) => u());
  };
}

onAuthStateChanged(auth, (user) => {
  if (detach) {
    detach();
    detach = null;
  }
  if (!user) {
    window.location.href = "login.html";
    return;
  }
  const fid = fieldIdFromUrl();
  if (!fid) {
    window.location.href = "fields.html";
    return;
  }
  detach = attachFieldDetail(user, fid);
});
