/**
 * Offline audit: locale pack parity + every data-i18n key on app HTML pages exists in i18n,
 * and non-English locales actually change strings (except known same-as-English keys).
 *
 * Run: node .claude/lang-pages-audit.mjs
 */
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

/** Keys where English text is intentionally reused in all locales (e.g. product name). */
const SAME_AS_ENGLISH_OK = new Set(["navAi"]);

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
const { LANGUAGES, setLanguage, t, findLocalePackGaps } = await import(i18nPath);

function extractDataI18nKeys(html) {
  const re = /data-i18n="([^"]+)"/g;
  const keys = new Set();
  let m;
  while ((m = re.exec(html)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

function listAppHtmlFiles() {
  const skip = new Set([
    "googlee2af47a0969bd619.html",
    "llm-chat-smoke.html",
    "test-fixtures",
  ]);
  const out = [];
  for (const name of readdirSync(repoRoot)) {
    if (!name.endsWith(".html")) continue;
    if (skip.has(name)) continue;
    out.push(name);
  }
  return out.sort();
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const packGaps = findLocalePackGaps();
if (packGaps.length) {
  console.error("findLocalePackGaps:", packGaps.slice(0, 40));
  throw new Error(`locale packs incomplete (${packGaps.length} gap(s))`);
}

const htmlFiles = listAppHtmlFiles();
const perPage = [];
const unionKeys = new Set();

for (const file of htmlFiles) {
  const html = readFileSync(join(repoRoot, file), "utf8");
  const keys = extractDataI18nKeys(html);
  if (keys.size === 0) {
    perPage.push({ file, keys: [], note: "no data-i18n" });
    continue;
  }
  keys.forEach((k) => unionKeys.add(k));
  perPage.push({ file, keys: [...keys].sort() });
}

setLanguage("en", { broadcast: false });
const enStrings = {};
for (const key of unionKeys) {
  const v = t(key);
  assert(v !== key, `unknown i18n key "${key}" (not in English pack)`);
  enStrings[key] = v;
}

const drift = [];
for (const { code } of LANGUAGES) {
  if (code === "en") continue;
  setLanguage(code, { broadcast: false });
  for (const key of unionKeys) {
    if (SAME_AS_ENGLISH_OK.has(key)) continue;
    const cur = t(key);
    if (cur === enStrings[key]) {
      drift.push({ locale: code, key, value: cur });
    }
  }
}

console.log("lang-pages-audit: pack parity OK");
console.log(
  "Per-page data-i18n keys:",
  perPage
    .filter((p) => p.keys?.length)
    .map((p) => `${p.file}: ${p.keys.join(", ")}`)
    .join("\n  ")
);
console.log(`Union keys across pages (${unionKeys.size}):`, [...unionKeys].sort().join(", "));

if (drift.length) {
  console.error("Strings still identical to English (unexpected):", drift.slice(0, 30));
  throw new Error(`i18n drift check failed (${drift.length} pair(s))`);
}

console.log("lang-pages-audit: OK", {
  htmlFilesScanned: htmlFiles.length,
  pagesWithI18n: perPage.filter((p) => p.keys?.length).length,
  locales: LANGUAGES.length,
});
