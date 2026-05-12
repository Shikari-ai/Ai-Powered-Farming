/**
 * Scheduled prune for `alerts` — keep in sync with js/alerts/home-retention.js
 * (TTL + biosecurity detection).
 */
const { Timestamp } = require("firebase-admin/firestore");

const ALERT_HOME_DEFAULT_TTL_MS = 86400000;
const ALERT_HOME_BIOSECURITY_TTL_MS = 90 * 86400000;

function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (ts instanceof Timestamp) return ts.toMillis();
    if (typeof ts === "number") return ts;
    return 0;
}

function norm(s) {
    return String(s || "").toLowerCase();
}

function textBlob(data) {
    return `${norm(data.title)} ${norm(data.body)} ${norm(data.type)} ${norm(data.source)}`;
}

function isBiosecurityAlert(data) {
    if (!data || data.homeRetention === "biosecurity") return true;
    const code = norm(data.diagnosisCode);
    if (code === "pest_damage" || code === "fungal_risk") return true;
    const t = norm(data.type);
    if (t.includes("pest") || t.includes("disease") || t.includes("insect")) return true;
    const blob = textBlob(data);
    const needles = [
        "pest",
        "cricket",
        "grasshopper",
        "locust",
        "aphid",
        "borer",
        "caterpillar",
        "thrip",
        "whitefly",
        "mite",
        "weevil",
        "hopper",
        "armyworms",
        "armyworm",
        "insect attack",
        "insect damage",
        "insect infest",
        "disease",
        "blight",
        "fungal",
        "epidemic",
        "pandemic",
        "pathogen",
        "wilt",
        "mildew",
        "smut",
        "canker",
        "viral",
        "virus",
        "bacterial leaf",
        "downy mildew",
        "powdery mildew",
    ];
    for (const w of needles) {
        if (blob.includes(w)) return true;
    }
    if (/\b(rust|rot)\b/.test(blob) && !/\brotation\b/.test(blob)) return true;
    return false;
}

function shouldDeleteAlertDoc(data, nowMs) {
    const createdMs = tsToMs(data.createdAt);
    if (!createdMs) return true;
    const ageMs = nowMs - createdMs;
    if (isBiosecurityAlert(data)) {
        return ageMs > ALERT_HOME_BIOSECURITY_TTL_MS;
    }
    return ageMs > ALERT_HOME_DEFAULT_TTL_MS;
}

/**
 * @param {import("firebase-admin/firestore").Firestore} db
 */
async function runAlertPrune(db) {
    const nowMs = Date.now();
    const cutoff = Timestamp.fromMillis(nowMs - ALERT_HOME_DEFAULT_TTL_MS);
    let lastDoc = null;
    let totalDeleted = 0;
    const maxRounds = 80;

    for (let round = 0; round < maxRounds; round++) {
        let q = db.collection("alerts").where("createdAt", "<", cutoff).orderBy("createdAt", "asc").limit(80);
        if (lastDoc) q = q.startAfter(lastDoc);
        const snap = await q.get();
        if (snap.empty) break;

        lastDoc = snap.docs[snap.docs.length - 1];
        const batch = db.batch();
        let ops = 0;
        for (const doc of snap.docs) {
            const data = doc.data();
            if (shouldDeleteAlertDoc(data, nowMs)) {
                batch.delete(doc.ref);
                ops++;
            }
        }
        if (ops > 0) {
            await batch.commit();
            totalDeleted += ops;
        }
    }

    console.log(`[alertPrune] deleted ${totalDeleted} alert(s)`);
    return { deleted: totalDeleted };
}

module.exports = { runAlertPrune, isBiosecurityAlert, shouldDeleteAlertDoc };
