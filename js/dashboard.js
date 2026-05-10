/**
 * dashboard.js — Home Dashboard Logic
 * Fully connected to Firebase Auth, Firestore realtime listeners,
 * Weather API, i18n, and all backend subsystems.
 */
import { registerAuthCleanup } from "./auth-session.js?v=31";
import { auth, db } from "./auth.js?v=31";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import {
    collection,
    doc,
    limit,
    onSnapshot,
    orderBy,
    query,
    serverTimestamp,
    setDoc,
    where,
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getGreeting, t, applyTranslations } from "./i18n.js?v=6";
import { buildRegionalPulse, contributeRegionalPulse } from "./network/regional-pulse.js";
import { fetchRegionalBriefing, getRegionalOptIn } from "./network/regional-briefing.js";
import { buildTwinBriefForAssistant } from "./twin/assistant-twin-brief.js";
import { buildAmbientInsightLines } from "./ambient/ambient-insights.js";
import { buildMorningBriefingText } from "./ambient/briefings.js";
import { getAmbientAttentionPrefs } from "./ambient/attention-memory.js";
import { publishAmbientChannelEvent } from "./ambient/sensory-hooks.js";

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

function escAttr(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

// ─── Notif badge ─────────────────────────────────────────────────────────────

function countUnreadForBadge(items) {
    const prefs = getAmbientAttentionPrefs();
    let n = 0;
    for (const x of items) {
        if (x.readAt) continue;
        const passive = x.ambientTier === "passive" || x.suppressInterruption === true;
        if (passive && !prefs.badgeCountsPassive) continue;
        n++;
    }
    return n;
}

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
    if (clamped >= 75) fg.style.stroke = "#10B981";
    else if (clamped >= 50) fg.style.stroke = "#F59E0B";
    else if (clamped >= 25) fg.style.stroke = "#F97316";
    else fg.style.stroke = "#EF4444";
    if (document.documentElement.dataset.agriPerf === "low") {
        fg.style.filter = "none";
    } else {
        fg.style.filter = `drop-shadow(0 0 5px ${fg.style.stroke}80)`;
    }
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

/** @param {"high"|"medium"|"low"|""} level — English keys only (not translated UI strings) */
function pestRiskColor(level) {
    if (!level) return "rgba(255,255,255,0.35)";
    if (level === "high") return "#EF4444";
    if (level === "medium") return "#F59E0B";
    return "#10B981";
}

function pestRiskImg(level) {
    if (!level) return "https://images.unsplash.com/photo-1574943320219-3c1a7fec3b9c?w=200&q=75";
    if (level === "high") {
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
        const icoMap = {
            scan: { icon: "ri-leaf-line", color: "#10B981", bg: "rgba(16,185,129,0.12)" },
            weather: { icon: "ri-cloud-line", color: "#38BDF8", bg: "rgba(56,189,248,0.12)" },
            pest: { icon: "ri-bug-line", color: "#F59E0B", bg: "rgba(245,158,11,0.12)" },
            alert: { icon: "ri-error-warning-line", color: "#EF4444", bg: "rgba(239,68,68,0.12)" },
        };
        const passive = n.ambientTier === "passive" || n.suppressInterruption === true;
        const type = (n.type && String(n.type)) || "info";
        const typeKey = Object.keys(icoMap).find((k) => type.includes(k));
        const style = passive
            ? { icon: "ri-mist-line", color: "#94A3B8", bg: "rgba(148,163,184,0.12)" }
            : typeKey
              ? icoMap[typeKey]
              : { icon: "ri-notification-3-line", color: "#A78BFA", bg: "rgba(167,139,250,0.12)" };
        const row = document.createElement("div");
        row.className = `np-item${!n.readAt ? " unread" : ""}${passive ? " np-passive" : ""}`;
        const ambLabel = n.ambientTier ? escAttr(String(n.ambientTier)) : "";
        row.innerHTML = `
          <div class="np-ico" style="background:${style.bg};color:${style.color}">
            <i class="${style.icon}"></i>
          </div>
          <div class="np-content">
            <h4>${n.title || "Notification"}</h4>
            <p>${n.body || ""}</p>
            <span class="np-time">${formatTimeAgo(tsToMs(n.createdAt))}</span>
            ${ambLabel ? `<div class="np-amb-tag">${ambLabel} · ${passive ? "ambient" : "active"}</div>` : ""}
          </div>`;
        body.appendChild(row);
    });
}

// ─── My Fields renderer ───────────────────────────────────────────────────────

function renderHomeFields(snap) {
    const scroll = el("dash-fields-scroll");
    const empty = el("dash-fields-empty");
    if (!scroll) return;

    try {
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
        card.href = `field-detail.html?f=${encodeURIComponent(f.id)}`;
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
    } catch (e) {
        console.warn("[dashboard] renderHomeFields:", e);
    }
}

function renderRecentAlertsList(items) {
    const list = el("dash-alerts-list");
    const empty = el("dash-alerts-empty");
    if (!list) return;
    list.innerHTML = "";
    if (!items.length) {
        if (empty) empty.style.display = "block";
        return;
    }
    if (empty) empty.style.display = "none";

    items.slice(0, 10).forEach((a) => {
        const sev = a.severity === "high" ? "high" : a.severity === "warn" ? "warn" : "info";
        const row = document.createElement("div");
        row.className = `dash-alert-row sev-${sev}`;
        row.innerHTML = `
          <div class="dash-alert-dot"></div>
          <div class="dash-alert-body">
            <h4>${String(a.title || "Alert").replace(/</g, "")}</h4>
            <p>${String(a.body || "").replace(/</g, "")}</p>
            <div class="dash-alert-time">${formatTimeAgo(tsToMs(a.createdAt))}</div>
          </div>`;
        list.appendChild(row);
    });
}

function renderCropHealthStrip(rows) {
    const wrap = el("dash-crop-strip-wrap");
    const strip = el("dash-crop-strip");
    if (!wrap || !strip) return;
    strip.innerHTML = "";
    if (!rows.length) {
        wrap.style.display = "none";
        return;
    }
    wrap.style.display = "";
    rows.forEach((r) => {
        const score = typeof r.healthScore === "number" ? r.healthScore : null;
        const pill = document.createElement("div");
        pill.className = "dash-crop-pill";
        const label = score != null ? healthLabel(score) : "--";
        const crop = r.cropType || "Crop";
        pill.innerHTML = `
          <div class="dcn">${String(crop).replace(/</g, "")}</div>
          <div class="dcs" style="color:${healthColor(score ?? 0)}">${score != null ? score + "%" : "--"}</div>
          <div class="dct">${label}</div>`;
        strip.appendChild(pill);
    });
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
    const DASH_FAILSAFE_MS = 4500;
    let dashFailsafeTimer = null;
    const armDashFailsafe = () => {
        dashFailsafeTimer = window.setTimeout(() => {
            try {
                document.body.classList.add("dashboard-wait-failsafe");
                document.body.classList.remove("dashboard-wait");
            } catch (_) {}
        }, DASH_FAILSAFE_MS);
    };
    const disarmDashFailsafe = () => {
        if (dashFailsafeTimer) {
            clearTimeout(dashFailsafeTimer);
            dashFailsafeTimer = null;
        }
        try {
            document.body.classList.remove("dashboard-wait-failsafe");
        } catch (_) {}
    };

    armDashFailsafe();

    window.addEventListener("error", (ev) => {
        console.warn("[app] error:", ev.error?.message || ev.message || ev);
    });
    window.addEventListener("unhandledrejection", (ev) => {
        console.warn("[app] unhandledrejection:", ev.reason);
        ev.preventDefault();
    });

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

    /** Unsubscribe all home listeners (prevents duplicate snapshots if auth re-fires). */
    let homeUnsubs = [];
    registerAuthCleanup(() => {
        homeUnsubs.forEach((u) => {
            try {
                u();
            } catch (_) {}
        });
        homeUnsubs = [];
    });
    const sub = (qOrRef, onNext, label) => {
        const u = onSnapshot(
            qOrRef,
            (snap) => {
                try {
                    onNext(snap);
                } catch (err) {
                    console.warn(`[dashboard] ${label} handler:`, err);
                }
            },
            (err) => console.warn(`[dashboard] ${label}:`, err?.code || err?.message || err)
        );
        homeUnsubs.push(u);
    };

    const mountHome = (user) => {
        try {
            let totalFields = 0;
            let totalScans = 0;

            const dashRegional = {
                fieldsList: [],
                scansByField: {},
                allScans: [],
                contextByField: {},
                wxLog: null,
                pulseTimer: null,
                regionalBriefText: "",
                learningProfile: null,
            };
            let ambientDebounce = 0;

            let dashOpenTasks = [];

            function scheduleAmbientRefresh() {
                clearTimeout(ambientDebounce);
                ambientDebounce = setTimeout(() => {
                    try {
                        renderAmbientHome(dashRegional, dashOpenTasks.length);
                    } catch (e) {
                        console.warn("[ambient] refresh:", e?.message || e);
                    }
                }, 360);
            }

            function renderAmbientHome(dr, openTaskCount) {
                const root = el("dash-ambient-root");
                const ul = el("dash-ambient-insights");
                if (!root || !ul) return;

                const scans = dr.allScans || [];
                const recent10 = scans.slice(0, 10);
                const scoreVals = recent10
                    .map((s) => (typeof s.healthScore === "number" ? s.healthScore : null))
                    .filter((v) => v !== null);
                const avgHealth = scoreVals.length
                    ? Math.round(scoreVals.reduce((a, b) => a + b, 0) / scoreVals.length)
                    : null;

                const lines = buildAmbientInsightLines({
                    fieldsList: dr.fieldsList,
                    scansByField: dr.scansByField,
                    wxLog: dr.wxLog,
                    learningProfile: dr.learningProfile,
                    regionalBriefText: dr.regionalBriefText || "",
                    openTaskCount,
                });

                if (!lines.length) {
                    ul.innerHTML =
                        `<li style="border:none;color:rgba(236,253,245,0.5);">` +
                        `No ambient lines yet — add a field and sync weather for gentle context.</li>`;
                } else {
                    ul.innerHTML = lines.map((L) => `<li>${escAttr(L)}</li>`).join("");
                }

                const briefEl = el("dash-ambient-brief");
                if (briefEl) {
                    const brief = buildMorningBriefingText({
                        fieldsCount: dr.fieldsList?.length || 0,
                        latestAvgHealth: avgHealth,
                        wxLog: dr.wxLog,
                        openTaskCount,
                        regionalBriefText: dr.regionalBriefText || "",
                    });
                    briefEl.textContent = brief || "";
                    briefEl.style.display = brief ? "block" : "none";
                }

                root.style.opacity = "1";
                publishAmbientChannelEvent("ambient_refreshed", { lineCount: lines.length });
            }

            function renderDashOpsCard() {
                const host = el("dash-ops-list");
                const summary = el("dash-ops-summary");
                if (!host) return;
                const fields = dashRegional.fieldsList || [];
                const fieldLabel = (fid) => {
                    if (!fid) return "All fields";
                    const f = fields.find((x) => x.id === fid);
                    return f?.name || "Field";
                };
                if (!dashOpenTasks.length) {
                    host.innerHTML =
                        '<div class="dash-ops-empty">No open operational tasks. Complete follow-ups from the scanner, or open a field’s <strong>Ops</strong> tab to log work and tasks.</div>';
                } else {
                    host.innerHTML = dashOpenTasks
                        .slice(0, 8)
                        .map((t) => {
                            const pri = String(t.priority || "normal");
                            const due = t.dueAt ? formatTimeAgo(tsToMs(t.dueAt)) : "";
                            const link = t.fieldId
                                ? `field-detail.html?f=${encodeURIComponent(t.fieldId)}`
                                : "fields.html";
                            return `<div class="dash-ops-row">
              <span class="dash-ops-pri">${escAttr(pri)}</span>
              <div style="flex:1;min-width:0;">
                <strong style="font-weight:600;color:rgba(236,253,245,0.92);">${escAttr(t.title || "Task")}</strong>
                <div class="dash-ops-sub">${escAttr(fieldLabel(t.fieldId))}${due ? ` · due ${escAttr(due)}` : ""}</div>
              </div>
              <a href="${link}" class="dcard-lnk">Open</a>
            </div>`;
                        })
                        .join("");
                }
                if (summary) {
                    summary.textContent = dashOpenTasks.length
                        ? `${dashOpenTasks.length} open task(s) — suggestions are advisory; you decide what to run in the field.`
                        : "Operational task queue is clear. New follow-ups may appear after stressed scans or when you add tasks in Ops.";
                }
            }

            function renderDashTwinCard() {
                const sum = el("dash-twin-summary");
                const link = el("dash-twin-field-link");
                if (!sum) return;
                const fields = dashRegional.fieldsList || [];
                if (!fields.length) {
                    sum.textContent = "Add a field to see a calm, simulated contrast between baseline and a wetter week.";
                    if (link) {
                        link.setAttribute("href", "fields.html");
                        link.textContent = "Add fields";
                    }
                    return;
                }
                const wxArr = dashRegional.wxLog ? [{ ...dashRegional.wxLog, id: "wx" }] : [];
                if (!wxArr.length || !wxArr[0]?.daily?.precipitation_sum) {
                    sum.textContent = "Sync weather from the home glance (location once), then a coarse twin line appears here.";
                    if (link) {
                        link.setAttribute("href", "index.html");
                        link.textContent = "Home";
                    }
                    return;
                }
                const snap = {
                    fields,
                    scans: dashRegional.allScans || [],
                    weatherLogs: wxArr,
                    fieldContextStates: Object.values(dashRegional.contextByField || {}),
                    regionalBriefing: "",
                    interventions: [],
                };
                const brief = buildTwinBriefForAssistant(snap);
                if (!brief) {
                    sum.textContent = "Twin teaser needs scan-linked fields — save a scan to a field for sharper sketches.";
                    if (link) {
                        link.setAttribute("href", "scanner.html");
                        link.textContent = "Scanner";
                    }
                    return;
                }
                sum.textContent = `${brief.focusFieldName}: simulated baseline ~${brief.baseline.endHealth}% vs wet-week sketch ~${brief.wetWeek.endHealth}% (Δ ${brief.wetWeek.deltaVsBaseline} pts, ${brief.dataConfidence} confidence). Hypothetical — open Twin tab on the field for curves.`;
                if (link) {
                    link.setAttribute("href", `field-detail.html?f=${encodeURIComponent(brief.focusFieldId)}`);
                    link.textContent = "Open twin";
                }
            }

            function scheduleDashRegionalPulse(uid) {
                clearTimeout(dashRegional.pulseTimer);
                dashRegional.pulseTimer = setTimeout(async () => {
                    const optEl = el("dash-regional-optin");
                    if (!optEl?.checked) return;
                    const pulse = buildRegionalPulse({
                        fields: dashRegional.fieldsList,
                        scansByField: dashRegional.scansByField,
                        contextByField: dashRegional.contextByField,
                        weatherLog: dashRegional.wxLog,
                    });
                    if (!pulse) return;
                    try {
                        await contributeRegionalPulse(db, uid, pulse);
                        const b = el("dash-regional-brief");
                        const text = await fetchRegionalBriefing(db);
                        dashRegional.regionalBriefText = text;
                        if (b) b.textContent = text;
                        scheduleAmbientRefresh();
                    } catch (e) {
                        console.warn("[dashboard] regional pulse:", e?.message || e);
                    }
                }, 15000);
            }

            async function refreshDashRegionalBrief() {
                const b = el("dash-regional-brief");
                try {
                    const text = await fetchRegionalBriefing(db);
                    dashRegional.regionalBriefText = text;
                    if (b) b.textContent = text;
                } catch {
                    dashRegional.regionalBriefText = "";
                    if (b) b.textContent = "Regional briefing unavailable.";
                }
                scheduleAmbientRefresh();
            }

            const optElInit = el("dash-regional-optin");
            if (optElInit && !optElInit.dataset.regionalBound) {
                optElInit.dataset.regionalBound = "1";
                optElInit.addEventListener("change", async (e) => {
                    try {
                        await setDoc(
                            doc(db, "regional_intel_settings", user.uid),
                            {
                                optIn: !!e.target.checked,
                                updatedAt: serverTimestamp(),
                                schemaVersion: 1,
                            },
                            { merge: true },
                        );
                        if (e.target.checked) scheduleDashRegionalPulse(user.uid);
                        refreshDashRegionalBrief();
                    } catch (err) {
                        console.warn("[dashboard] regional opt-in:", err?.message || err);
                    }
                });
            }

            getRegionalOptIn(db, user.uid).then((on) => {
                const opt = el("dash-regional-optin");
                if (opt) opt.checked = !!on;
            });
            sub(
                doc(db, "regional_intel_settings", user.uid),
                (snap) => {
                    const opt = el("dash-regional-optin");
                    if (!opt) return;
                    opt.checked = snap.exists() && snap.data()?.optIn === true;
                },
                "regional_intel_settings",
            );
            sub(
                doc(db, "learning_profiles", user.uid),
                (snap) => {
                    dashRegional.learningProfile = snap.exists() ? snap.data() : null;
                    scheduleAmbientRefresh();
                },
                "learning_profiles",
            );
            refreshDashRegionalBrief();

            sub(
                query(
                    collection(db, "farm_operational_tasks"),
                    where("userId", "==", user.uid),
                    where("status", "==", "open"),
                    limit(24),
                ),
                (snap) => {
                    dashOpenTasks = [];
                    snap.forEach((d) => dashOpenTasks.push({ id: d.id, ...d.data() }));
                    dashOpenTasks.sort(
                        (a, b) =>
                            (tsToMs(a.dueAt) || 9e15) - (tsToMs(b.dueAt) || 9e15) ||
                            tsToMs(b.createdAt) - tsToMs(a.createdAt),
                    );
                    renderDashOpsCard();
                    scheduleAmbientRefresh();
                },
                "farm_operational_tasks",
            );

            const userRef = doc(db, "users", user.uid);
            sub(userRef, (snap) => {
                    const data = snap.exists() ? snap.data() : {};
                    const fullName = data?.name || user.displayName
                        || (user.email ? user.email.split("@")[0] : "Farmer");
                    const firstName = String(fullName).split(" ")[0] || "Farmer";

                    try {
                        localStorage.setItem("agri_user", JSON.stringify({ name: fullName }));
                    } catch (_) {}

                    const greetEl = el("hdr-greet");
                    const nameSpan = el("hdr-name");
                    if (greetEl) greetEl.textContent = getGreeting() + ",";
                    if (nameSpan) nameSpan.textContent = firstName;

                    const avatar = el("hdr-avatar-img");
                    if (avatar) {
                        avatar.src = user.photoURL
                            ? user.photoURL
                            : `https://ui-avatars.com/api/?name=${encodeURIComponent(fullName)}&background=10B981&color=fff&size=80`;
                    }

                    if (data?.langPreference && window.i18n) {
                        window.i18n.setLanguage(data.langPreference);
                    }
                }, "users profile");

                sub(
                    query(collection(db, "fields"), where("userId", "==", user.uid), limit(100)),
                    (snap) => {
                        totalFields = snap.size;
                        dashRegional.fieldsList = [];
                        snap.forEach((d) => dashRegional.fieldsList.push({ id: d.id, ...d.data() }));
                        updateGlanceFields(totalFields);

                        const cropSet = new Set();
                        snap.forEach((d) => {
                            const crop = d.data()?.crop;
                            if (crop && typeof crop === "string") {
                                cropSet.add(crop.trim().toLowerCase());
                            }
                        });
                        updateGlanceCrops(cropSet.size);

                        renderHomeFields(snap);
                        updateFarmStatus(totalFields, totalScans);
                        if (el("dash-regional-optin")?.checked) scheduleDashRegionalPulse(user.uid);
                        renderDashOpsCard();
                        renderDashTwinCard();
                        scheduleAmbientRefresh();
                    },
                    "fields"
                );

                sub(
                    query(collection(db, "notifications"), where("userId", "==", user.uid), limit(35)),
                    (snap) => {
                        const items = [];
                        snap.forEach((d) => {
                            const v = d.data() || {};
                            items.push({ id: d.id, ...v });
                        });
                        items.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
                        setNotifBadge(countUnreadForBadge(items));
                        renderNotifPanel(items);
                    },
                    "notifications"
                );

                sub(
                    query(collection(db, "crop_scans"), where("userId", "==", user.uid), limit(100)),
                    (snap) => {
                        const scans = [];
                        snap.forEach((d) => scans.push({ id: d.id, ...d.data() }));
                        scans.sort((a, b) => tsToMs(b.createdAt) - tsToMs(a.createdAt));
                        totalScans = scans.length;
                        updateFarmStatus(totalFields, totalScans);

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
                            dashRegional.allScans = [];
                            dashRegional.scansByField = {};
                            renderDashTwinCard();
                            scheduleAmbientRefresh();
                            return;
                        }

                        dashRegional.allScans = scans;

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
                            const disease = latest?.diagnosis?.label || latest?.diagnosis?.name || latest?.disease || null;
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

                        const recent14d = scans.filter(
                            (s) => Date.now() - tsToMs(s.createdAt) <= 14 * 86400000
                        );
                        dashRegional.scansByField = {};
                        for (const s of scans) {
                            const fid = s.fieldId;
                            if (!fid) continue;
                            const prev = dashRegional.scansByField[fid];
                            if (!prev || tsToMs(s.createdAt) > tsToMs(prev.createdAt)) {
                                dashRegional.scansByField[fid] = s;
                            }
                        }
                        renderDashTwinCard();
                        if (el("dash-regional-optin")?.checked) scheduleDashRegionalPulse(user.uid);
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
                            scheduleAmbientRefresh();
                            return;
                        }

                        const raw = pestSig * 22 + fungalSig * 14 + critSig * 18;
                        const prob = clamp(Math.round((raw / Math.max(1, total)) * 2.2), 0, 95);
                        const riskLevel = prob >= 70 ? "high" : prob >= 35 ? "medium" : "low";
                        const riskLabel = riskLevel === "high" ? t("high") : riskLevel === "medium" ? t("medium") : t("low");

                        if (pestRiskEl) {
                            pestRiskEl.textContent = riskLabel;
                            pestRiskEl.style.color = pestRiskColor(riskLevel);
                        }
                        if (pestDescEl) {
                            if (riskLevel === "high") {
                                pestDescEl.textContent = "High pest activity detected in recent scans. Immediate attention required.";
                            } else if (riskLevel === "medium") {
                                pestDescEl.textContent = `${riskLabel} pest pressure based on scan patterns. Monitor closely.`;
                            } else {
                                pestDescEl.textContent = "Pest risk is low based on recent scan analysis. Continue monitoring.";
                            }
                        }
                        if (pestImgEl) pestImgEl.src = pestRiskImg(riskLevel);

                        const blip = el("radar-blip");
                        if (blip) {
                            const positions = {
                                high: { top: "25%", left: "65%" },
                                medium: { top: "35%", left: "60%" },
                                low: { top: "30%", left: "55%" },
                            };
                            const pos = positions[riskLevel] || positions.low;
                            blip.style.top = pos.top;
                            blip.style.left = pos.left;
                            blip.style.background = pestRiskColor(riskLevel);
                            blip.style.boxShadow = `0 0 8px ${pestRiskColor(riskLevel)}`;
                        }
                        scheduleAmbientRefresh();
                    },
                    "crop_scans"
                );

                sub(
                    query(collection(db, "weather_logs"), where("userId", "==", user.uid), limit(40)),
                    (snap) => {
                        let bestDoc = null;
                        let bestMs = 0;
                        snap.forEach((d) => {
                            const ms = tsToMs(d.data()?.fetchedAt);
                            if (ms >= bestMs) {
                                bestMs = ms;
                                bestDoc = d;
                            }
                        });
                        if (!bestDoc) {
                            updateGlanceSoil(null);
                            updateGlanceIrrig(null);
                            dashRegional.wxLog = null;
                            renderDashTwinCard();
                            scheduleAmbientRefresh();
                            return;
                        }
                        const wdata = bestDoc.data();
                        dashRegional.wxLog = wdata;
                        const soilEst = wdata?.derived?.soilMoistureEstimate ?? null;
                        updateGlanceSoil(soilEst);
                        if (soilEst !== null) {
                            const irrigEff = clamp(Math.round(85 - (soilEst - 50) * 0.3), 40, 98);
                            updateGlanceIrrig(irrigEff);
                        } else {
                            updateGlanceIrrig(null);
                        }
                        if (el("dash-regional-optin")?.checked) scheduleDashRegionalPulse(user.uid);
                        renderDashTwinCard();
                        scheduleAmbientRefresh();
                    },
                    "weather_logs"
                );

                sub(
                    query(collection(db, "field_context_state"), where("userId", "==", user.uid), limit(40)),
                    (snap) => {
                        dashRegional.contextByField = {};
                        snap.forEach((d) => {
                            dashRegional.contextByField[d.id] = { fieldId: d.id, ...d.data() };
                        });
                        if (el("dash-regional-optin")?.checked) scheduleDashRegionalPulse(user.uid);
                        renderDashTwinCard();
                        scheduleAmbientRefresh();
                    },
                    "field_context_state"
                );

                sub(
                    query(
                        collection(db, "alerts"),
                        where("userId", "==", user.uid),
                        orderBy("createdAt", "desc"),
                        limit(12)
                    ),
                    (snap) => {
                        const items = [];
                        snap.forEach((d) => items.push({ id: d.id, ...d.data() }));
                        renderRecentAlertsList(items);
                    },
                    "alerts"
                );

                sub(
                    query(
                        collection(db, "crop_health"),
                        where("userId", "==", user.uid),
                        orderBy("updatedAt", "desc"),
                        limit(16)
                    ),
                    (snap) => {
                        const rows = [];
                        snap.forEach((d) => rows.push({ id: d.id, ...d.data() }));
                        renderCropHealthStrip(rows);
                    },
                    "crop_health"
                );

                sub(
                    query(
                        collection(db, "pest_predictions"),
                        where("userId", "==", user.uid),
                        orderBy("createdAt", "desc"),
                        limit(1)
                    ),
                    (snap) => {
                        if (snap.empty) return;
                        const p = snap.docs[0].data() || {};
                        const level = String(p.riskLevel || "").toLowerCase();
                        if (!level) return;
                        const rk = level === "high" ? "high" : level === "medium" ? "medium" : "low";
                        const pestRiskEl = el("pest-risk");
                        const pestDescEl = el("pest-desc");
                        const pestImgEl = el("pest-img");
                        if (pestRiskEl) {
                            pestRiskEl.textContent =
                                rk === "high" ? t("high") : rk === "medium" ? t("medium") : t("low");
                            pestRiskEl.style.color = pestRiskColor(rk);
                        }
                        if (pestDescEl) {
                            const names = (p.threats || []).map((x) => x.name).filter(Boolean);
                            pestDescEl.textContent = names.length
                                ? names.slice(0, 3).join(" · ")
                                : "Model refreshed from your latest saved analysis.";
                        }
                        if (pestImgEl) pestImgEl.src = pestRiskImg(rk);
                    },
                    "pest_predictions"
                );

                sub(
                    query(
                        collection(db, "ai_recommendations"),
                        where("userId", "==", user.uid),
                        limit(5)
                    ),
                    () => {},
                    "ai_recommendations"
                );
        } catch (err) {
            console.warn("[dashboard] mountHome:", err);
        }
    };

    const revealDashboard = () => {
        disarmDashFailsafe();
        document.body.classList.remove("dashboard-wait");
    };

    let homeMountedUid = null;

    const bindHomeForUser = (user) => {
        if (!user) return;
        if (homeMountedUid === user.uid) return;
        homeUnsubs.forEach((u) => {
            try { u(); } catch (_) {}
        });
        homeUnsubs = [];
        homeMountedUid = user.uid;
        revealDashboard();
        try {
            mountHome(user);
        } catch (err) {
            console.warn("[dashboard] mountHome failed:", err);
        }
    };

    (async () => {
        await auth.authStateReady();
        const initial = auth.currentUser;
        if (!initial) {
            window.location.replace("login.html");
            return;
        }
        bindHomeForUser(initial);

        onAuthStateChanged(auth, (user) => {
            if (!user) {
                homeMountedUid = null;
                homeUnsubs.forEach((u) => {
                    try { u(); } catch (_) {}
                });
                homeUnsubs = [];
                window.location.replace("login.html");
                return;
            }
            bindHomeForUser(user);
        });
    })();
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
