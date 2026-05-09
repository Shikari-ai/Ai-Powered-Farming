/**
 * dashboard.js — Home Dashboard Logic
 * Fully connected to Firebase Auth, Firestore realtime listeners,
 * Weather API, i18n, and all backend subsystems.
 */
import { auth, db } from "./auth.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    doc,
    limit,
    onSnapshot,
    query,
    where,
    orderBy,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getGreeting, t, applyTranslations } from "./i18n.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function el(id) { return document.getElementById(id); }

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
    return `${Math.floor(h / 24)}d ago`;
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// ─── Notif badge ─────────────────────────────────────────────────────────────

function setNotifBadge(count) {
    const badge = el("notif-badge");
    const npBadge = el("np-unread-badge");
    if (badge) {
        badge.textContent = String(count);
        badge.classList.toggle("hidden", count <= 0);
    }
    if (npBadge) {
        npBadge.textContent = String(count);
        npBadge.classList.toggle("hidden", count <= 0);
    }
}

// ─── Crop Health Ring (SVG) ───────────────────────────────────────────────────

const CIRCUMFERENCE = 251.3; // 2π × 40

function setHealthRing(score) {
    const fg = el("health-ring-fg");
    if (!fg) return;
    const clamped = clamp(Number(score) || 0, 0, 100);
    const offset = CIRCUMFERENCE - (clamped / 100) * CIRCUMFERENCE;
    fg.style.strokeDashoffset = offset;
    // Dynamic ring color
    if (clamped >= 75) fg.style.stroke = "#10B981";
    else if (clamped >= 50) fg.style.stroke = "#F59E0B";
    else if (clamped >= 25) fg.style.stroke = "#F97316";
    else fg.style.stroke = "#EF4444";
    fg.style.filter = `drop-shadow(0 0 5px ${fg.style.stroke}80)`;
}

function healthLabel(score) {
    if (score === null || score === undefined) return "--";
    if (score >= 80) return t("excellent");
    if (score >= 60) return t("good");
    if (score >= 40) return t("moderate");
    if (score >= 20) return t("poor");
    return t("critical");
}

function healthColor(score) {
    if (score >= 80) return "#10B981";
    if (score >= 60) return "#84CC16";
    if (score >= 40) return "#F59E0B";
    if (score >= 20) return "#F97316";
    return "#EF4444";
}

function healthImg(score, crop) {
    // Return appropriate plant image based on health
    if (!score || score < 40) {
        return "https://images.unsplash.com/photo-1530836369250-ef72a3f5cda8?w=200&q=75";
    }
    return "https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=200&q=75";
}

// ─── Pest Risk ───────────────────────────────────────────────────────────────

function pestRiskColor(risk) {
    if (!risk) return "rgba(255,255,255,0.35)";
    const r = risk.toLowerCase();
    if (r === "high" || r === "critical") return "#EF4444";
    if (r === "medium" || r === "moderate") return "#F59E0B";
    return "#10B981";
}

function pestRiskImg(risk) {
    if (!risk) return "https://images.unsplash.com/photo-1574943320219-3c1a7fec3b9c?w=200&q=75";
    const r = risk.toLowerCase();
    if (r === "high" || r === "critical") {
        return "https://images.unsplash.com/photo-1585320806297-9794b3e4eeae?w=200&q=75";
    }
    return "https://images.unsplash.com/photo-1574943320219-3c1a7fec3b9c?w=200&q=75";
}

// ─── Notification panel renderer ─────────────────────────────────────────────

function renderNotifPanel(items) {
    const body = el("np-body");
    if (!body) return;
    if (!items.length) {
        body.innerHTML = `<div class="np-empty">
          <i class="ri-notification-off-line"></i>
          <p>No notifications yet.<br>Field alerts and scan updates appear here.</p>
        </div>`;
        return;
    }
    body.innerHTML = "";
    items.slice(0, 30).forEach((n) => {
        const type = n.type || "info";
        const icoMap = {
            scan: { icon: "ri-leaf-line", color: "#10B981", bg: "rgba(16,185,129,0.12)" },
            weather: { icon: "ri-cloud-line", color: "#38BDF8", bg: "rgba(56,189,248,0.12)" },
            pest: { icon: "ri-bug-line", color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
            alert: { icon: "ri-error-warning-line", color: "#EF4444", bg: "rgba(239,68,68,0.12)" },
        };
        const style = Object.keys(icoMap).find(k => type.includes(k))
            ? icoMap[Object.keys(icoMap).find(k => type.includes(k))]
            : { icon: "ri-notification-3-line", color: "#A78BFA", bg: "rgba(167,139,250,0.12)" };
        const row = document.createElement("div");
        row.className = `np-item${!n.readAt ? " unread" : ""}`;
        row.innerHTML = `
          <div class="np-ico" style="background:${style.bg};color:${style.color}">
            <i class="${style.icon}"></i>
          </div>
          <div class="np-content">
            <h4>${n.title || "Notification"}</h4>
            <p>${n.body || ""}</p>
            <span class="np-time">${formatTimeAgo(tsToMs(n.createdAt))}</span>
          </div>`;
        body.appendChild(row);
    });
}

// ─── My Fields renderer ───────────────────────────────────────────────────────

function renderHomeFields(snap) {
    const scroll = el("dash-fields-scroll");
    const empty = el("dash-fields-empty");
    if (!scroll) return;

    const fields = [];
    snap.forEach((d) => fields.push({ id: d.id, ...d.data() }));

    if (fields.length === 0) {
        if (empty) empty.style.display = "flex";
        // Remove any old field cards
        scroll.querySelectorAll(".dash-field-card,.mf-add-card").forEach(c => c.remove());
        return;
    }

    if (empty) empty.style.display = "none";

    // Remove stale cards
    scroll.querySelectorAll(".dash-field-card,.mf-add-card").forEach(c => c.remove());

    const fc = (h) => {
        if (!h && h !== 0) return { bg: "rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.35)" };
        if (h >= 75) return { bg: "rgba(16,185,129,0.15)", color: "#10B981" };
        if (h >= 50) return { bg: "rgba(132,204,22,0.15)", color: "#84CC16" };
        if (h >= 25) return { bg: "rgba(245,158,11,0.15)", color: "#F59E0B" };
        return { bg: "rgba(239,68,68,0.15)", color: "#EF4444" };
    };

    fields.forEach((f) => {
        const score = typeof f.healthScore === "number" ? f.healthScore : null;
        const c = fc(score);
        const label = score !== null ? healthLabel(score) : (f.health || f.status || "Unknown");
        const dotColor = c.color;

        const card = document.createElement("a");
        card.href = `field-detail.html?id=${f.id}`;
        card.className = "dash-field-card";
        card.innerHTML = `
          <div class="dfc-top">
            <div class="dfc-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor}80"></div>
            <span class="dfc-area">${f.area ? f.area + " ac" : "--"}</span>
          </div>
          <div>
            <div class="dfc-name">${f.name || "Unnamed"}</div>
            <div class="dfc-crop">${f.crop || "No crop set"}</div>
          </div>
          <div class="dfc-badge" style="background:${c.bg};color:${c.color};border:1px solid ${c.color}44">
            ${label}
          </div>`;
        scroll.insertBefore(card, empty);
    });

    // Add "+" card
    const addCard = document.createElement("a");
    addCard.href = "fields.html";
    addCard.className = "mf-add-card";
    addCard.innerHTML = `<i class="ri-add-circle-line"></i><span>Add</span>`;
    scroll.appendChild(addCard);
}

// ─── At a Glance updaters ────────────────────────────────────────────────────

function updateGlanceFields(count) {
    const e = el("glance-fields");
    if (e) e.textContent = String(count ?? "--");
}

function updateGlanceCrops(crops) {
    const e = el("glance-crops");
    if (e) e.textContent = String(crops ?? "--");
}

function updateGlanceSoil(val) {
    const e = el("glance-soil");
    if (e) e.textContent = val !== null && val !== undefined ? `${val}%` : "--";
}

function updateGlanceIrrig(val) {
    const e = el("glance-irrig");
    if (e) e.textContent = val !== null && val !== undefined ? `${val}%` : "--";
}

// ─── Farm status subline ─────────────────────────────────────────────────────

function updateFarmStatus(fieldsCount, scansCount) {
    const sub = el("hdr-subline");
    if (!sub) return;
    if (fieldsCount === 0 && scansCount === 0) {
        sub.textContent = t("farmStatus");
        return;
    }
    if (fieldsCount > 0 && scansCount === 0) {
        sub.textContent = `${fieldsCount} field${fieldsCount > 1 ? "s" : ""} connected. Start scanning to unlock insights.`;
        return;
    }
    sub.textContent = `${fieldsCount} field${fieldsCount > 1 ? "s" : ""} • ${scansCount} scan${scansCount > 1 ? "s" : ""} synced in realtime.`;
}

// ─── DOMContentLoaded bootstrap ──────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    // Apply i18n immediately
    applyTranslations();

    // Flash greeting from cache (no name flash)
    try {
        const cached = JSON.parse(localStorage.getItem("agri_user") || "null");
        const greetEl = el("hdr-greet");
        const nameSpan = el("hdr-name");
        if (greetEl) greetEl.textContent = getGreeting() + ",";
        if (cached?.name && nameSpan) {
            nameSpan.textContent = String(cached.name).split(" ")[0];
        }
    } catch (_) {
        const greetEl = el("hdr-greet");
        if (greetEl) greetEl.textContent = getGreeting() + ",";
    }

    // Realtime language-change listener
    document.addEventListener("langchange", () => {
        applyTranslations();
        const greetEl = el("hdr-greet");
        if (greetEl) {
            const current = greetEl.textContent.replace(/,$/, "").trim();
            greetEl.textContent = getGreeting() + ",";
        }
    });

    onAuthStateChanged(auth, (user) => {
        if (!user) {
            window.location.href = "login.html";
            return;
        }

        let totalFields = 0;
        let totalScans = 0;

        // ── 1) User profile ───────────────────────────────────────────────────
        const userRef = doc(db, "users", user.uid);
        onSnapshot(userRef, (snap) => {
            const data = snap.exists() ? snap.data() : {};
            const fullName = data?.name || user.displayName
                || (user.email ? user.email.split("@")[0] : "Farmer");
            const firstName = String(fullName).split(" ")[0] || "Farmer";

            // Cache for instant load next visit
            try { localStorage.setItem("agri_user", JSON.stringify({ name: fullName })); } catch (_) {}

            const greetEl = el("hdr-greet");
            const nameSpan = el("hdr-name"); // <span id="hdr-name"> inside <h2 class="hdr-name">
            if (greetEl) greetEl.textContent = getGreeting() + ",";
            if (nameSpan) nameSpan.textContent = firstName;

            // Avatar
            const avatar = el("hdr-avatar-img");
            if (avatar) {
                avatar.src = user.photoURL
                    ? user.photoURL
                    : `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=10B981&color=fff&size=80`;
            }

            // Lang preference from Firestore
            if (data?.langPreference && window.i18n) {
                window.i18n.setLanguage(data.langPreference);
            }
        });

        // ── 2) Fields ─────────────────────────────────────────────────────────
        onSnapshot(
            query(collection(db, "fields"), where("userId", "==", user.uid), limit(200)),
            (snap) => {
                totalFields = snap.size;
                updateGlanceFields(totalFields);

                // Count unique crops
                const cropSet = new Set();
                snap.forEach((d) => {
                    const crop = d.data()?.crop;
                    if (crop) cropSet.add(crop.trim().toLowerCase());
                });
                updateGlanceCrops(cropSet.size || "--");

                renderHomeFields(snap);
                updateFarmStatus(totalFields, totalScans);
            }
        );

        // ── 3) Notifications ─────────────────────────────────────────────────
        onSnapshot(
            query(collection(db, "notifications"), where("userId", "==", user.uid), limit(50)),
            (snap) => {
                const items = [];
                let unread = 0;
                snap.forEach((d) => {
                    const v = d.data();
                    items.push({ id: d.id, ...v });
                    if (!v.readAt) unread++;
                });
                items.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
                setNotifBadge(unread);
                renderNotifPanel(items);
            }
        );

        // ── 4) Crop scans → Health Ring + Pest Prediction ─────────────────────
        onSnapshot(
            query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(200)),
            (snap) => {
                const scans = [];
                snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
                scans.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
                totalScans = scans.length;
                updateFarmStatus(totalFields, totalScans);

                // ─ Health Ring ────────────────────────────────────────────────
                const ringPctEl = el("ring-pct");
                const ringTagEl = el("ring-tag");
                const hiStatusEl = el("hi-status");
                const hiDescEl = el("hi-desc");
                const hiImgEl = el("health-img");

                if (scans.length === 0) {
                    setHealthRing(0);
                    if (ringPctEl) ringPctEl.textContent = "--";
                    if (ringTagEl) ringTagEl.textContent = "--";
                    if (hiStatusEl) {
                        hiStatusEl.textContent = "--";
                        hiStatusEl.style.color = "rgba(255,255,255,0.35)";
                    }
                    if (hiDescEl) hiDescEl.textContent = t("noScansYet");
                    resetPestCard();
                    return;
                }

                const recent10 = scans.slice(0, 10);
                const scores = recent10
                    .map((s) => (typeof s.healthScore === "number" ? s.healthScore : null))
                    .filter((v) => v !== null);
                const avg = scores.length
                    ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
                    : 0;

                setHealthRing(avg);
                if (ringPctEl) ringPctEl.textContent = `${avg}%`;
                if (ringTagEl) {
                    ringTagEl.textContent = avg >= 60 ? t("healthy") : t("needsAttention");
                    ringTagEl.style.color = avg >= 60 ? "#10B981" : "#F59E0B";
                }
                if (hiStatusEl) {
                    hiStatusEl.textContent = healthLabel(avg);
                    hiStatusEl.style.color = healthColor(avg);
                }
                if (hiDescEl) {
                    const latest = scans[0];
                    const disease = latest?.diagnosis?.name || latest?.disease || null;
                    if (disease && avg < 70) {
                        hiDescEl.textContent = `${disease} detected. Monitor closely and consider treatment.`;
                    } else if (avg >= 80) {
                        hiDescEl.textContent = "Your crops are in great condition. Keep up the good work!";
                    } else if (avg >= 60) {
                        hiDescEl.textContent = "Crops look good. Keep monitoring for early disease signs.";
                    } else {
                        hiDescEl.textContent = "Crop health needs attention. Review scan history for details.";
                    }
                }
                if (hiImgEl) hiImgEl.src = healthImg(avg, scans[0]?.crop);

                // ─ Pest Engine (signal-based, no fabrication) ─────────────────
                const recent14d = scans.filter(
                    (s) => Date.now() - tsToMs(s.createdAt) <= 14 * 86400000
                );
                const pestSig = recent14d.filter(
                    (s) => s?.diagnosis?.code === "pest_damage"
                ).length;
                const fungalSig = recent14d.filter(
                    (s) => s?.diagnosis?.code === "fungal_risk"
                ).length;
                const critSig = recent14d.filter(
                    (s) => s?.severity?.level === "critical"
                ).length;
                const total = recent14d.length;

                const pestRiskEl = el("pest-risk");
                const pestDescEl = el("pest-desc");
                const pestImgEl = el("pest-img");

                if (total < 3) {
                    resetPestCard();
                    return;
                }

                const raw = pestSig * 22 + fungalSig * 14 + critSig * 18;
                const prob = clamp(Math.round((raw / Math.max(1, total)) * 2.2), 0, 95);
                const riskStr = prob >= 70 ? t("high")
                    : prob >= 35 ? t("medium")
                    : t("low");

                if (pestRiskEl) {
                    pestRiskEl.textContent = riskStr;
                    pestRiskEl.style.color = pestRiskColor(riskStr);
                }
                if (pestDescEl) {
                    if (prob >= 70) {
                        pestDescEl.textContent = "High pest activity detected in recent scans. Immediate attention required.";
                    } else if (prob >= 35) {
                        pestDescEl.textContent = `${riskStr} pest pressure based on scan patterns. Monitor closely.`;
                    } else {
                        pestDescEl.textContent = "Pest risk is low based on recent scan analysis. Continue monitoring.";
                    }
                }
                if (pestImgEl) pestImgEl.src = pestRiskImg(riskStr);

                // Animate blip position based on risk
                const blip = el("radar-blip");
                const blip2 = el("radar-blip2");
                if (blip) {
                    const positions = { high: { top: "25%", left: "65%" }, medium: { top: "35%", left: "60%" }, low: { top: "30%", left: "55%" } };
                    const pos = positions[riskStr.toLowerCase()] || positions.low;
                    blip.style.top = pos.top;
                    blip.style.left = pos.left;
                    blip.style.background = pestRiskColor(riskStr);
                    blip.style.boxShadow = `0 0 8px ${pestRiskColor(riskStr)}`;
                }
            }
        );

        // ── 5) Weather logs → Soil moisture + Irrigation glance ───────────────
        onSnapshot(
            query(
                collection(db, "weather_logs"),
                where("userId", "==", user.uid),
                limit(1)
            ),
            (snap) => {
                if (snap.empty) {
                    updateGlanceSoil(null);
                    updateGlanceIrrig(null);
                    return;
                }
                snap.forEach((d) => {
                    const data = d.data();
                    const soilEst = data?.derived?.soilMoistureEstimate ?? null;
                    updateGlanceSoil(soilEst);
                    // Irrigation efficiency: inverse of soil saturation for simple estimate
                    if (soilEst !== null) {
                        const irrigEff = clamp(Math.round(85 - (soilEst - 50) * 0.3), 40, 98);
                        updateGlanceIrrig(irrigEff);
                    } else {
                        updateGlanceIrrig(null);
                    }
                });
            }
        );

        // ── 6) AI Recommendations → Insights (shown in notif panel) ───────────
        onSnapshot(
            query(
                collection(db, "ai_recommendations"),
                where("userId", "==", user.uid),
                limit(5)
            ),
            (snap) => {
                if (snap.empty) return;
                // AI insights can be merged into notification panel or shown separately
                // Currently kept available for other pages (assistant.html)
            }
        );
    });
});

// ─── Pest card empty state ────────────────────────────────────────────────────

function resetPestCard() {
    const pestRiskEl = el("pest-risk");
    const pestDescEl = el("pest-desc");
    if (pestRiskEl) {
        pestRiskEl.textContent = "--";
        pestRiskEl.style.color = "rgba(255,255,255,0.35)";
    }
    if (pestDescEl) {
        pestDescEl.textContent = t("notEnoughData") + " Analyzing weather patterns and crop history...";
    }
}
