import { LANGUAGES, setLanguage, getLang } from "../js/i18n.js";

const langSearch = document.getElementById("as-lang-search");
const langList = document.getElementById("as-lang-list");
const status = document.getElementById("smoke-status");

function langMatchesFilter(L, rawQ) {
  const q = (rawQ || "").trim().toLowerCase();
  if (!q) return true;
  const blob = `${L.name} ${L.native} ${L.code} ${L.region || ""}`.toLowerCase();
  return blob.includes(q);
}

function renderLangPickerRows() {
  const q = langSearch?.value ?? "";
  const items = LANGUAGES.filter((L) => langMatchesFilter(L, q));
  const active = getLang();
  langList.innerHTML = items
    .map((L) => {
      const sel = L.code === active;
      return `<button type="button" class="lang-row ${sel ? "selected" : ""}" data-code="${L.code}">${L.native} (${L.code})</button>`;
    })
    .join("");
  langList.querySelectorAll(".lang-row").forEach((row) => {
    row.addEventListener("click", () => {
      const code = row.getAttribute("data-code");
      if (code) setLanguage(code);
      renderLangPickerRows();
      if (status) status.textContent = `applied:${getLang()}`;
    });
  });
}

langSearch.addEventListener("input", renderLangPickerRows);
renderLangPickerRows();

window.__langSmoke = {
  rowCount: () => langList.querySelectorAll(".lang-row").length,
  filter: (q) => {
    langSearch.value = q;
    renderLangPickerRows();
    return langList.querySelectorAll(".lang-row").length;
  },
  selectCode: (code) => {
    setLanguage(code);
    renderLangPickerRows();
  },
};
