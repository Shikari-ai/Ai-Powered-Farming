import { LANGUAGES, setLanguage, getLang } from "../js/i18n.js";

const langSearch = document.getElementById("as-lang-search");
const langList = document.getElementById("as-lang-list");
const langSave = document.getElementById("as-lang-save");
const status = document.getElementById("smoke-status");
let pendingLang = getLang();

function langMatchesFilter(L, rawQ) {
  const q = (rawQ || "").trim().toLowerCase();
  if (!q) return true;
  const blob = `${L.name} ${L.native} ${L.code}`.toLowerCase();
  return blob.includes(q);
}

function renderLangPickerRows() {
  const q = langSearch?.value ?? "";
  const items = LANGUAGES.filter((L) => langMatchesFilter(L, q));
  langList.innerHTML = items
    .map((L) => {
      const sel = L.code === pendingLang;
      return `<button type="button" class="lang-row ${sel ? "selected" : ""}" data-code="${L.code}">${L.native} (${L.code})</button>`;
    })
    .join("");
  langList.querySelectorAll(".lang-row").forEach((row) => {
    row.addEventListener("click", () => {
      pendingLang = row.getAttribute("data-code");
      renderLangPickerRows();
      syncLangSaveState();
    });
  });
}

function syncLangSaveState() {
  langSave.disabled = pendingLang === getLang();
}

langSearch.addEventListener("input", renderLangPickerRows);
renderLangPickerRows();
syncLangSaveState();

langSave.addEventListener("click", () => {
  setLanguage(pendingLang);
  syncLangSaveState();
  status.textContent = `saved:${getLang()}`;
});

window.__langSmoke = {
  rowCount: () => langList.querySelectorAll(".lang-row").length,
  filter: (q) => {
    langSearch.value = q;
    renderLangPickerRows();
    return langList.querySelectorAll(".lang-row").length;
  },
  selectCode: (code) => {
    pendingLang = code;
    renderLangPickerRows();
    syncLangSaveState();
  },
};
