/**
 * Client-side assistant reply streaming (Phase 1).
 * Punctuation-aware pacing, scroll-friendly updates, AbortSignal cancellation.
 * Server / SSE / WebSocket chunk feeds can call the same formatter + flush pattern later via pushStreamChunk().
 */

/** @param {number} min @param {number} max */
function randBetween(min, max) {
    return min + Math.random() * (max - min);
}

/** @param {string} fullText */
export function tokenizeStreamUnits(fullText) {
    const s = String(fullText || "");
    const units = [];
    let i = 0;
    const n = s.length;
    while (i < n) {
        if (/\s/.test(s[i])) {
            let j = i;
            while (j < n && /\s/.test(s[j])) j++;
            units.push(s.slice(i, j));
            i = j;
            continue;
        }
        let j = i;
        while (j < n && !/\s/.test(s[j])) j++;
        units.push(s.slice(i, j));
        i = j;
    }
    return units;
}

function baseWordMs(profile) {
    switch (profile) {
        case "casual":
        case "clarify":
            return randBetween(11, 19);
        case "weather_quick":
            return randBetween(8, 15);
        default:
            return randBetween(14, 24);
    }
}

/**
 * @param {string} unit
 * @param {string} streamProfile
 */
function delayAfterUnit(unit, streamProfile) {
    if (!unit) return 0;
    if (/^\s+$/.test(unit)) {
        if (unit.includes("\n\n")) return randBetween(45, 110);
        if (unit.includes("\n")) {
            const isBulletBreak = /\n(?:[•\-–—]|\d+\.)\s/.test(unit) || /\n\s*\n/.test(unit);
            return (isBulletBreak ? randBetween(55, 95) : randBetween(22, 48)) + unit.length * 0.8;
        }
        return Math.min(12, unit.length * 1.2);
    }
    const trimmed = unit.replace(/\s+$/, "");
    const last = trimmed[trimmed.length - 1] || "";
    let extra = 0;
    if (/[,:;]/.test(last)) extra += randBetween(28, 62);
    if (/[.!?]/.test(last)) extra += randBetween(85, 175);
    if (/^[•\-–—]/.test(trimmed) || /^\d+\./.test(trimmed)) extra += randBetween(35, 75);
    const jitter = randBetween(0.84, 1.22);
    const wordCost = Math.min(trimmed.length, 22) * 0.55;
    return (baseWordMs(streamProfile) + wordCost) * jitter + extra;
}

function escapeHtml(s) {
    return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

/**
 * Safe subset for assistant replies: bold, fenced code, newlines.
 * @param {string} raw
 */
export function formatAssistantRichText(raw) {
    const text = String(raw || "");
    if (!text) return "";
    const parts = text.split(/(```[\s\S]*?```)/g);
    const out = [];
    for (const block of parts) {
        if (/^```/.test(block)) {
            const m = block.match(/^```(\w*)\n?([\s\S]*)```$/);
            const code = m ? m[2] : block.replace(/```/g, "");
            out.push(`<pre class="assist-pre"><code>${escapeHtml(code)}</code></pre>`);
            continue;
        }
        let t = escapeHtml(block);
        t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
        t = t.replace(/\n/g, "<br>");
        out.push(t);
    }
    return out.join("");
}

/**
 * Future: feed tokens from SSE / WebSocket. For now, unused stub.
 * @param {{ onChunk?: (s: string) => void, onDone?: () => void }} _
 */
export function createServerChunkStreamAdapter(_) {
    return {
        /** @param {string} _piece */
        push(_piece) {},
        end() {},
        reset() {},
    };
}

/**
 * @typedef {Object} StreamOptions
 * @property {HTMLElement} textEl
 * @property {string} fullText
 * @property {string} [streamProfile] casual | clarify | weather_quick | full
 * @property {AbortSignal} [signal]
 * @property {() => boolean} [shouldFollowScroll] return true if assistant may auto-scroll
 * @property {(el: HTMLElement) => HTMLElement | null} [getScrollRoot]
 * @property {() => void} [onFirstChar]
 */

/**
 * @param {StreamOptions} opts
 * @returns {Promise<'done' | 'aborted'>}
 */
export async function runAssistantTextStream(opts) {
    const {
        textEl,
        fullText,
        streamProfile = "full",
        signal,
        shouldFollowScroll,
        getScrollRoot,
        onFirstChar,
    } = opts;

    const root =
        (getScrollRoot && textEl && getScrollRoot(textEl)) ||
        document.scrollingElement ||
        document.documentElement;

    const units = tokenizeStreamUnits(fullText);
    let acc = "";
    let idx = 0;
    let aborted = false;
    let first = true;

    const onAbort = () => {
        aborted = true;
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const wordsPerTick = units.length > 420 ? 3 : units.length > 220 ? 2 : 1;

    function gentleScroll() {
        if (!shouldFollowScroll || !shouldFollowScroll()) return;
        try {
            root.scrollTo({ top: root.scrollHeight, behavior: "auto" });
        } catch {
            root.scrollTop = root.scrollHeight;
        }
    }

    return new Promise((resolve) => {
        const step = () => {
            if (aborted || signal?.aborted) {
                signal?.removeEventListener("abort", onAbort);
                resolve("aborted");
                return;
            }
            if (idx >= units.length) {
                requestAnimationFrame(() => {
                    textEl.innerHTML = formatAssistantRichText(fullText);
                    textEl.classList.add("is-rich");
                    signal?.removeEventListener("abort", onAbort);
                    gentleScroll();
                    resolve("done");
                });
                return;
            }
            let batch = "";
            for (let k = 0; k < wordsPerTick && idx < units.length; k++) {
                batch += units[idx];
                idx++;
            }
            acc += batch;
            requestAnimationFrame(() => {
                textEl.textContent = acc;
                if (first && acc.length > 0) {
                    first = false;
                    try {
                        onFirstChar?.();
                    } catch {
                        /* ignore */
                    }
                }
                gentleScroll();
            });

            if (idx >= units.length) {
                setTimeout(step, Math.max(8, Math.round(delayAfterUnit(batch, streamProfile) * 0.45)));
                return;
            }
            const tail = batch[batch.length - 1] || "";
            const nextUnit = units[idx] || "";
            const pauseMul = /[.!?]$/.test(batch.trimEnd()) ? 1.15 : /[,;:]$/.test(tail) ? 1.08 : 1;
            const d = (delayAfterUnit(batch, streamProfile) + delayAfterUnit(nextUnit, streamProfile) * 0.25) * pauseMul;
            setTimeout(step, Math.max(4, Math.round(d)));
        };

        requestAnimationFrame(step);
    });
}
