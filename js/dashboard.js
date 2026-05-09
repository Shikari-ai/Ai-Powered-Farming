import { auth, db } from "./auth.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    doc,
    limit,
    onSnapshot,
    query,
    where,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

function el(id) {
    return document.getElementById(id);
}

function tsToMs(ts) {
    if (!ts) return 0;
    if (typeof ts.toMillis === "function") return ts.toMillis();
    if (typeof ts.toDate === "function") return ts.toDate().getTime();
    if (typeof ts === "number") return ts;
    return 0;
}

function formatTimeAgo(ms) {
    if (!ms) return "";
    const diff = Date.now() - ms;
    const min = Math.floor(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return `${min}m ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
}

function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}

function setNotifBadge(count) {
    const badge = el("notif-badge");
    if (!badge) return;
    badge.textContent = String(count);
    badge.classList.toggle("hidden", count <= 0);
}

function setRingProgress({ ringEl, score }) {
    if (!ringEl) return;
    const s = clamp(Number(score) || 0, 0, 100);
    const p = `${s}%`;
    ringEl.style.boxShadow = s > 0 ? "0 0 30px rgba(16,185,129,0.2)" : "none";
    ringEl.style.background = `conic-gradient(var(--primary) ${p}, rgba(16,185,129,0.12) ${p})`;
}

function renderSparkline(container, points) {
    if (!container) return;
    const vals = points.filter(n => typeof n === "number" && Number.isFinite(n));
    if (vals.length < 2) {
        container.innerHTML = "";
        container.style.opacity = "0.45";
        return;
    }

    const w = 240;
    const h = 40;
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const range = maxV - minV || 1;
    const step = w / (vals.length - 1);

    const pts = vals.map((v, i) => {
        const x = i * step;
        const y = (1 - (v - minV) / range) * (h - 6) + 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    container.style.opacity = "1";
    container.innerHTML = `
        <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
            <defs>
                <linearGradient id="g" x1="0" x2="1">
                    <stop offset="0%" stop-color="#10B981" stop-opacity="0.35"/>
                    <stop offset="100%" stop-color="#10B981" stop-opacity="0.05"/>
                </linearGradient>
            </defs>
            <polyline points="${pts}" fill="none" stroke="#10B981" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <polyline points="${pts} ${w},${h} 0,${h}" fill="url(#g)" stroke="none" opacity="0.8"/>
        </svg>
    `;
}

function renderInsights(listEl, items) {
    if (!listEl) return;
    if (!items.length) return; // keep the premium empty state already in HTML
    listEl.innerHTML = "";
    for (const it of items.slice(0, 3)) {
        const type = it.type || "info";
        const icon = type === "warning" ? "ri-error-warning-line" : (type === "action" ? "ri-checkbox-circle-line" : "ri-sparkling-line");
        const color = type === "warning" ? "var(--accent-yellow)" : (type === "action" ? "var(--primary)" : "var(--accent-blue)");
        const borderColor = type === "warning" ? "var(--accent-yellow)" : (type === "action" ? "var(--primary)" : "var(--accent-blue)");
        const div = document.createElement("div");
        div.className = "ai-item";
        div.style.borderLeftColor = borderColor;
        div.innerHTML = `
            <i class="${icon}" style="color:${color};"></i>
            <p>${it.text || "Insight"}</p>
        `;
        listEl.appendChild(div);
    }
}

function renderAlerts(container, notifs) {
    if (!container) return;
    if (!notifs.length) return; // keep empty state already in HTML
    container.innerHTML = "";
    for (const n of notifs.slice(0, 3)) {
        const type = n.type || "info";
        const title = n.title || "Notification";
        const body = n.body || "";
        const when = formatTimeAgo(tsToMs(n.createdAt));
        const icon = type.includes("scan") ? "ri-leaf-line" : (type.includes("weather") ? "ri-cloud-line" : "ri-notification-3-line");
        const color = type.includes("scan") ? "var(--primary)" : "var(--accent-blue)";
        const bg = type.includes("scan") ? "rgba(16,185,129,0.1)" : "rgba(59,130,246,0.1)";

        const row = document.createElement("div");
        row.className = "alert-item";
        row.innerHTML = `
            <div class="a-icon" style="background:${bg}; color:${color};"><i class="${icon}"></i></div>
            <div class="a-text">
                <h5 style="color:${color};">${title}</h5>
                <p>${body}</p>
            </div>
            <span class="a-time">${when} <i class="ri-arrow-right-s-line" style="color:var(--text-dim);"></i></span>
        `;
        container.appendChild(row);
    }
}

function timeGreeting(firstName) {
    const h = new Date().getHours();
    const salutation = h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
    return `${salutation}, ${firstName} 👋`;
}

document.addEventListener("DOMContentLoaded", () => {
    // Show name instantly from cache — no flash of placeholder text
    try {
        const cached = JSON.parse(localStorage.getItem("agri_user") || "null");
        if (cached?.name) {
            const firstName = String(cached.name).split(" ")[0];
            const greet = el("dashboard-greeting");
            if (greet) greet.textContent = timeGreeting(firstName);
        }
    } catch (_) {}

    onAuthStateChanged(auth, (user) => {
        if (!user) {
            window.location.href = "login.html";
            return;
        }

        // 1) User profile (greeting/avatar)
        const userRef = doc(db, "users", user.uid);
        onSnapshot(userRef, (snap) => {
            const data = snap.exists() ? snap.data() : {};
            const fullName = data?.name || user.displayName || (user.email ? user.email.split("@")[0] : "Farmer");
            const firstName = String(fullName).split(" ")[0] || "Farmer";
            const greeting = el("dashboard-greeting");
            if (greeting) greeting.textContent = timeGreeting(firstName);

            const avatar = el("dashboard-avatar");
            if (avatar) {
                avatar.src = user.photoURL
                    ? user.photoURL
                    : `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=10B981&color=fff`;
            }

            // Trigger location prompt only when authenticated.
            if (typeof window.checkLocationPrompt === "function") {
                window.checkLocationPrompt();
            }
        });

        // 2) Fields count (used for summary + performance)
        let fieldsCount = 0;
        onSnapshot(query(collection(db, "fields"), where("userId", "==", user.uid), limit(200)), (snap) => {
            fieldsCount = snap.size;
            const summaryText = el("dash-summary-text");
            const summaryCta = el("dash-summary-cta");
            if (!summaryText || !summaryCta) return;
            // Summary will be refined after scans listener runs
            if (fieldsCount === 0) {
                summaryText.textContent = "Your ecosystem is inactive. Add fields and scans to unlock realtime intelligence.";
                summaryCta.textContent = "Add your first field";
                summaryCta.onclick = () => (window.location.href = "fields.html");
            }
        });

        // 3) Notifications (badge + alerts list)
        onSnapshot(query(collection(db, "notifications"), where("userId", "==", user.uid), limit(50)), (snap) => {
            const items = [];
            let unread = 0;
            snap.forEach((d) => {
                const v = d.data();
                items.push({ id: d.id, ...v });
                if (!v.readAt) unread += 1;
            });
            items.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
            setNotifBadge(unread);
            renderAlerts(el("dash-alerts-list"), items);
        });

        // 4) Crop scans → crop health + holo panel + pest engine input
        onSnapshot(query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(200)), (snap) => {
            const scans = [];
            snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
            scans.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));

            const ring = el("dash-crophealth-ring");
            const scoreEl = el("dash-crophealth-score");
            const statusEl = el("dash-crophealth-status");
            const sparkEl = el("dash-crophealth-sparkline");
            const cta = el("dash-crophealth-cta");
            const holoVal = el("dash-holo-health");
            const holoLabel = el("dash-holo-label");

            if (scans.length === 0) {
                if (scoreEl) scoreEl.textContent = "--";
                if (statusEl) {
                    statusEl.textContent = "No crop scans yet";
                    statusEl.style.color = "var(--text-dim)";
                }
                setRingProgress({ ringEl: ring, score: 0 });
                renderSparkline(sparkEl, []);
                if (cta) cta.textContent = "Start your first scan";
                if (holoVal) holoVal.textContent = "--";
                if (holoLabel) holoLabel.textContent = "Not active";

                // Pest engine: no data
                const pestRisk = el("dash-pest-risk");
                const pestProb = el("dash-pest-prob");
                if (pestRisk) {
                    pestRisk.textContent = "Not enough data";
                    pestRisk.style.color = "var(--text-dim)";
                }
                if (pestProb) {
                    pestProb.textContent = "--";
                    pestProb.style.color = "var(--text-dim)";
                }
                return;
            }

            const recent = scans.slice(0, 10);
            const scores = recent.map(s => typeof s.healthScore === "number" ? s.healthScore : null).filter(v => v !== null);
            const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

            const latest = scans[0];
            const sev = latest?.severity?.level || "unknown";
            const label = sev === "good" ? "Good" : (sev === "warning" ? "Needs attention" : (sev === "critical" ? "Critical" : "Active"));

            if (scoreEl) scoreEl.textContent = `${avg}%`;
            if (statusEl) {
                statusEl.textContent = label;
                statusEl.style.color = sev === "good" ? "var(--primary)" : (sev === "warning" ? "var(--accent-yellow)" : "var(--accent-yellow)");
            }
            setRingProgress({ ringEl: ring, score: avg });
            renderSparkline(sparkEl, scans.slice(0, 12).map(s => s.healthScore).reverse());
            if (cta) cta.textContent = "View scan history";

            if (holoVal) holoVal.textContent = `${avg}%`;
            if (holoLabel) holoLabel.textContent = label;

            // Pest engine (based on real scan signals — no random)
            const recent14d = scans.filter(s => (Date.now() - tsToMs(s.createdAt)) <= 14 * 86400000);
            const pestSignals = recent14d.filter(s => s?.diagnosis?.code === "pest_damage").length;
            const fungalSignals = recent14d.filter(s => s?.diagnosis?.code === "fungal_risk").length;
            const criticalSignals = recent14d.filter(s => s?.severity?.level === "critical").length;
            const total = recent14d.length;

            const pestRisk = el("dash-pest-risk");
            const pestProb = el("dash-pest-prob");
            if (total < 3) {
                if (pestRisk) {
                    pestRisk.textContent = "Not enough data";
                    pestRisk.style.color = "var(--text-dim)";
                }
                if (pestProb) {
                    pestProb.textContent = "--";
                    pestProb.style.color = "var(--text-dim)";
                }
            } else {
                const raw = (pestSignals * 22) + (fungalSignals * 14) + (criticalSignals * 18);
                const prob = clamp(Math.round((raw / Math.max(1, total)) * 2.2), 0, 95);
                const risk = prob >= 70 ? "High" : (prob >= 35 ? "Medium" : "Low");
                if (pestRisk) {
                    pestRisk.textContent = risk;
                    pestRisk.style.color = risk === "High" ? "#ef4444" : (risk === "Medium" ? "var(--accent-yellow)" : "var(--primary)");
                }
                if (pestProb) {
                    pestProb.textContent = `${prob}%`;
                    pestProb.style.color = risk === "High" ? "#ef4444" : (risk === "Medium" ? "var(--accent-yellow)" : "var(--primary)");
                }
            }

            // Summary refinement
            const summaryText = el("dash-summary-text");
            const summaryCta = el("dash-summary-cta");
            if (summaryText && summaryCta) {
                if (fieldsCount === 0) {
                    summaryText.textContent = "You’ve started scanning crops. Add fields to unlock per-field trends and monitoring.";
                    summaryCta.textContent = "Add a field";
                    summaryCta.onclick = () => (window.location.href = "fields.html");
                } else {
                    summaryText.textContent = `Realtime sync active: ${fieldsCount} field${fieldsCount === 1 ? "" : "s"} • ${scans.length} scan${scans.length === 1 ? "" : "s"}.`;
                    summaryCta.textContent = "Scan again";
                    summaryCta.onclick = () => (window.location.href = "scanner.html");
                }
            }

            // Performance (no placeholders; only show values when grounded in real activity)
            const scans7d = scans.filter(s => (Date.now() - tsToMs(s.createdAt)) <= 7 * 86400000).length;
            const monitoredFields = new Set(scans.map(s => s.fieldId).filter(Boolean)).size;
            const prodEl = el("dash-perf-productivity");
            const yieldEl = el("dash-perf-yield");
            const waterEl = el("dash-perf-water");
            const sustEl = el("dash-perf-sust");
            if (prodEl) prodEl.textContent = scans7d ? `${scans7d} scan${scans7d === 1 ? "" : "s"}/7d` : "--";
            if (yieldEl) yieldEl.textContent = monitoredFields ? `${monitoredFields} field${monitoredFields === 1 ? "" : "s"} monitored` : "--";
            if (waterEl) waterEl.textContent = "--";
            if (sustEl) sustEl.textContent = "--";

            // Production rule: never show placeholder/simulated charts.
            // This UI slot is reserved for real time-series once we store analytics series in Firestore.
            document.querySelectorAll(".perf-card .pc-chart").forEach((chart) => {
                chart.style.display = "none";
            });
        });

        // 5) AI recommendations (insights)
        onSnapshot(query(collection(db, "ai_recommendations"), where("userId", "==", user.uid), limit(50)), (snap) => {
            const recs = [];
            snap.forEach((d) => {
                const v = d.data();
                if (v.status && v.status !== "active") return;
                recs.push({ id: d.id, ...v });
            });
            recs.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
            renderInsights(el("dash-insights-list"), recs);
        });
    });
});
