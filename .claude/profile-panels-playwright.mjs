/**
 * Browser test: Account → Language clears stale Licenses/About without wrong panel motion.
 * Requires: npm install playwright (repo root)
 * Run: node .claude/profile-panels-playwright.mjs
 */
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch (e) {
  console.error("Install Playwright: npm install playwright");
  process.exit(1);
}

const root = path.join(__dirname, "..");
const port = 9789;
const base = `http://127.0.0.1:${port}`;

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

await page.goto(`${base}/profile.html?e2e_panels=1`, { waitUntil: "load", timeout: 90000 });

await page.waitForSelector("#main-settings-btn", { state: "visible", timeout: 15000 });
await page.click("#main-settings-btn");
await page.waitForSelector("#panel-account-settings.active", { timeout: 10000 });

await page.evaluate(() => {
  window.openPanel("panel-about");
  window.openPanel("panel-licenses");
});
await page.waitForSelector("#panel-licenses.active", { timeout: 5000 });

/* Row is under Licenses — real entry is same function as header translate icon */
await page.evaluate(() => window.openLangSheet());
await page.waitForSelector("#panel-choose-language.active", { timeout: 10000 });

const state = await page.evaluate(() => ({
  licenses: document.getElementById("panel-licenses")?.classList.contains("active"),
  lang: document.getElementById("panel-choose-language")?.classList.contains("active"),
  account: document.getElementById("panel-account-settings")?.classList.contains("active"),
  about: document.getElementById("panel-about")?.classList.contains("active"),
}));

if (state.licenses) {
  throw new Error("panel-licenses still active after openLangSheet (regression)");
}
if (state.about) {
  throw new Error("panel-about still active after openLangSheet");
}
if (!state.lang) {
  throw new Error("panel-choose-language not active");
}
if (!state.account) {
  throw new Error("panel-account-settings should stay active under language picker");
}

await browser.close();
await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));

if (errors.length) console.warn("page errors:", errors);
console.log("profile-panels-playwright: OK");
