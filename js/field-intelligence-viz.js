/**
 * Field Intelligence command center — realtime viz from Firestore + Open-Meteo.
 * No placeholder analytics: empty states when data is missing.
 */

import { fetchOpenMeteoBundle } from "./ai/weather-fetch.js?v=34";

/** @param {any} ts */
function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    return 0;
}

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

function escapeHtml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function slug(s) {
    return String(s || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
}

/**
 * Merge scans, context events, outbreak history into timeline nodes.
 */
function buildTimelineNodes(ctxState, ctxEvents, scans) {
    /** @type {any[]} */
    const nodes = [];
    const oh = ctxState?.outbreakHistory;
    if (Array.isArray(oh)) {
        for (const e of oh) {
            const at = typeof e.at === "number" ? e.at : 0;
            if (!at) continue;
            nodes.push({
                t: at,
                kind: "outbreak",
                label: e.label || "event",
                source: e.source || "memory",
                severity: e.source === "vision" ? 0.75 : 0.55,
            });
        }
    }
    for (const ev of ctxEvents || []) {
        const t = tsToMs(ev.createdAt);
        if (!t) continue;
        const typ = ev.type || "";
        const p = ev.payload || {};
        if (typ === "vision_inference") {
            nodes.push({
                t,
                kind: "vision",
                label: p.topHypothesis || "vision",
                severity: typeof p.topConfidence === "number" ? p.topConfidence : 0.5,
                meta: p,
            });
        } else if (typ === "symptom_scan") {
            nodes.push({
                t,
                kind: "symptom",
                label: p.diagnosisLabel || "symptom scan",
                severity: typeof p.healthScore === "number" ? 1 - p.healthScore / 100 : 0.45,
                meta: p,
            });
        }
    }
    for (const s of scans || []) {
        const t = tsToMs(s.createdAt);
        if (!t) continue;
        const lbl = s.diagnosis?.label || s.diagnosis?.code || "scan";
        const hs = typeof s.healthScore === "number" ? s.healthScore : 70;
        nodes.push({
            t,
            kind: "scan",
            label: lbl,
            severity: clamp(1 - hs / 100, 0.08, 0.95),
            meta: { healthScore: hs },
        });
    }
    nodes.sort((a, b) => a.t - b.t);
    return nodes;
}

/** @param {any[]} jobs */
function confidenceSeriesFromJobs(jobs) {
    const pts = [];
    for (const j of jobs || []) {
        if (j.status !== "completed" || !j.vision?.ok) continue;
        const raw = j.vision.raw;
        const t = tsToMs(j.createdAt || j.finishedAt);
        if (!t) continue;
        const adj = typeof raw?.confidence === "number" ? raw.confidence : null;
        const d0 = raw?.detections?.[0];
        const model =
            d0 && typeof d0.model_confidence === "number"
                ? d0.model_confidence
                : d0 && typeof d0.confidence === "number"
                  ? d0.confidence
                  : null;
        if (adj != null || model != null) {
            pts.push({ t, adjusted: adj, model, label: raw?.top_hypothesis || "" });
        }
    }
    pts.sort((a, b) => a.t - b.t);
    return pts;
}

function fungalProxyFromWeather(bundle) {
    const cur = bundle?.current || {};
    const daily = bundle?.daily || {};
    const rh = typeof cur.relative_humidity_2m === "number" ? cur.relative_humidity_2m : null;
    const rain0 =
        daily.precipitation_sum && typeof daily.precipitation_sum[0] === "number"
            ? daily.precipitation_sum[0]
            : null;
    let x = 0;
    if (rh != null) {
        if (rh >= 85) x += 0.42;
        else if (rh >= 70) x += 0.22;
    }
    if (rain0 != null && rain0 > 8) x += 0.28;
    else if (rain0 != null && rain0 > 2) x += 0.12;
    return clamp(x, 0, 0.95);
}

function buildExplanationLines(data) {
    const lines = [];
    const w = data.weatherBundle;
    const st = data.ctxState;
    if (w?.current?.relative_humidity_2m != null) {
        const rh = w.current.relative_humidity_2m;
        if (rh >= 78) lines.push(`Humidity ${Math.round(rh)}% — supports foliar pathogen cycles.`);
    }
    const rd0 = w?.daily?.precipitation_sum?.[0];
    if (typeof rd0 === "number" && rd0 >= 4) lines.push(`Recent daily rain ${rd0.toFixed(1)} mm — splash dispersal risk.`);
    const oh = st?.outbreakHistory;
    if (Array.isArray(oh) && oh[0]) {
        const last = oh[0];
        const days = last.at ? Math.floor((Date.now() - last.at) / 86400000) : null;
        lines.push(
            days != null
                ? `Field memory: ${last.label} noted ~${days}d ago (${last.source || "log"}).`
                : `Field memory: prior signal ${last.label}.`,
        );
    }
    if (typeof st?.stabilityScore === "number") {
        lines.push(`Stability index ${Math.round(st.stabilityScore)} — lower = more volatile recent stress.`);
    }
    if (!lines.length) lines.push("Connect location + run vision scans to unlock contextual explanations.");
    return lines;
}

function projectedRiskSeries(weatherBundle, historyFungal) {
    if (!weatherBundle?.daily?.precipitation_sum) return [];
    const daily = weatherBundle.daily;
    const n = Math.min(4, daily.precipitation_sum.length);
    const out = [];
    for (let i = 0; i < n; i++) {
        const rain = typeof daily.precipitation_sum[i] === "number" ? daily.precipitation_sum[i] : 0;
        const rhHint =
            weatherBundle.hourly?.relative_humidity_2m?.[i * 24] ??
            weatherBundle.current?.relative_humidity_2m ??
            65;
        let score = historyFungal * 0.35 + (rain > 6 ? 0.35 : rain > 2 ? 0.18 : 0.08);
        if (rhHint >= 80) score += 0.22;
        else if (rhHint >= 70) score += 0.12;
        out.push({
            dayIndex: i,
            label: i === 0 ? "Today" : `+${i}d`,
            score: clamp(score, 0, 1),
        });
    }
    return out;
}

export class FieldIntelligenceViz {
    /**
     * @param {{ host: HTMLElement, fieldId: string }} opts
     */
    constructor(opts) {
        this.host = opts.host;
        this.fieldId = opts.fieldId;
        /** @type {any} */
        this.data = {};
        this._zoom = 1;
        this._raf = 0;
        this._pulse = 0;
        this._weatherAtMs = 0;
        this._wheelBound = false;
    }

    /**
     * @param {any} pack
     */
    update(pack) {
        this.data = { ...this.data, ...pack };
    }

    stop() {
        if (this._raf) cancelAnimationFrame(this._raf);
        this._raf = 0;
    }

    async ensureWeather(lat, lon) {
        if (typeof lat !== "number" || typeof lon !== "number") return;
        if (this.data.weatherBundle && Date.now() - this._weatherAtMs < 240000) return;
        try {
            const b = await fetchOpenMeteoBundle(lat, lon);
            this.data.weatherBundle = b;
            this._weatherAtMs = Date.now();
        } catch {
            this.data.weatherBundle = this.data.weatherBundle || null;
        }
        this.render();
    }

    render() {
        this.stop();
        this._wheelBound = false;

        const h = this.host;
        if (!h) return;
        const d = this.data;
        const nodes = buildTimelineNodes(d.ctxState, d.ctxEvents, d.scans);
        const confPts = confidenceSeriesFromJobs(d.inferenceJobs || []);
        const fungal = fungalProxyFromWeather(d.weatherBundle);
        const stability = typeof d.ctxState?.stabilityScore === "number" ? d.ctxState.stabilityScore : null;

        const diseaseP =
            d.scans?.length && d.latestScan
                ? clamp(1 - (d.latestScan.healthScore || 60) / 100, 0.05, 0.95)
                : 0.2;
        const pestP = clamp(diseaseP * 0.85 + (d.scanPestHint || 0), 0.05, 0.95);
        const envStress = clamp(fungal * 0.55 + (d.latestMoisture != null ? Math.abs(65 - d.latestMoisture) / 120 : 0.15), 0.05, 0.95);
        const memoryV = stability != null ? clamp((100 - stability) / 100, 0.05, 1) : 0.25;

        h.innerHTML = `
<div class="fi-wrap">
  <section class="fi-hero glass-fi">
    <div class="fi-hero-label"><span class="fi-blink"></span> FIELD INTELLIGENCE // ${escapeHtml(this.fieldId.slice(0, 8))}</div>
    <div class="fi-orbit-row">
      <div class="fi-orbit" id="fi-orbit-svg-wrap"></div>
      <div class="fi-orbit-side" id="fi-orbit-legend"></div>
    </div>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>AI explanation engine</h4>
      <span class="fi-tag">live context</span>
    </div>
    <div class="fi-explain" id="fi-explain"></div>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>Field health timeline</h4>
      <span class="fi-hint">scroll · wheel zoom</span>
    </div>
    <div class="fi-timeline-outer" id="fi-tl-outer">
      <div class="fi-timeline-inner" id="fi-tl-inner"></div>
    </div>
    <div class="fi-tooltip" id="fi-tooltip" hidden></div>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>Outbreak recurrence heatmap</h4>
      <select id="fi-hm-range" class="fi-select">
        <option value="30">30 days</option>
        <option value="90" selected>90 days</option>
        <option value="365">12 months</option>
      </select>
    </div>
    <div class="fi-hm-wrap" id="fi-hm-wrap"></div>
    <p class="fi-disclaimer">Intensity = event counts from scans + field_context_events for this field.</p>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>Confidence evolution</h4>
      <span class="fi-tag">vision jobs</span>
    </div>
    <div class="fi-chart" id="fi-conf-chart"></div>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>Environmental pressure</h4>
    </div>
    <div class="fi-env-layers" id="fi-env"></div>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>Predictive stress window</h4>
      <span class="fi-tag proj">projection</span>
    </div>
    <div class="fi-proj" id="fi-proj"></div>
    <p class="fi-disclaimer">Dashed curve = heuristic from forecast humidity/rain + your field fungal history — not a guarantee.</p>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>AI field memory</h4>
    </div>
    <div class="fi-memory" id="fi-memory"></div>
  </section>

  <section class="fi-module glass-fi">
    <div class="fi-mod-head">
      <h4>Stability & recovery</h4>
    </div>
    <div class="fi-stab" id="fi-stab"></div>
  </section>
</div>`;

        this._renderOrbit([diseaseP, pestP, fungal, envStress, memoryV]);
        this._renderLegend([
            { k: "Disease pressure", v: diseaseP, c: "#39ff14" },
            { k: "Pest pressure", v: pestP, c: "#5eead4" },
            { k: "Fungal env.", v: fungal, c: "#a78bfa" },
            { k: "Weather stress", v: envStress, c: "#fbbf24" },
            { k: "Memory volatility", v: memoryV, c: "#fb7185" },
        ]);
        this._renderExplain(buildExplanationLines(d));
        this._renderTimeline(nodes);
        this._bindTimelineZoom();
        this._bindHeatmap();
        this._renderHeatmap(parseInt(h.querySelector("#fi-hm-range")?.value || "90", 10));
        this._renderConfChart(confPts);
        this._renderEnv(d.weatherBundle, fungal);
        this._renderProj(d.weatherBundle, fungal);
        this._renderMemory(d.ctxState);
        this._renderStability(d.scans, stability);
        this._startPulse();
    }

    _renderOrbit(values) {
        const wrap = this.host.querySelector("#fi-orbit-svg-wrap");
        if (!wrap) return;
        const s = 200;
        const cx = s / 2;
        const cy = s / 2;
        const rs = [72, 58, 44, 30, 18];
        let svg = `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" class="fi-orbit-svg">`;
        for (let i = 0; i < 5; i++) {
            const v = clamp(values[i] || 0, 0, 1);
            const r = rs[i];
            const C = 2 * Math.PI * r;
            const dash = v * C;
            const col = ["#39ff14", "#5eead4", "#a78bfa", "#fbbf24", "#fb7185"][i];
            svg += `<circle class="fi-ring-bg" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(57,255,20,0.12)" stroke-width="3"/>`;
            svg += `<circle class="fi-ring-fg" data-idx="${i}" cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${col}" stroke-width="3" stroke-dasharray="${dash} ${C}" stroke-linecap="round" transform="rotate(-90 ${cx} ${cy})" style="filter:url(#fi-glow)"/>`;
        }
        svg += `<defs><filter id="fi-glow"><feGaussianBlur stdDeviation="1.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
        svg += `<circle cx="${cx}" cy="${cy}" r="8" fill="rgba(57,255,20,0.25)" class="fi-core"/>`;
        svg += "</svg>";
        wrap.innerHTML = svg;
    }

    _renderLegend(items) {
        const el = this.host.querySelector("#fi-orbit-legend");
        if (!el) return;
        el.innerHTML = items
            .map(
                (x) => `
<div class="fi-leg-item">
  <span class="fi-dot" style="background:${x.c};box-shadow:0 0 10px ${x.c}66"></span>
  <div><div class="fi-leg-k">${escapeHtml(x.k)}</div><div class="fi-leg-v">${Math.round(x.v * 100)}%</div></div>
</div>`,
            )
            .join("");
    }

    _renderExplain(lines) {
        const el = this.host.querySelector("#fi-explain");
        if (!el) return;
        el.innerHTML = lines
            .map(
                (l, i) =>
                    `<div class="fi-explain-line" style="animation-delay:${i * 0.08}s"><span class="fi-chevron">›</span>${escapeHtml(l)}</div>`,
            )
            .join("");
    }

    _renderTimeline(nodes) {
        const inner = this.host.querySelector("#fi-tl-inner");
        if (!inner) return;
        if (!nodes.length) {
            inner.innerHTML = '<div class="fi-empty">No timeline events yet — save scans or run vision from Scanner.</div>';
            return;
        }
        const t0 = nodes[0].t;
        const t1 = nodes[nodes.length - 1].t;
        const span = Math.max(86400000, t1 - t0);
        const w = Math.max(640, (nodes.length * 56) + (span / 86400000) * 8);
        inner.style.width = `${w}px`;
        const kinds = {
            vision: { hue: "#39ff14", icon: "◉" },
            scan: { hue: "#5eead4", icon: "◇" },
            symptom: { hue: "#fbbf24", icon: "✦" },
            outbreak: { hue: "#fb7185", icon: "!" },
        };
        inner.innerHTML = nodes
            .map((n) => {
                const x = ((n.t - t0) / span) * (w - 80) + 40;
                const st = kinds[n.kind] || { hue: "#888", icon: "•" };
                const glow = 0.4 + (n.severity || 0.3) * 0.6;
                return `<button type="button" class="fi-node" data-tip="${escapeHtml(n.label)} · ${new Date(n.t).toLocaleString()}" style="left:${x}px;border-color:${st.hue};box-shadow:0 0 ${12 * glow}px ${st.hue}55;background:rgba(0,0,0,0.35)"><span class="fi-node-ic">${st.icon}</span><span class="fi-node-lbl">${escapeHtml(n.label)}</span></button>`;
            })
            .join("");
        inner.querySelectorAll(".fi-node").forEach((btn) => {
            btn.addEventListener("click", () => {
                const tip = this.host.querySelector("#fi-tooltip");
                if (!tip) return;
                tip.hidden = false;
                tip.textContent = btn.getAttribute("data-tip") || "";
                const r = btn.getBoundingClientRect();
                const rootR = this.host.getBoundingClientRect();
                tip.style.left = `${r.left - rootR.left + r.width / 2}px`;
                tip.style.top = `${r.top - rootR.top - 8}px`;
                clearTimeout(this._tipT);
                this._tipT = setTimeout(() => {
                    tip.hidden = true;
                }, 3400);
            });
        });
    }

    _bindTimelineZoom() {
        const outer = this.host.querySelector("#fi-tl-outer");
        const inner = this.host.querySelector("#fi-tl-inner");
        if (!outer || !inner || this._wheelBound) return;
        this._wheelBound = true;
        outer.addEventListener(
            "wheel",
            (e) => {
                e.preventDefault();
                this._zoom = clamp(this._zoom * (e.deltaY > 0 ? 0.92 : 1.08), 0.55, 2.4);
                inner.style.transform = `scaleX(${this._zoom})`;
                inner.style.transformOrigin = "left center";
            },
            { passive: false },
        );
    }

    _bindHeatmap() {
        const sel = this.host.querySelector("#fi-hm-range");
        sel?.addEventListener("change", () => {
            this._renderHeatmap(parseInt(sel.value, 10));
        });
    }

    _renderHeatmap(rangeDays) {
        const wrap = this.host.querySelector("#fi-hm-wrap");
        if (!wrap) return;
        const now = Date.now();
        const start = now - rangeDays * 86400000;
        const nWeeks = Math.min(52, Math.ceil(rangeDays / 7));
        const rowsMap = new Map();
        const addRow = (lab) => {
            const k = slug(lab);
            if (!k) return null;
            if (!rowsMap.has(k)) rowsMap.set(k, new Array(nWeeks).fill(0));
            return rowsMap.get(k);
        };
        const weekIndex = (t) => clamp(Math.floor((t - start) / (7 * 86400000)), 0, nWeeks - 1);
        for (const ev of this.data.ctxEvents || []) {
            const t = tsToMs(ev.createdAt);
            if (t < start) continue;
            const p = ev.payload || {};
            let lab = p.topHypothesis || p.diagnosisLabel;
            if (lab) {
                const row = addRow(lab);
                if (row) {
                    const wi = weekIndex(t);
                    row[wi] = (row[wi] || 0) + 1;
                }
            }
        }
        for (const s of this.data.scans || []) {
            const t = tsToMs(s.createdAt);
            if (t < start) continue;
            const lab = s.diagnosis?.label || s.diagnosis?.code;
            if (lab) {
                const row = addRow(lab);
                if (row) {
                    const wi = weekIndex(t);
                    row[wi] = (row[wi] || 0) + 1;
                }
            }
        }
        const rows = Array.from(rowsMap.entries());
        if (!rows.length) {
            wrap.innerHTML = '<div class="fi-empty">Not enough labeled events in this window.</div>';
            return;
        }
        let html = '<table class="fi-hm-table">';
        html += "<thead><tr><th>Signal</th>";
        for (let w = 0; w < nWeeks; w++) html += `<th>W${w + 1}</th>`;
        html += "</tr></thead><tbody>";
        let maxC = 1;
        for (const [, counts] of rows) {
            for (const c of counts) if (c > maxC) maxC = c;
        }
        for (const [k, counts] of rows.slice(0, 10)) {
            html += `<tr><td class="fi-hm-row">${escapeHtml(k)}</td>`;
            for (let w = 0; w < nWeeks; w++) {
                const c = counts[w] || 0;
                const a = c === 0 ? 0.08 : 0.2 + (c / maxC) * 0.85;
                html += `<td class="fi-hm-cell" style="--fi:${a};"><span class="fi-hm-fill"></span></td>`;
            }
            html += "</tr>";
        }
        html += "</tbody></table>";
        wrap.innerHTML = html;
    }

    _renderConfChart(pts) {
        const el = this.host.querySelector("#fi-conf-chart");
        if (!el) return;
        if (pts.length < 2) {
            el.innerHTML =
                '<div class="fi-empty">Need ≥2 completed vision jobs with confidence metadata for this field.</div>';
            return;
        }
        const W = 340;
        const H = 120;
        const pad = 14;
        const t0 = pts[0].t;
        const t1 = pts[pts.length - 1].t;
        const span = Math.max(1, t1 - t0);
        const linePath = (key) => {
            let d = "";
            let first = true;
            for (const p of pts) {
                const v = p[key];
                if (v == null) continue;
                const x = pad + ((p.t - t0) / span) * (W - pad * 2);
                const y = pad + (1 - v) * (H - pad * 2);
                d += `${first ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
                first = false;
            }
            return d;
        };
        const pModel = linePath("model");
        const pAdj = linePath("adjusted");
        el.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" class="fi-conf-svg">
  <defs>
    <linearGradient id="fi-cg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#39ff14" stop-opacity="0.5"/><stop offset="100%" stop-color="#39ff14" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <text x="${pad}" y="11" fill="#8b9d8b" font-size="9">model</text>
  <text x="${pad + 44}" y="11" fill="#39ff14" font-size="9">adjusted</text>
  ${pModel ? `<path d="${pModel}" fill="none" stroke="#8b9d8b" stroke-width="2" stroke-dasharray="4 3" />` : ""}
  ${pAdj ? `<path d="${pAdj}" fill="none" stroke="#39ff14" stroke-width="2.5" />` : ""}
</svg>`;
    }

    _renderEnv(bundle, fungal) {
        const el = this.host.querySelector("#fi-env");
        if (!el) return;
        const rh = bundle?.current?.relative_humidity_2m;
        const t = bundle?.current?.temperature_2m;
        const rain = bundle?.daily?.precipitation_sum?.[0];
        const layers = [
            { k: "Humidity stress", v: rh != null ? clamp((rh - 50) / 50, 0, 1) : null, sub: rh != null ? `${Math.round(rh)}% RH` : "—" },
            { k: "Rain intensity (today)", v: rain != null ? clamp(rain / 25, 0, 1) : null, sub: rain != null ? `${rain.toFixed(1)} mm` : "—" },
            { k: "Heat load", v: t != null ? clamp((t - 22) / 18, 0, 1) : null, sub: t != null ? `${Math.round(t)}°C` : "—" },
            { k: "Fungal environment (proxy)", v: fungal, sub: `${Math.round(fungal * 100)}% index` },
        ];
        el.innerHTML = layers
            .map((L) => {
                const w = L.v == null ? 8 : Math.round(L.v * 100);
                return `<div class="fi-env-row"><div class="fi-env-k">${escapeHtml(L.k)}<span>${escapeHtml(L.sub)}</span></div><div class="fi-env-bar"><span style="width:${w}%"></span></div></div>`;
            })
            .join("");
    }

    _renderProj(bundle, histFungal) {
        const el = this.host.querySelector("#fi-proj");
        if (!el) return;
        const series = projectedRiskSeries(bundle, histFungal);
        if (!series.length) {
            el.innerHTML = '<div class="fi-empty">Forecast unavailable — enable location / network.</div>';
            return;
        }
        const W = 340;
        const H = 100;
        const pad = 12;
        const maxS = Math.max(...series.map((s) => s.score), 0.01);
        let d = "";
        series.forEach((s, i) => {
            const x = pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2);
            const y = pad + (1 - s.score / maxS) * (H - pad * 2);
            d += `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
        });
        el.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" class="fi-proj-svg">
  <path d="${d}" fill="none" stroke="#a78bfa" stroke-width="2.5" stroke-dasharray="6 4" />
  ${series
      .map((s, i) => {
          const x = pad + (i / Math.max(1, series.length - 1)) * (W - pad * 2);
          return `<text x="${x - 10}" y="${H - 4}" fill="#8b9d8b" font-size="8">${escapeHtml(s.label)}</text>`;
      })
      .join("")}
</svg>`;
    }

    _renderMemory(state) {
        const el = this.host.querySelector("#fi-memory");
        if (!el) return;
        const labs = state?.lastVisionLabels || [];
        const out = Array.isArray(state?.outbreakHistory) ? state.outbreakHistory.slice(0, 8) : [];
        if (!labs.length && !out.length) {
            el.innerHTML = '<div class="fi-empty">Memory builds from vision runs and symptom scans linked to this field.</div>';
            return;
        }
        let html = '<div class="fi-mem-grid">';
        for (const o of out) {
            const ago = o.at ? `${Math.max(0, Math.floor((Date.now() - o.at) / 86400000))}d ago` : "";
            html += `<div class="fi-mem-card"><div class="fi-mem-title">${escapeHtml(o.label || "")}</div><div class="fi-mem-meta">${escapeHtml(o.source || "")} · ${ago}</div></div>`;
        }
        html += "</div>";
        if (labs.length) {
            html += `<div class="fi-chip-row">${labs.map((x) => `<span class="fi-chip">${escapeHtml(x)}</span>`).join("")}</div>`;
        }
        el.innerHTML = html;
    }

    _renderStability(scansAsc, stability) {
        const el = this.host.querySelector("#fi-stab");
        if (!el) return;
        const pts = (scansAsc || [])
            .slice()
            .sort((a, b) => tsToMs(a.createdAt) - tsToMs(b.createdAt))
            .map((s) => (typeof s.healthScore === "number" ? s.healthScore : null))
            .filter((x) => x != null);
        let svg = "";
        if (pts.length >= 2) {
            const W = 320;
            const H = 72;
            const pad = 8;
            const min = Math.min(...pts);
            const max = Math.max(...pts);
            const dx = (W - pad * 2) / (pts.length - 1);
            const path = pts
                .map((v, i) => {
                    const x = pad + i * dx;
                    const t = max === min ? 0.5 : (v - min) / (max - min);
                    const y = pad + (1 - t) * (H - pad * 2);
                    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
                })
                .join(" ");
            svg = `<svg viewBox="0 0 ${W} ${H}" class="fi-stab-svg"><path d="${path}" fill="none" stroke="#39ff14" stroke-width="2" /></svg>`;
        }
        el.innerHTML = `
${svg || '<div class="fi-empty">Add more scans to plot recovery trajectory.</div>'}
<div class="fi-stab-meta">Field stability index (AI): <strong>${stability != null ? Math.round(stability) : "—"}</strong> · higher = calmer recent history</div>`;
    }

    _startPulse() {
        if (this._raf) cancelAnimationFrame(this._raf);
        const tick = () => {
            this._pulse += 0.04;
            const rings = this.host.querySelectorAll(".fi-ring-fg");
            rings.forEach((r, idx) => {
                r.style.opacity = String(0.7 + Math.sin(this._pulse + idx * 0.45) * 0.14);
            });
            const core = this.host.querySelector(".fi-core");
            if (core) {
                core.setAttribute("r", String(8 + Math.sin(this._pulse * 1.2) * 1.5));
            }
            this._raf = requestAnimationFrame(tick);
        };
        this._raf = requestAnimationFrame(tick);
    }
}
