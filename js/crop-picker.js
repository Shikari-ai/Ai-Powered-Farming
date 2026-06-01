// Full-screen searchable crop picker used by the Field Add wizard.
// Usage:
//   import { openCropPicker } from "./crop-picker.js";
//   openCropPicker({ initialCrop, initialVariety, onSelect: ({crop, variety}) => {...} });

import { CROP_CATEGORIES, getAllCropEntries } from "./crops-data.js?v=1";

let injected = false;
function injectStylesOnce() {
  if (injected) return;
  injected = true;
  const css = `
  .crop-picker-overlay {
    position: fixed; inset: 0; z-index: 99998;
    background: rgba(8, 12, 10, 0.78);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    display: flex; align-items: stretch; justify-content: center;
    animation: cpFade 0.18s ease-out;
  }
  @keyframes cpFade { from { opacity: 0; } to { opacity: 1; } }
  .crop-picker-sheet {
    display: flex; flex-direction: column;
    width: 100%; max-width: 520px; height: 100%;
    background: linear-gradient(180deg, #0d1612 0%, #0a1410 100%);
    border-left: 1px solid rgba(57,255,20,0.08);
    border-right: 1px solid rgba(57,255,20,0.08);
    color: #e6fff4;
    animation: cpSlide 0.22s cubic-bezier(.2,.7,.3,1);
  }
  @keyframes cpSlide { from { transform: translateY(18px); opacity: 0.4; } to { transform: none; opacity: 1; } }
  .crop-picker-hdr {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 14px 10px;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }
  .crop-picker-hdr h3 { font-size: 16px; font-weight: 600; flex: 1; margin: 0; }
  .crop-picker-close {
    all: unset; cursor: pointer;
    width: 36px; height: 36px; border-radius: 12px;
    display: inline-flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,0.06); color: #fff; font-size: 18px;
  }
  .crop-picker-close:hover { background: rgba(255,255,255,0.12); }
  .crop-picker-search {
    position: relative; padding: 10px 14px 12px;
    border-bottom: 1px solid rgba(255,255,255,0.05);
  }
  .crop-picker-search input {
    width: 100%; box-sizing: border-box;
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 14px; color: #fff;
    padding: 12px 40px 12px 40px;
    font-size: 14px; outline: none;
    transition: border-color 0.18s ease, background 0.18s ease;
  }
  .crop-picker-search input:focus { border-color: rgba(57,255,20,0.45); background: rgba(57,255,20,0.04); }
  .crop-picker-search .cp-mag {
    position: absolute; left: 26px; top: 50%; transform: translateY(-50%);
    color: rgba(255,255,255,0.5); font-size: 16px; pointer-events: none;
  }
  .crop-picker-search .cp-clear {
    position: absolute; right: 22px; top: 50%; transform: translateY(-50%);
    all: unset; cursor: pointer; color: rgba(255,255,255,0.55);
    font-size: 16px; width: 24px; height: 24px;
    display: none; align-items: center; justify-content: center;
    border-radius: 50%;
  }
  .crop-picker-search .cp-clear:hover { background: rgba(255,255,255,0.08); color: #fff; }
  .crop-picker-search.has-q .cp-clear { display: inline-flex; }

  .crop-picker-body { flex: 1; overflow-y: auto; padding: 4px 8px 24px; -webkit-overflow-scrolling: touch; }
  .crop-picker-body::-webkit-scrollbar { width: 6px; }
  .crop-picker-body::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 3px; }

  .cp-cat {
    margin: 8px 4px;
    background: rgba(255,255,255,0.025);
    border: 1px solid rgba(255,255,255,0.05);
    border-radius: 14px; overflow: hidden;
  }
  .cp-cat-hdr {
    all: unset; cursor: pointer; display: flex; align-items: center; gap: 10px;
    width: 100%; box-sizing: border-box; padding: 12px 14px;
    font-size: 13px; font-weight: 600; color: rgba(236,253,245,0.92);
  }
  .cp-cat-hdr i.cp-cat-ico { color: #39ff14; font-size: 16px; }
  .cp-cat-hdr .cp-cat-count { color: rgba(255,255,255,0.45); font-size: 11px; font-weight: 500; margin-left: auto; }
  .cp-cat-hdr .cp-chev { transition: transform 0.18s ease; color: rgba(255,255,255,0.45); font-size: 16px; }
  .cp-cat.open .cp-cat-hdr .cp-chev { transform: rotate(90deg); color: #39ff14; }
  .cp-cat-body { display: none; padding: 2px 6px 8px; }
  .cp-cat.open .cp-cat-body { display: block; animation: cpExpand 0.16s ease-out; }
  @keyframes cpExpand { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }

  .cp-crop {
    margin: 4px 0;
    background: rgba(255,255,255,0.03);
    border-radius: 11px;
    overflow: hidden;
  }
  .cp-crop-row {
    all: unset; cursor: pointer; display: flex; align-items: center; gap: 10px;
    width: 100%; box-sizing: border-box; padding: 10px 12px;
    font-size: 13.5px; color: #fff;
  }
  .cp-crop-row:hover { background: rgba(57,255,20,0.06); }
  .cp-crop-row .cp-crop-name { flex: 1; }
  .cp-crop-row .cp-vcount { font-size: 10px; color: rgba(255,255,255,0.45); padding: 2px 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 999px; }
  .cp-crop-row .cp-chev2 { color: rgba(255,255,255,0.4); font-size: 14px; transition: transform 0.18s ease; }
  .cp-crop.open .cp-crop-row .cp-chev2 { transform: rotate(90deg); color: #39ff14; }
  .cp-crop-row.is-selected { background: rgba(57,255,20,0.10); color: #39ff14; }

  .cp-varieties { display: none; padding: 2px 4px 8px 32px; }
  .cp-crop.open .cp-varieties { display: block; }
  .cp-variety {
    all: unset; cursor: pointer; display: flex; align-items: center; gap: 8px;
    width: 100%; box-sizing: border-box; padding: 8px 10px;
    font-size: 12.5px; color: rgba(236,253,245,0.85);
    border-radius: 9px; margin: 2px 0;
  }
  .cp-variety:hover { background: rgba(57,255,20,0.07); color: #fff; }
  .cp-variety.is-selected { background: rgba(57,255,20,0.13); color: #39ff14; }
  .cp-variety i { font-size: 14px; color: #39ff14; opacity: 0; }
  .cp-variety.is-selected i { opacity: 1; }

  .cp-empty {
    padding: 40px 20px; text-align: center; color: rgba(255,255,255,0.5); font-size: 13px;
  }
  .cp-empty i { font-size: 28px; display: block; margin-bottom: 8px; color: rgba(255,255,255,0.3); }

  .cp-result-list { padding: 4px 4px; }
  .cp-result {
    all: unset; cursor: pointer;
    display: flex; align-items: center; gap: 10px;
    padding: 11px 12px; border-radius: 11px;
    margin: 3px 0; background: rgba(255,255,255,0.03);
    font-size: 13.5px; color: #fff;
  }
  .cp-result:hover { background: rgba(57,255,20,0.07); }
  .cp-result .cp-result-cat { font-size: 10.5px; color: rgba(255,255,255,0.45); margin-left: auto; padding-left: 8px; }
  .cp-result strong { color: #39ff14; font-weight: 600; }
  `;
  const tag = document.createElement("style");
  tag.textContent = css;
  document.head.appendChild(tag);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function highlight(text, q) {
  if (!q) return escapeHtml(text);
  const safeText = escapeHtml(text);
  const safeQ = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safeText.replace(new RegExp(`(${safeQ})`, "ig"), "<strong>$1</strong>");
}

export function openCropPicker({ initialCrop = "", initialVariety = "", onSelect } = {}) {
  injectStylesOnce();
  const ALL = getAllCropEntries();

  const overlay = document.createElement("div");
  overlay.className = "crop-picker-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `
    <div class="crop-picker-sheet">
      <div class="crop-picker-hdr">
        <h3>Select crop</h3>
        <button type="button" class="crop-picker-close" aria-label="Close"><i class="ri-close-line"></i></button>
      </div>
      <div class="crop-picker-search">
        <i class="ri-search-line cp-mag"></i>
        <input id="cp-q" type="text" placeholder="Search any crop or variety (rice, basmati, mango, alphonso…)" autocomplete="off" />
        <button type="button" class="cp-clear" aria-label="Clear"><i class="ri-close-circle-fill"></i></button>
      </div>
      <div class="crop-picker-body" id="cp-body"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  // Prevent background scroll while picker is open
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const close = () => {
    overlay.remove();
    document.body.style.overflow = prevOverflow;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".crop-picker-close").addEventListener("click", close);

  const body = overlay.querySelector("#cp-body");
  const qInput = overlay.querySelector("#cp-q");
  const clearBtn = overlay.querySelector(".cp-clear");
  const searchWrap = overlay.querySelector(".crop-picker-search");

  // --- Browse mode (categories + accordions) ---
  function renderBrowse() {
    const parts = [];
    for (const cat of CROP_CATEGORIES) {
      const open = cat.name === "Cereals & Grains" || cropInCategory(cat, initialCrop);
      parts.push(`<div class="cp-cat ${open ? "open" : ""}" data-cat="${escapeHtml(cat.name)}">`);
      parts.push(`<button type="button" class="cp-cat-hdr">
        <i class="cp-cat-ico ${cat.icon || "ri-plant-line"}"></i>
        <span>${escapeHtml(cat.name)}</span>
        <span class="cp-cat-count">${cat.crops.length}</span>
        <i class="cp-chev ri-arrow-right-s-line"></i>
      </button>`);
      parts.push(`<div class="cp-cat-body">`);
      for (const c of cat.crops) {
        const varieties = c.varieties || [];
        const hasV = varieties.length > 0;
        const cropOpen = initialCrop === c.name && hasV;
        const cropSel = initialCrop === c.name && !initialVariety;
        parts.push(`<div class="cp-crop ${cropOpen ? "open" : ""}" data-crop="${escapeHtml(c.name)}">`);
        parts.push(`<button type="button" class="cp-crop-row ${cropSel ? "is-selected" : ""}" data-action="${hasV ? "expand" : "pick"}">
          <span class="cp-crop-name">${escapeHtml(c.name)}</span>
          ${hasV ? `<span class="cp-vcount">${varieties.length} varieties</span><i class="cp-chev2 ri-arrow-right-s-line"></i>` : `<i class="cp-chev2 ri-arrow-right-s-line"></i>`}
        </button>`);
        if (hasV) {
          parts.push(`<div class="cp-varieties">`);
          // "Any variety" option
          parts.push(`<button type="button" class="cp-variety ${cropSel ? "is-selected" : ""}" data-variety="">
            <i class="ri-check-line"></i><span>Any / unspecified</span>
          </button>`);
          for (const v of varieties) {
            const vSel = initialCrop === c.name && initialVariety === v;
            parts.push(`<button type="button" class="cp-variety ${vSel ? "is-selected" : ""}" data-variety="${escapeHtml(v)}">
              <i class="ri-check-line"></i><span>${escapeHtml(v)}</span>
            </button>`);
          }
          parts.push(`</div>`);
        }
        parts.push(`</div>`);
      }
      parts.push(`</div></div>`);
    }
    body.innerHTML = parts.join("");
    wireBrowse();
    // Scroll selected into view
    const sel = body.querySelector(".cp-variety.is-selected, .cp-crop-row.is-selected");
    if (sel) setTimeout(() => sel.scrollIntoView({ block: "center", behavior: "instant" }), 30);
  }

  function cropInCategory(cat, cropName) {
    return cat.crops.some((c) => c.name === cropName);
  }

  function wireBrowse() {
    body.querySelectorAll(".cp-cat-hdr").forEach((btn) => {
      btn.addEventListener("click", () => btn.closest(".cp-cat").classList.toggle("open"));
    });
    body.querySelectorAll(".cp-crop-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.getAttribute("data-action");
        const cropEl = btn.closest(".cp-crop");
        const cropName = cropEl.getAttribute("data-crop");
        if (action === "expand") {
          cropEl.classList.toggle("open");
        } else {
          pick(cropName, "");
        }
      });
    });
    body.querySelectorAll(".cp-variety").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cropEl = btn.closest(".cp-crop");
        const cropName = cropEl.getAttribute("data-crop");
        const v = btn.getAttribute("data-variety") || "";
        pick(cropName, v);
      });
    });
  }

  // --- Search mode (flat ranked results) ---
  function renderSearch(q) {
    const ql = q.trim().toLowerCase();
    const tokens = ql.split(/\s+/).filter(Boolean);
    const matches = [];
    for (const e of ALL) {
      const hay = `${e.crop} ${e.variety || ""} ${e.category}`.toLowerCase();
      if (tokens.every((t) => hay.includes(t))) {
        // Rank: exact crop/variety prefix matches first
        let score = 0;
        if (e.crop.toLowerCase().startsWith(ql)) score -= 10;
        if ((e.variety || "").toLowerCase().startsWith(ql)) score -= 6;
        if (e.crop.toLowerCase().includes(ql)) score -= 3;
        matches.push({ e, score });
      }
    }
    matches.sort((a, b) => a.score - b.score);
    const top = matches.slice(0, 200);
    if (top.length === 0) {
      body.innerHTML = `<div class="cp-empty">
        <i class="ri-search-line"></i>
        No crops match "<strong>${escapeHtml(q)}</strong>".<br>Try a different spelling or browse categories.
      </div>`;
      return;
    }
    const html = ['<div class="cp-result-list">'];
    for (const { e } of top) {
      const label = e.variety ? `${highlight(e.crop, q)} <span style="opacity:.6">·</span> ${highlight(e.variety, q)}` : highlight(e.crop, q);
      html.push(`<button type="button" class="cp-result" data-crop="${escapeHtml(e.crop)}" data-variety="${escapeHtml(e.variety || "")}">
        <span>${label}</span>
        <span class="cp-result-cat">${escapeHtml(e.category)}</span>
      </button>`);
    }
    html.push("</div>");
    body.innerHTML = html.join("");
    body.querySelectorAll(".cp-result").forEach((btn) => {
      btn.addEventListener("click", () => {
        pick(btn.getAttribute("data-crop"), btn.getAttribute("data-variety") || "");
      });
    });
  }

  function pick(crop, variety) {
    try { if (typeof onSelect === "function") onSelect({ crop, variety }); }
    finally { close(); }
  }

  // Wire search
  let searchDebounce = null;
  qInput.addEventListener("input", () => {
    const q = qInput.value;
    searchWrap.classList.toggle("has-q", q.length > 0);
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      if (q.trim().length === 0) renderBrowse();
      else renderSearch(q);
    }, 70);
  });
  clearBtn.addEventListener("click", () => {
    qInput.value = "";
    searchWrap.classList.remove("has-q");
    renderBrowse();
    qInput.focus();
  });

  renderBrowse();
  // Auto-focus search on desktop, not on mobile (avoid surprise keyboard)
  if (!window.matchMedia || !window.matchMedia("(pointer: coarse)").matches) {
    setTimeout(() => qInput.focus(), 80);
  }
}
