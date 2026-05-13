/**
 * Verifies i18n + profile language picker wiring without Firebase auth.
 * Run from repo root: node .claude/lang-core-smoke.mjs
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const storage = new Map();
globalThis.localStorage = {
  getItem(k) {
    return storage.has(k) ? storage.get(k) : null;
  },
  setItem(k, v) {
    storage.set(k, String(v));
  },
};

let htmlLang = "";
globalThis.document = {
  documentElement: {
    get lang() {
      return htmlLang;
    },
    set lang(v) {
      htmlLang = v;
    },
  },
  querySelectorAll() {
    return [];
  },
  dispatchEvent() {},
  createTextNode(t) {
    return { nodeType: 3, textContent: t };
  },
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, opts) {
    this.type = type;
    this.detail = opts?.detail;
  }
};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};

const i18nPath = pathToFileURL(join(repoRoot, "js", "i18n.js")).href;
const i18n = await import(i18nPath);

const { LANGUAGES, setLanguage, getLang, t } = i18n;

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

assert(LANGUAGES.length >= 13, `LANGUAGES should list all locales (got ${LANGUAGES.length})`);

for (const L of LANGUAGES) {
  setLanguage(L.code, { broadcast: false });
  assert(getLang() === L.code, `setLanguage(${L.code})`);
}

setLanguage("en", { broadcast: false });
assert(t("goodMorning") === "Good morning", "en goodMorning");

setLanguage("hi", { broadcast: false });
assert(t("goodMorning").includes("सु"), "hi goodMorning looks Hindi");

setLanguage("gu", { broadcast: false });
assert(/[\u0A80-\u0AFF]/.test(t("goodMorning")), "gu goodMorning uses Gujarati script");

const before = getLang();
setLanguage("not-a-locale", { broadcast: false });
assert(getLang() === before, "invalid code should not change lang");

assert(localStorage.getItem("agri_lang") === before, "localStorage agri_lang");

const html = readFileSync(join(repoRoot, "profile.html"), "utf8");
for (const id of ["as-lang-search", "as-lang-list", "lang-picker-overlay"]) {
  assert(html.includes(`id="${id}"`) || html.includes(`id='${id}'`), `profile.html missing #${id}`);
}

console.log("lang-core-smoke: OK", { locales: LANGUAGES.map((x) => x.code).join(",") });
