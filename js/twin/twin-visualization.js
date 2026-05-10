/**
 * Calm SVG visualizations for multi-scenario twin comparisons (no external chart lib).
 */

function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
}

const PALETTE = ["#39ff14", "#5eead4", "#fbbf24", "#f472b6"];

/**
 * @param {{ meta: { label: string }, projection: { steps: any[] } }[]} suite
 * @param {{ replayDay?: number }} [opts]
 * @returns {string} SVG markup
 */
export function buildTwinTrajectorySvg(suite, opts = {}) {
    const replayDay = clamp(opts.replayDay ?? -1, -1, 99);
    const w = 320;
    const h = 120;
    const padL = 28;
    const padR = 10;
    const padT = 10;
    const padB = 22;
    const innerW = w - padL - padR;
    const innerH = h - padT - padB;

    const allHealth = [];
    for (const s of suite) {
        for (const pt of s.projection?.steps || []) {
            allHealth.push(pt.health, pt.healthLow, pt.healthHigh);
        }
    }
    let yMin = Math.min(...allHealth, 40);
    let yMax = Math.max(...allHealth, 95);
    if (yMax - yMin < 12) {
        const mid = (yMin + yMax) / 2;
        yMin = mid - 8;
        yMax = mid + 8;
    }

    const yScale = (val) => padT + innerH * (1 - (val - yMin) / (yMax - yMin));
    const xScale = (i, n) => padL + (innerW * i) / Math.max(1, n - 1);

    const paths = [];
    const bands = [];
    suite.forEach((s, si) => {
        const steps = s.projection?.steps || [];
        if (steps.length < 2) return;
        const color = PALETTE[si % PALETTE.length];
        const n = steps.length;
        let dBand = "";
        for (let i = 0; i < n; i++) {
            const x = xScale(i, n);
            const yLo = yScale(steps[i].healthLow);
            const x2 = x;
            const yHi = yScale(steps[i].healthHigh);
            if (i === 0) dBand = `M ${x.toFixed(1)},${yLo.toFixed(1)}`;
            else dBand += ` L ${x.toFixed(1)},${yLo.toFixed(1)}`;
        }
        for (let i = n - 1; i >= 0; i--) {
            dBand += ` L ${xScale(i, n).toFixed(1)},${yScale(steps[i].healthHigh).toFixed(1)}`;
        }
        dBand += " Z";
        bands.push(
            `<path d="${dBand}" fill="${color}" fill-opacity="0.12" stroke="none" aria-hidden="true"/>`,
        );

        let d = "";
        const limit = replayDay >= 0 ? clamp(replayDay + 1, 2, n) : n;
        for (let i = 0; i < limit; i++) {
            const x = xScale(i, n);
            const y = yScale(steps[i].health);
            d += `${i === 0 ? "M" : "L"} ${x.toFixed(1)},${y.toFixed(1)} `;
        }
        paths.push(
            `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" opacity="0.95"/>`,
        );
    });

    let vx = null;
    if (replayDay >= 0 && suite[0]?.projection?.steps?.length) {
        const n = suite[0].projection.steps.length;
        vx = xScale(clamp(replayDay, 0, n - 1), n);
    }
    const replayLine =
        vx != null
            ? `<line x1="${vx.toFixed(1)}" y1="${padT}" x2="${vx.toFixed(1)}" y2="${h - padB}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="4 3"/>`
            : "";

    const legendParts = [];
    suite.forEach((s, i) => {
        if (i) legendParts.push(`<tspan fill="rgba(255,255,255,0.35)"> · </tspan>`);
        legendParts.push(`<tspan fill="${PALETTE[i % PALETTE.length]}">${escapeXml(s.meta.label)}</tspan>`);
    });
    const legendRow = `<text x="${padL}" y="${h - 6}" font-size="9" font-family="system-ui,sans-serif">${legendParts.join("")}</text>`;

    return `<svg class="twin-twin-svg" viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Simulated health trajectories">${bands.join("")}${replayLine}${paths.join("")}<text x="${padL}" y="16" fill="rgba(255,255,255,0.45)" font-size="9" font-family="system-ui,sans-serif">Health (simulated bands)</text>${legendRow}</svg>`;
}

function escapeXml(s) {
    return String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * @param {{ meta: any, projection: any }} item
 */
export function formatScenarioCard(item) {
    const p = item.projection;
    const end = p?.summary?.endHealth;
    const fung = p?.summary?.endFungal;
    const stab = p?.summary?.endStability;
    const w = p?.operationalImpact;
    return {
        title: item.meta.label,
        body: item.meta.description,
        metrics: [
            end != null ? `Est. end health ~${Math.round(end)}%` : "",
            fung != null ? `Fungal pressure index ~${Math.round(fung * 100)}%` : "",
            stab != null ? `Stability ~${Math.round(stab * 100)}%` : "",
            w ? `Inspect load (model) ~${w.suggestedInspections7d} pass(es)` : "",
        ].filter(Boolean),
    };
}
