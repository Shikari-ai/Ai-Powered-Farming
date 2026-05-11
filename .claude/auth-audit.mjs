/**
 * Authenticated audit:
 *  1. Sign in once with saved creds (storageState reused across pages)
 *  2. Visit every protected page, capture console + network errors, screenshot
 *  3. Exercise the assistant chat: type, send, observe stream, rapid second send
 *  4. Write JSON report
 *
 * Run: node .claude/auth-audit.mjs
 */
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const BASE = "https://agritech-4d1ba.web.app";
const OUT = ".claude/audit-results";

const PAGES = [
  { name: "home", path: "/index.html" },
  { name: "assistant", path: "/assistant.html" },
  { name: "weather", path: "/weather.html" },
  { name: "fields", path: "/fields.html" },
  { name: "map", path: "/map.html" },
  { name: "regional", path: "/regional.html" },
  { name: "profile", path: "/profile.html" },
  { name: "scanner", path: "/scanner.html" },
  { name: "copilot", path: "/copilot.html" },
];

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

async function signIn(page, creds) {
  await page.goto(`${BASE}/email-login.html`, { waitUntil: "domcontentloaded" });
  // Try common field IDs first; fallback to type=email/password.
  const emailSel = (await page.$("#li-email")) ? "#li-email" : 'input[type="email"]';
  const passSel = (await page.$("#li-password")) ? "#li-password" : 'input[type="password"]';
  await page.fill(emailSel, creds.email);
  await page.fill(passSel, creds.password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes("email-login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function auditPage(ctx, page, viewport) {
  const consoleMsgs = [];
  const pageErrors = [];
  const failedRequests = [];

  const pg = await ctx.newPage();
  await pg.setViewportSize({ width: viewport.width, height: viewport.height });
  pg.on("console", (m) => {
    const t = m.type();
    if (t === "error" || t === "warning") consoleMsgs.push({ type: t, text: m.text().slice(0, 600) });
  });
  pg.on("pageerror", (e) => pageErrors.push({ msg: String(e?.message || e).slice(0, 400), stack: String(e?.stack || "").slice(0, 600) }));
  pg.on("requestfailed", (req) => {
    const f = req.failure()?.errorText || "";
    // Filter benign aborts from page-unload navigations
    if (f === "net::ERR_ABORTED") return;
    failedRequests.push({ url: req.url(), method: req.method(), failure: f, type: req.resourceType() });
  });
  pg.on("response", (resp) => {
    const s = resp.status();
    if (s >= 400 && s !== 401) failedRequests.push({ url: resp.url(), method: resp.request().method(), status: s, type: resp.request().resourceType() });
  });

  let navError = null;
  try {
    await pg.goto(BASE + page.path, { waitUntil: "domcontentloaded", timeout: 25000 });
    // Let realtime listeners settle; many pages do work post-DOMContentLoaded.
    await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  } catch (e) {
    navError = String(e?.message || e).slice(0, 300);
  }
  await pg.waitForTimeout(1500);

  const meta = await pg.evaluate(() => {
    const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return {
      url: location.href,
      title: document.title,
      overflowX: overflow,
      hasViewport: !!document.querySelector('meta[name="viewport"]'),
    };
  }).catch(() => ({}));

  const shot = join(OUT, `auth-${page.name}-${viewport.name}.png`);
  await pg.screenshot({ path: shot, fullPage: false }).catch(() => {});
  await pg.close();

  return { page: page.name, path: page.path, viewport: viewport.name, navError, meta, consoleMsgs, pageErrors, failedRequests };
}

async function exerciseChat(ctx) {
  const pg = await ctx.newPage();
  await pg.setViewportSize({ width: 1280, height: 900 });
  const consoleMsgs = [];
  const pageErrors = [];
  pg.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 600) });
  });
  pg.on("pageerror", (e) => pageErrors.push(String(e?.message || e).slice(0, 400)));

  await pg.goto(`${BASE}/assistant.html`, { waitUntil: "domcontentloaded" });
  await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await pg.waitForTimeout(2000);

  const inputSel = "#assistant-input";
  const sendSel = "#assistant-send";
  const events = [];

  // Turn 1: greeting
  await pg.fill(inputSel, "Hi there");
  await pg.click(sendSel);
  events.push("sent_turn1");
  // Wait for any assistant message or stream shell
  const t0 = Date.now();
  try {
    await pg.waitForSelector(".msg.assistant", { timeout: 20000 });
    events.push(`turn1_assistant_visible_in_${Date.now() - t0}ms`);
  } catch {
    events.push("turn1_assistant_never_appeared");
  }
  await pg.waitForTimeout(1500);

  // Turn 2: rapid double-send (tests H1 fix)
  await pg.fill(inputSel, "What's the weather?");
  await pg.click(sendSel);
  events.push("sent_turn2");
  await pg.waitForTimeout(400);
  await pg.fill(inputSel, "Actually never mind, tell me about my fields");
  await pg.click(sendSel);
  events.push("sent_turn3_rapid");

  await pg.waitForTimeout(8000);
  const finalMsgCount = await pg.locator(".msg").count();
  events.push(`final_msg_count=${finalMsgCount}`);
  const finalShot = join(OUT, "chat-exercise.png");
  await pg.screenshot({ path: finalShot, fullPage: true }).catch(() => {});

  // Extract visible chat text
  const chatTexts = await pg.locator(".msg .text").allInnerTexts().catch(() => []);
  await pg.close();
  return { events, finalMsgCount, chatTexts, consoleMsgs, pageErrors, screenshot: finalShot };
}

(async () => {
  await mkdir(OUT, { recursive: true });
  const creds = JSON.parse(await readFile(join(OUT, "test-creds.json"), "utf8"));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const setupPg = await ctx.newPage();
  console.log(`> signing in as ${creds.email}`);
  await signIn(setupPg, creds);
  console.log(`> signed in, url=${setupPg.url()}`);
  await setupPg.close();

  const results = [];
  for (const p of PAGES) {
    for (const vp of VIEWPORTS) {
      console.log(`> ${p.name} @ ${vp.name}`);
      const r = await auditPage(ctx, p, vp);
      const cErr = r.consoleMsgs.filter((c) => c.type === "error").length;
      console.log(`  pageErr=${r.pageErrors.length} cErr=${cErr} netErr=${r.failedRequests.length} overflowX=${r.meta.overflowX || 0}`);
      results.push(r);
    }
  }

  console.log(`> exercising assistant chat`);
  const chatResult = await exerciseChat(ctx);
  console.log(`  events: ${chatResult.events.join(" | ")}`);

  await browser.close();
  await writeFile(join(OUT, "auth-report.json"), JSON.stringify({ pages: results, chat: chatResult }, null, 2));
  console.log(`\nReport: ${join(OUT, "auth-report.json")}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
