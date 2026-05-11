/**
 * Firebase Cloud Functions — optional HTTP utilities.
 * Conversational assistant runs fully in the web client (no external LLM / chat providers).
 * Optional: selective browser fetches to public reference APIs (see `js/ai/web-research-*.js`).
 */
const { onRequest } = require("firebase-functions/v2/https");

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
