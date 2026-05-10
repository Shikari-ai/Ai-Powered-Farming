/**
 * weather-li.js — Location Intelligence panel for weather.html
 * Runs after auth, shows nearby places + NavIC accuracy at the bottom of
 * the Weather Intelligence page.
 */
import { auth } from "./auth.js?v=28";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { runLocationIntelligence, CATEGORIES } from "./location-intelligence.js";
import { navicBadgeHTML } from "./navic.js";

const qs = (id) => document.getElementById(id);

/* ── Render helpers ── */
function renderAddress(address) {
  if (!address) return;
  const chipsEl = qs("lic-addr-chips");
  const lineEl  = qs("lic-address-line");
  if (!chipsEl) return;

  const chips = [];
  if (address.village)  chips.push({ text: `📍 ${address.village}`, primary: true });
  if (address.district) chips.push({ text: address.district });
  if (address.state)    chips.push({ text: address.state });
  if (address.road)     chips.push({ text: `🛣 ${address.road}` });

  chipsEl.innerHTML = chips.map(c =>
    `<span class="lic-addr-chip${c.primary ? " primary" : ""}">${c.text}</span>`
  ).join("");

  const summary = [address.village, address.district, address.state].filter(Boolean).join(", ");
  if (lineEl && summary) lineEl.textContent = summary;
}

function renderPlaces(places) {
  const container = qs("lic-places");
  if (!container) return;
  if (!places?.length) {
    container.innerHTML = `<p style="font-size:12px;color:rgba(255,255,255,0.3);text-align:center;padding:12px 0;">No nearby places found in 2.5 km radius</p>`;
    return;
  }
  container.innerHTML = places.slice(0, 8).map((p, i) => {
    const cat = CATEGORIES[p.category] || { icon: "📍", color: "#94A3B8", label: p.category };
    return `
    <div class="lic-place" style="animation-delay:${i * 60}ms;">
      <div class="lic-place-icon" style="border-color:${cat.color}22;background:${cat.color}11;">${cat.icon}</div>
      <div class="lic-place-info">
        <div class="lic-place-name">${p.name}</div>
        <div class="lic-place-type">${cat.label}</div>
      </div>
      <div class="lic-place-dist" style="color:${cat.color};">${p.distLabel}</div>
    </div>`;
  }).join("");
}

function renderInsights(insights) {
  const container = qs("lic-insights");
  const title     = qs("lic-insights-title");
  if (!container) return;
  if (!insights?.length) { if (title) title.style.display = "none"; return; }
  if (title) title.style.display = "block";
  container.innerHTML = insights.map((ins, i) => {
    const cls = ins.priority === "high" ? "lic-insight-high" : ins.priority === "medium" ? "lic-insight-medium" : "";
    return `
    <div class="lic-insight ${cls}" style="animation-delay:${i * 80}ms;">
      <span class="lic-insight-icon">${ins.icon}</span>
      <span>${ins.text}</span>
    </div>`;
  }).join("");
}

function renderAccuracy(accuracy, gnssSource) {
  const accFill   = qs("lic-acc-fill");
  const gnssBadge = qs("lic-gnss-badge");
  const accVal    = qs("lic-acc-val");
  if (!accFill) return;
  const quality = accuracy <= 5 ? 100 : accuracy <= 20 ? 90 : accuracy <= 100 ? 70 : accuracy <= 500 ? 40 : 15;
  accFill.style.width = `${quality}%`;
  const src = gnssSource || (accuracy > 1000 ? "IP" : "GPS");
  if (gnssBadge) gnssBadge.innerHTML = navicBadgeHTML(src);
  if (accVal) accVal.textContent = accuracy ? `±${Math.round(accuracy)}m` : "--";
}

function renderCoords(coords) {
  const el = qs("lic-coords-txt");
  if (el && coords) el.textContent = `${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`;
}

function onUpdate(data) {
  if (data.error) return;
  const { coords, address, places, insights, accuracy, gnssSource, phase } = data;
  if (coords)              renderCoords(coords);
  if (accuracy !== undefined) renderAccuracy(accuracy, gnssSource ?? coords?.gnssSource ?? null);
  if (address)             renderAddress(address);
  if (places?.length)      renderPlaces(places);
  if (insights?.length)    renderInsights(insights);
  const card = qs("loc-intel-card");
  if (card) card.style.opacity = phase === "approximate" ? "0.75" : "1";
}

/* ── Boot ── */
onAuthStateChanged(auth, (user) => {
  if (!user) return;

  runLocationIntelligence(user.uid, onUpdate, { radius: 2500, persist: true });

  const btn = qs("lic-refresh-btn");
  btn?.addEventListener("click", () => {
    btn.classList.add("spinning");
    const places = qs("lic-places");
    if (places) places.innerHTML = [1,2,3].map(() => '<div class="lic-skeleton"></div>').join("");
    runLocationIntelligence(user.uid, (data) => {
      btn.classList.remove("spinning");
      onUpdate(data);
    }, { radius: 2500, persist: true });
  });
});
