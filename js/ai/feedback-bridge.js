/**
 * feedback-bridge.js
 *
 * Bridges scan results + user corrections to the FastAPI training pipeline
 * ( POST /v1/feedback/scan ).
 *
 * Responsibilities
 * ─────────────────
 *  1. Anonymise the user ID (SHA-256[:12]) so no PII hits the server.
 *  2. Queue submissions in localStorage when offline; drain on next page load.
 *  3. Respect an explicit per-user opt-in stored under the key
 *     "agrosphere_feedback_consent" in localStorage.
 *
 * Usage
 * ──────
 *  import { FeedbackBridge } from "./feedback-bridge.js";
 *  const bridge = new FeedbackBridge({ apiBase: "https://api.example.com" });
 *
 *  // After a scan completes:
 *  bridge.onScanResult({ uid, original, confidence, crop, imageBlob });
 *
 *  // When a user corrects the label:
 *  bridge.onUserCorrection({ rowId, corrected });
 */

const CONSENT_KEY      = "agrosphere_feedback_consent";
const QUEUE_KEY        = "agrosphere_feedback_queue";
const MAX_QUEUE_LEN    = 40;   // cap offline queue size
const MAX_IMAGE_BYTES  = 3 * 1024 * 1024; // 3 MB hard limit before upload

/** SHA-256 of a string, hex-encoded. Uses Web Crypto (no dep). */
async function sha256hex(str) {
    const buf  = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 12);
}

/** Read the offline queue from localStorage. */
function readQueue() {
    try {
        return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]");
    } catch {
        return [];
    }
}

/** Persist the offline queue. */
function saveQueue(q) {
    try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE_LEN)));
    } catch {
        // quota exceeded — drop silently
    }
}

export class FeedbackBridge {
    /**
     * @param {{
     *   apiBase?: string,
     *   onConsent?: () => Promise<boolean>,
     * }} opts
     *
     *  apiBase   — server root, e.g. "https://api.agrosphere.app"
     *  onConsent — async fn to show a consent prompt; must return true/false.
     *              If omitted, consent defaults to whatever's in localStorage.
     */
    constructor({ apiBase = "", onConsent } = {}) {
        this._base    = apiBase.replace(/\/$/, "");
        this._consent = onConsent || null;
        // Drain any queued items from a previous offline session
        this._drainQueue();
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Call immediately after a scan result is available.
     *
     * @param {{
     *   uid: string,
     *   original: string,
     *   confidence: number,
     *   crop?: string,
     *   imageBlob?: Blob | null,
     * }} params
     * @returns {Promise<{ rowId: number | null }>}
     */
    async onScanResult({ uid, original, confidence, crop = null, imageBlob = null }) {
        if (!await this._checkConsent()) {
            return { rowId: null };
        }

        const sessionId = await sha256hex(uid || "anon");
        const form = new FormData();
        form.append("session_id", sessionId);
        form.append("original",   original);
        form.append("confidence", String(confidence));
        if (crop) form.append("crop", crop);

        if (imageBlob && imageBlob.size <= MAX_IMAGE_BYTES) {
            form.append("image", imageBlob, "scan.jpg");
        }

        try {
            const res = await this._post("/v1/feedback/scan", form);
            return { rowId: res.row_id ?? null };
        } catch (err) {
            this._enqueue({ type: "scan", sessionId, original, confidence, crop });
            return { rowId: null };
        }
    }

    /**
     * Call when the user overrides the predicted label.
     *
     * @param {{ rowId: number, corrected: string }} params
     * @returns {Promise<boolean>} true on success
     */
    async onUserCorrection({ rowId, corrected }) {
        if (!rowId) return false;
        try {
            await this._post("/v1/feedback/label", JSON.stringify({ row_id: rowId, corrected }), {
                "Content-Type": "application/json",
            });
            return true;
        } catch (err) {
            this._enqueue({ type: "label", rowId, corrected });
            return false;
        }
    }

    // ── Consent ─────────────────────────────────────────────────────────────

    async _checkConsent() {
        const stored = localStorage.getItem(CONSENT_KEY);
        if (stored === "true")  return true;
        if (stored === "false") return false;

        // First time: ask if a prompt handler is provided, else default to opt-in
        if (this._consent) {
            const agreed = await this._consent();
            localStorage.setItem(CONSENT_KEY, String(agreed));
            return agreed;
        }

        // No prompt configured → opt-out by default (safe)
        localStorage.setItem(CONSENT_KEY, "false");
        return false;
    }

    // ── Offline queue ────────────────────────────────────────────────────────

    _enqueue(item) {
        const q = readQueue();
        q.push({ ...item, ts: Date.now() });
        saveQueue(q);
    }

    async _drainQueue() {
        const q = readQueue();
        if (!q.length) return;
        const remaining = [];
        for (const item of q) {
            let ok = false;
            try {
                if (item.type === "scan") {
                    const form = new FormData();
                    form.append("session_id", item.sessionId);
                    form.append("original",   item.original);
                    form.append("confidence", String(item.confidence));
                    if (item.crop) form.append("crop", item.crop);
                    await this._post("/v1/feedback/scan", form);
                    ok = true;
                } else if (item.type === "label") {
                    await this._post(
                        "/v1/feedback/label",
                        JSON.stringify({ row_id: item.rowId, corrected: item.corrected }),
                        { "Content-Type": "application/json" },
                    );
                    ok = true;
                }
            } catch {
                /* stay in queue */
            }
            if (!ok) remaining.push(item);
        }
        saveQueue(remaining);
    }

    // ── HTTP helpers ─────────────────────────────────────────────────────────

    async _post(path, body, extraHeaders = {}) {
        const res = await fetch(`${this._base}${path}`, {
            method: "POST",
            body,
            headers: extraHeaders,
        });
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} on ${path}`);
        }
        return res.json();
    }
}
