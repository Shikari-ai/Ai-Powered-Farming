/**
 * Firebase Cloud Functions — optional HTTP utilities.
 * Conversational assistant runs fully in the web client (no external LLM / chat providers).
 * Optional: selective browser fetches to public reference APIs (see `js/ai/web-research-*.js`).
 */
const admin = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const { onRequest } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { runAlertPrune } = require("./alertPrune");

if (!admin.apps.length) {
    admin.initializeApp();
}

exports.agriFunctionsHealth = onRequest(
    {
        region: "us-central1",
        cors: true,
        invoker: "public",
    },
    (req, res) => {
        res.status(200).json({
            ok: true,
            service: "agritech-functions",
            assistant: "client-orchestrated",
        });
    },
);

/** Delete stale `alerts` docs: default 24h; pest/disease/insect (biosecurity) up to 90d.
 * Requires Blaze + Cloud Scheduler; if deploy fails, client-side prune on home still runs. */
exports.pruneExpiredAlerts = onSchedule(
    {
        schedule: "every 6 hours",
        region: "us-central1",
        timeoutSeconds: 300,
        memory: "256MiB",
    },
    async () => {
        const db = getFirestore();
        await runAlertPrune(db);
    },
);
