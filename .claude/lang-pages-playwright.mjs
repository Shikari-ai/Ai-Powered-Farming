/**
 * Browser: DOM harness (test-fixtures/lang-pages-dom.html) imports only i18n — no auth-session.
 * Cycles every locale and checks each [data-i18n] label updates vs English (navAi allowed same).
 *
 * Run: node .claude/lang-pages-playwright.mjs
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (e) {
  console.error("Install Playwright: npm install playwright");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

function startStaticServer(rootDir) {
  const rootNorm = path.resolve(rootDir);
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || "/", "http://127.0.0.1");
        let p = u.pathname;
        if (p === "/") p = "/index.html";
        const fp = path.normalize(path.join(rootNorm, decodeURIComponent(p)));
        if (!fp.startsWith(rootNorm)) {
          res.writeHead(403);
          res.end();
          return;
        }
        fs.readFile(fp, (err, data) => {
          if (err) {
            res.writeHead(404);
            res.end("not found");
            return;
          }
          const ext = path.extname(fp);
          res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
          res.end(data);
        });
      } catch (_) {
        res.writeHead(500);
        res.end();
      }
    });
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const listenPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ srv, port: listenPort });
    });
    srv.on("error", reject);
  });
}

const SAME_AS_ENGLISH_OK = new Set(["navAi"]);
const LANG_CODES = ["en", "hi", "bn", "ta", "te", "mr", "gu", "pa", "kn", "ml", "ur", "or", "cg"];

const { srv: server, port } = await startStaticServer(root);
const base = `http://127.0.0.1:${port}`;
const url = `${base}/test-fixtures/lang-pages-dom.html`;

/** Avoid indefinite hang if Chromium is missing or first-time browser download stalls. */
const launchMs = Math.min(180_000, Math.max(15_000, Number(process.env.AGRI_PLAYWRIGHT_LAUNCH_MS || "90000")));
const browser = await chromium.launch({ headless: true, timeout: launchMs });
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

await page.goto(url, { waitUntil: "load", timeout: 120000 });
await page.waitForFunction(() => window.i18n && window.__LANG_DOM_HARNESS, null, { timeout: 60000 });

const bundle = await page.evaluate((codes) => {
  const els = [...document.querySelectorAll("[data-i18n]")];
  const keys = [...new Set(els.map((el) => el.getAttribute("data-i18n")))];
  const byLang = {};
  for (const code of codes) {
    window.i18n.setLanguage(code);
    const row = {};
    for (const el of document.querySelectorAll("[data-i18n]")) {
      const k = el.getAttribute("data-i18n");
      row[k] = (el.textContent || "").trim();
    }
    byLang[code] = row;
  }
  return { keys, byLang };
}, LANG_CODES);

await browser.close();
await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));

if (pageErrors.length) {
  console.warn("pageerror:", pageErrors.slice(0, 8));
}

const en = bundle.byLang.en;
const drift = [];
for (const code of LANG_CODES) {
  if (code === "en") continue;
  const row = bundle.byLang[code];
  for (const key of bundle.keys) {
    if (!row[key] || row[key] === key) {
      drift.push({ locale: code, key, problem: "empty-or-raw-key", value: row[key] });
      continue;
    }
    if (SAME_AS_ENGLISH_OK.has(key)) continue;
    if (row[key] === en[key]) drift.push({ locale: code, key, problem: "same-as-english", value: row[key] });
  }
}

if (drift.length) {
  console.error(JSON.stringify(drift.slice(0, 40), null, 2));
  process.exit(1);
}

console.log("lang-pages-playwright: OK", {
  url,
  keys: bundle.keys.length,
  langs: LANG_CODES.length,
});
