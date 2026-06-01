/**
 * Live audit of the deployed AgriTech site.
 * - Visits public pages, captures console + network errors
 * - Screenshots desktop (1440x900) and mobile (390x844) per page
 * - Writes JSON report to .claude/audit-results/report.json
 *
 * Run: node .claude/live-audit.mjs
 */
import { chromium } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const BASE = "https://agritech-4d1ba.web.app";
const OUT = ".claude/audit-results";

const PUBLIC_PAGES = [
  { name: "index", path: "/index.html" },
  { name: "login", path: "/login.html" },
  { name: "signup", path: "/signup.html" },
  { name: "email-login", path: "/email-login.html" },
  { name: "phone-login", path: "/phone-login.html" },
  { name: "llm-chat-smoke", path: "/llm-chat-smoke.html" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

async function auditPage(browser, page, viewport) {
  const consoleMsgs = [];
  const pageErrors = [];
  const failedRequests = [];
  const slowRequests = [];

  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.mobile,
    hasTouch: viewport.mobile,
    userAgent: viewport.mobile
      ? "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
      : undefined,
  });
  const pg = await context.newPage();

  pg.on("console", (m) => {
    const type = m.type();
    if (type === "error" || type === "warning") {
      consoleMsgs.push({ type, text: m.text().slice(0, 600) });
    }
  });
  pg.on("pageerror", (e) => pageErrors.push({ msg: String(e?.message || e), stack: String(e?.stack || "").slice(0, 800) }));
  pg.on("requestfailed", (req) => {
    failedRequests.push({
      url: req.url(),
      method: req.method(),
      failure: req.failure()?.errorText || "",
      resourceType: req.resourceType(),
    });
  });
  pg.on("response", async (resp) => {
    const status = resp.status();
    if (status >= 400) {
      failedRequests.push({
        url: resp.url(),
        method: resp.request().method(),
        status,
        resourceType: resp.request().resourceType(),
      });
    }
    const timing = resp.request().timing();
    if (timing && timing.responseEnd - timing.startTime > 3000) {
      slowRequests.push({ url: resp.url(), ms: Math.round(timing.responseEnd - timing.startTime) });
    }
  });

  const t0 = Date.now();
  let navError = null;
  try {
    await pg.goto(BASE + page.path, { waitUntil: "networkidle", timeout: 25000 });
  } catch (e) {
    navError = String(e?.message || e).slice(0, 300);
  }
  // Give SPA a moment to settle
  await pg.waitForTimeout(1500);

  const metrics = await pg.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return {
      domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      loadComplete: nav ? Math.round(nav.loadEventEnd) : null,
      docHeight: document.documentElement.scrollHeight,
      bodyOverflowX: getComputedStyle(document.body).overflowX,
      hasViewport: !!document.querySelector('meta[name="viewport"]'),
      title: document.title,
      url: location.href,
    };
  }).catch(() => ({}));

  // Detect horizontal overflow on mobile
  const overflowX = viewport.mobile
    ? await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth).catch(() => 0)
    : 0;

  const shotPath = join(OUT, `${page.name}-${viewport.name}.png`);
  try {
    await pg.screenshot({ path: shotPath, fullPage: false });
  } catch (e) {
    /* ignore */
  }

  await context.close();

  return {
    page: page.name,
    path: page.path,
    viewport: viewport.name,
    elapsedMs: Date.now() - t0,
    navError,
    metrics,
    overflowX,
    console: consoleMsgs,
    pageErrors,
    failedRequests,
    slowRequests,
    screenshot: shotPath,
  };
}

(async () => {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const results = [];
  for (const page of PUBLIC_PAGES) {
    for (const vp of VIEWPORTS) {
      console.log(`> ${page.name} @ ${vp.name}`);
      const r = await auditPage(browser, page, vp);
      results.push(r);
      console.log(
        `  err=${r.pageErrors.length} consoleErr=${r.console.filter((c) => c.type === "error").length} ` +
        `failed=${r.failedRequests.length} overflowX=${r.overflowX} navError=${r.navError ? "Y" : "N"}`,
      );
    }
  }
  await browser.close();
  await writeFile(join(OUT, "report.json"), JSON.stringify(results, null, 2));
  console.log(`\nReport: ${join(OUT, "report.json")}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
