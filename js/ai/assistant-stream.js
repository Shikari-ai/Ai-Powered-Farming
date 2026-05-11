/**
 * Client-side assistant reply streaming (Phase 1 + rhythm polish).
 * Progressive reveal with human-like pacing, grouped chunks, caret, fast-forward.
 * Server / SSE can later feed the same batch or append queue without changing the shell contract.
 */

/** @param {number} min @param {number} max */
function randBetween(min, max) {
    return min + Math.random() * (max - min);
}

/** @param {string} fullText @param {string} streamProfile */
export function detectRhythmTone(fullText, streamProfile) {
    if (
        streamProfile === "casual" ||
        streamProfile === "clarify" ||
        streamProfile === "micro_social" ||
        streamProfile === "operations_quick"
    )
        return "casual";
    const t = String(fullText || "").toLowerCase();
    if (/\b(urgent|alert|unread alerts|critical risk|asap|immediately|take action now|imminent)\b/.test(t)) return "operational";
    if (
        String(fullText || "").length > 420 &&
        /\b(because|therefore|however|analysis|probability|calibration|inferred|epidemic|forecast)\b/.test(t)
    ) {
        return "thoughtful";
    }
    return "balanced";
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

/** @param {string} s */
function nonWsLen(s) {
    return s.replace(/\s+/g, "").length;
}

/** @param {string} buf */
function shouldSoftSentenceBreak(buf) {
    const t = buf.trimEnd();
    if (t.length < 8) return false;
    if (/[.!?]["']?\s*$/.test(t) && Math.random() < 0.8) return true;
    if (/[,;:]["']?\s*$/.test(t) && t.length > 16 && Math.random() < 0.42) return true;
    return false;
}

/**
 * Phrase- and breath-aware batches: variable chunk sizes, paragraph boundaries, light sentence breaks.
 * @param {string} fullText
 * @param {string} streamProfile
 * @param {string} rhythmTone casual | operational | thoughtful | balanced
 */
export function buildRevealBatches(fullText, streamProfile, rhythmTone = "balanced") {
    const units = tokenizeStreamUnits(fullText);
    const batches = [];
    let buf = "";
    const nw = nonWsLen(fullText);

    const nextTarget = () => {
        if (streamProfile === "casual" || streamProfile === "clarify") {
            if (nw < 320) return randBetween(12, 26);
            return randBetween(18, 38);
        }
        if (streamProfile === "micro_social") return randBetween(10, 24);
        if (streamProfile === "operations_quick") {
            return nw < 620 ? randBetween(14, 28) : randBetween(18, 36);
        }
        if (streamProfile === "weather_quick") return nw < 540 ? randBetween(10, 22) : randBetween(15, 32);
        if (rhythmTone === "operational") return randBetween(24, 48);
        if (rhythmTone === "thoughtful") return randBetween(9, 22);
        return randBetween(14, 30);
    };

    let target = nextTarget();

    const flush = () => {
        if (buf) batches.push(buf);
        buf = "";
        target = nextTarget();
    };

    for (let i = 0; i < units.length; i++) {
        const u = units[i];
        if (/^\s+$/.test(u)) {
            if (u.includes("\n\n")) {
                flush();
                batches.push(u);
                continue;
            }
            buf += u;
            const n = nonWsLen(buf);
            if (n >= target || shouldSoftSentenceBreak(buf)) flush();
            continue;
        }
        buf += u;
        const n = nonWsLen(buf);
        if (n >= target) flush();
        else if (n >= 10 && shouldSoftSentenceBreak(buf)) flush();
    }
    flush();
    return batches.filter(Boolean);
}

function baseBatchMs(streamProfile, rhythmTone) {
    let lo = 12;
    let hi = 22;
    if (streamProfile === "casual" || streamProfile === "clarify" || streamProfile === "micro_social") {
        lo = 9;
        hi = 16;
    } else if (streamProfile === "weather_quick" || streamProfile === "operations_quick") {
        lo = 8;
        hi = 14;
    } else if (rhythmTone === "thoughtful") {
        lo = 16;
        hi = 30;
    } else if (rhythmTone === "operational") {
        lo = 11;
        hi = 19;
    }
    return randBetween(lo, hi);
}

/**
 * @param {string} batch
 * @param {string} streamProfile
 * @param {string} rhythmTone
 * @param {number} batchIndex
 * @param {number} totalBatches
 * @param {number} nwTotal non-whitespace len of entire reply (for pacing)
 */
function delayAfterBatch(batch, streamProfile, rhythmTone, batchIndex, totalBatches, nwTotal = 999999) {
    if (!batch) return 0;
    const trimmed = batch.trim();
    const last = trimmed[trimmed.length - 1] || "";

    let extra = 0;
    if (/^\s+$/.test(batch)) {
        if (batch.includes("\n\n")) extra = randBetween(55, 130);
        else if (batch.includes("\n")) {
            const bullet = /\n(?:[•\-–—]|\d+\.)\s/.test(batch);
            extra = (bullet ? randBetween(48, 88) : randBetween(24, 52)) + batch.length * 0.65;
        } else extra = Math.min(14, batch.length * 1.4);
        return extra;
    }

    if (/[,:;]/.test(last)) extra += randBetween(22, 58);
    if (/[.]/.test(last)) extra += randBetween(72, 165);
    if (/[!]/.test(last)) extra += randBetween(88, 185);
    if (/\?/.test(last)) extra += randBetween(78, 155);

    if (/^[•\-–—]/.test(trimmed) || /^\d+\./.test(trimmed)) extra += randBetween(32, 72);

    if (/\b(important|critical|recommended|priority|caution|warning)\b/i.test(batch)) {
        extra += randBetween(35, 95);
    }
    if (/\*\*[^*]{3,}\*\*/.test(batch)) {
        extra += randBetween(18, 55);
    }

    const base = baseBatchMs(streamProfile, rhythmTone);
    const charCost = Math.min(trimmed.length, 48) * 0.42;
    const jitter = randBetween(0.8, 1.28);

    const doneRatio = (batchIndex + 1) / Math.max(1, totalBatches);
    let easeOut = 1;
    if (doneRatio > 0.82) {
        const tail = (doneRatio - 0.82) / 0.18;
        easeOut = 1 + tail * tail * randBetween(0.35, 0.85);
    }

    if (rhythmTone === "casual") extra *= randBetween(0.82, 0.96);
    if (rhythmTone === "thoughtful") extra *= randBetween(1.05, 1.22);
    if (rhythmTone === "operational") extra *= randBetween(0.9, 1.05);

    let dur = (base + charCost) * jitter * easeOut + extra;
    const shortEngineReply =
        (streamProfile === "weather_quick" || streamProfile === "micro_social") && totalBatches < 12;
    const shortSocialLike = nwTotal < 380 && ["casual", "clarify", "micro_social", "operations_quick"].includes(streamProfile);
    if (shortEngineReply || shortSocialLike) dur *= randBetween(0.72, 0.94);

    return dur;
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
 * Future: feed tokens from SSE / WebSocket.
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
 * @property {HTMLElement} textHost El with .stream-plain and .stream-caret
 * @property {string} fullText
 * @property {string} [streamProfile]
 * @property {string} [rhythmTone] casual | operational | thoughtful | balanced (optional; derived if omitted)
 * @property {AbortSignal} [signal]
 * @property {() => boolean} [shouldFollowScroll]
 * @property {(el: HTMLElement) => HTMLElement | null} [getScrollRoot]
 * @property {() => void} [onFirstChar]
 * @property {number} [streamLeadInMs] conversational pause before first reveal batch
 */

/**
 * @param {StreamOptions} opts
 * @returns {{ promise: Promise<'done' | 'aborted'>, fastForward: () => void, dispose: () => void }}
 */
export function runAssistantTextStream(opts) {
    const {
        textHost,
        fullText,
        streamProfile = "full",
        rhythmTone: rhythmToneOpt,
        signal,
        shouldFollowScroll,
        getScrollRoot,
        onFirstChar,
        streamLeadInMs = 0,
    } = opts;

    const plainEl = textHost.querySelector(".stream-plain");
    const caretEl = textHost.querySelector(".stream-caret");
    const rhythmTone = rhythmToneOpt || detectRhythmTone(fullText, streamProfile);
    const batches = buildRevealBatches(fullText, streamProfile, rhythmTone);
    const nwTotal = nonWsLen(fullText);

    const root =
        (getScrollRoot && textHost && getScrollRoot(textHost)) ||
        document.scrollingElement ||
        document.documentElement;

    let acc = "";
    let idx = 0;
    let aborted = false;
    let fastForwardRequested = false;
    let first = true;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {((v: 'done' | 'aborted') => void) | null} */
    let resolveOuter = null;

    const clearTimer = () => {
        if (timer != null) {
            clearTimeout(timer);
            timer = null;
        }
    };

    const settle = (/** @type {'done' | 'aborted'} */ result) => {
        if (settled) return;
        settled = true;
        clearTimer();
        signal?.removeEventListener("abort", onAbort);
        resolveOuter?.(result);
    };

    const onAbort = () => {
        aborted = true;
        clearTimer();
        // Mark the caret as fading even if we never started the stream, so the
        // visual state matches "we stopped" rather than "still thinking".
        try {
            textHost.classList.remove("is-streaming", "stream-speaking");
        } catch { /* ignore */ }
        settle("aborted");
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    function gentleScroll() {
        if (!shouldFollowScroll || !shouldFollowScroll()) return;
        try {
            root.scrollTo({ top: root.scrollHeight, behavior: "auto" });
        } catch {
            root.scrollTop = root.scrollHeight;
        }
    }

    const promise = new Promise((resolve) => {
        resolveOuter = resolve;

        // Abort may have arrived synchronously between addEventListener and here;
        // honor it before scheduling anything.
        if (aborted || signal?.aborted) {
            settle("aborted");
            return;
        }

        const finalize = (skipCaretFade) => {
            clearTimer();

            const applyRich = () => {
                if (settled) return;
                textHost.innerHTML = formatAssistantRichText(fullText);
                textHost.classList.add("is-rich");
                textHost.classList.remove("is-streaming", "stream-speaking");
                gentleScroll();
                settle("done");
            };

            if (skipCaretFade || !caretEl) {
                requestAnimationFrame(applyRich);
                return;
            }

            caretEl.classList.add("stream-caret-out");
            const doneMs = 340;
            const t = setTimeout(() => {
                if (settled) return;
                requestAnimationFrame(applyRich);
            }, doneMs);
            timer = /** @type {any} */ (t);
        };

        const step = () => {
            clearTimer();
            if (aborted || signal?.aborted) {
                settle("aborted");
                return;
            }

            if (fastForwardRequested) {
                acc = fullText;
                idx = batches.length;
            }

            if (idx >= batches.length) {
                requestAnimationFrame(() => {
                    if (plainEl) plainEl.textContent = acc;
                    caretEl?.classList.remove("stream-caret-out");
                    finalize(!!fastForwardRequested);
                });
                return;
            }

            const batch = batches[idx];
            idx += 1;
            acc += batch;

            requestAnimationFrame(() => {
                if (plainEl) {
                    plainEl.textContent = acc;
                    plainEl.classList.add("stream-plain-visible");
                }
                if (first && acc.length > 0) {
                    first = false;
                    textHost.classList.add("stream-speaking");
                    try {
                        onFirstChar?.();
                    } catch {
                        /* ignore */
                    }
                }
                gentleScroll();
            });

            if (idx >= batches.length) {
                timer = setTimeout(
                    step,
                    Math.max(8, Math.round(delayAfterBatch(batch, streamProfile, rhythmTone, idx - 1, batches.length, nwTotal) * 0.34)),
                );
                return;
            }

            const next = batches[idx] || "";
            const pauseMul =
                /[.!?]$/.test(batch.trimEnd()) ? randBetween(1.08, 1.28) : /[,;:]$/.test(batch.trimEnd()) ? randBetween(1.02, 1.12) : 1;
            const d1 = delayAfterBatch(batch, streamProfile, rhythmTone, idx - 1, batches.length, nwTotal);
            const d2 = next ? delayAfterBatch(next, streamProfile, rhythmTone, idx, batches.length, nwTotal) * 0.22 : 0;
            const delay = Math.max(8, Math.round((d1 + d2) * pauseMul));

            timer = setTimeout(step, fastForwardRequested ? 0 : delay);
        };

        const lead = Math.max(0, Math.round(streamLeadInMs || 0));
        if (lead > 0) {
            timer = setTimeout(() => requestAnimationFrame(step), lead);
        } else {
            requestAnimationFrame(step);
        }
    });

    return {
        promise,
        fastForward: () => {
            fastForwardRequested = true;
        },
        dispose: () => {
            aborted = true;
            settle("aborted");
        },
    };
}
