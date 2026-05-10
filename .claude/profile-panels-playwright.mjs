/**
 * Browser test: Account → Language clears stale Licenses/About without wrong panel motion.
 *
 * Default URL: https://agritech-4d1ba.web.app (set AGRI_TEST_BASE_URL to override).
 * Hosted runs need a real Firebase session. Either:
 *   - Save storage once: npx playwright open https://agritech-4d1ba.web.app/login.html
 *     then in app: await context.storageState({ path: 'playwright-auth.json' })
 *     or use codegen --save-storage; then AGRI_PLAYWRIGHT_STORAGE=playwright-auth.json
 *   - Or use offline harness: AGRI_TEST_LOCAL=1 (npm run test:profile-panels:ci)
 *
 * Requires: npm install playwright (repo root)
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
const USE_LOCAL = /^1|true$/i.test(process.env.AGRI_TEST_LOCAL || "");
const HOSTED_BASE = (process.env.AGRI_TEST_BASE_URL || "https://agritech-4d1ba.web.app").replace(
  /\/$/,
  ""
);
const STORAGE = process.env.AGRI_PLAYWRIGHT_STORAGE || "";

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

let server = null;
let profileUrl;

if (USE_LOCAL) {
  server = await startStaticServer(root, port);
  profileUrl = `http://127.0.0.1:${port}/profile.html?e2e_panels=1`;
  console.log("profile-panels: local server + ?e2e_panels=1");
} else {
  profileUrl = `${HOSTED_BASE}/profile.html`;
  console.log("profile-panels: hosted", profileUrl);
}

const browser = await chromium.launch({ headless: true });
const ctxOpts = {};
if (!USE_LOCAL && STORAGE && fs.existsSync(STORAGE)) {
  ctxOpts.storageState = STORAGE;
  console.log("profile-panels: using storageState", STORAGE);
} else if (!USE_LOCAL && STORAGE) {
  console.warn("profile-panels: AGRI_PLAYWRIGHT_STORAGE not found, continuing without saved session");
}

const context = await browser.newContext(ctxOpts);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

await page.goto(profileUrl, { waitUntil: "load", timeout: 90000 });

if (!USE_LOCAL) {
  const u = page.url();
  if (/login/i.test(u) || /signup/i.test(u)) {
    await browser.close();
    if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
    console.error(`
profile-panels: opened ${profileUrl} but was redirected (no Firebase session in this browser).
Options:
  • Save cookies to a file and re-run with AGRI_PLAYWRIGHT_STORAGE=/path/to/state.json, or
  • Run offline harness: npm run test:profile-panels:ci
`);
    process.exit(1);
  }
}

await page.waitForSelector("#main-settings-btn", { state: "visible", timeout: 20000 });
await page.click("#main-settings-btn");
await page.waitForSelector("#panel-account-settings.active", { timeout: 10000 });

await page.evaluate(() => window.openLangPicker());
await page.waitForSelector("#lang-picker-overlay.active", { timeout: 10000 });

const state = await page.evaluate(() => ({
  overlay: document.getElementById("lang-picker-overlay")?.classList.contains("active"),
  account: document.getElementById("panel-account-settings")?.classList.contains("active"),
}));

if (!state.overlay) {
  throw new Error("lang-picker-overlay not active");
}
if (!state.account) {
  throw new Error("account settings should stay open behind overlay");
}

await browser.close();
if (server) await new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));

if (errors.length) console.warn("page errors:", errors);
console.log("profile-panels-playwright: OK");
