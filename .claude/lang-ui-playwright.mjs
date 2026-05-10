/**
 * Browser smoke: search + row counts + save updates agri_lang (Playwright).
 * Run from repo root: node .claude/lang-ui-playwright.mjs
 * Depends on: npm install playwright --prefix .claude/smoke-deps
 */
import http from "http";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(path.join(__dirname, "smoke-deps", "node_modules", "playwright"));

const root = path.join(__dirname, "..");
const port = 9788;
const base = `http://127.0.0.1:${port}`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

function startStaticServer(rootDir, listenPort) {
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
    srv.listen(listenPort, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
}

const server = await startStaticServer(root, port);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(`${base}/test-fixtures/lang-ui-smoke.html`, { waitUntil: "load", timeout: 60000 });

const allRows = await page.evaluate(() => window.__langSmoke.rowCount());
if (allRows < 13) throw new Error(`expected ≥13 language rows, got ${allRows}`);

const telRows = await page.evaluate(() => window.__langSmoke.filter("tel"));
if (telRows !== 1) throw new Error(`search "tel" should yield 1 row, got ${telRows}`);

await page.evaluate(() => window.__langSmoke.selectCode("hi"));

const stored = await page.evaluate(() => localStorage.getItem("agri_lang"));
const docLang = await page.evaluate(() => document.documentElement.lang);
if (stored !== "hi") throw new Error(`localStorage agri_lang expected hi, got ${stored}`);
if (docLang !== "hi") throw new Error(`documentElement.lang expected hi, got ${docLang}`);

await browser.close();
await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));

if (errors.length) console.warn("page errors:", errors);
console.log("lang-ui-playwright: OK");
