/**
 * Sign up a throwaway test user on agritech-4d1ba.web.app, then save credentials.
 * Run: node .claude/signup-test-user.mjs
 */
import { chromium } from "playwright";
import { writeFile, mkdir } from "fs/promises";

const BASE = "https://agritech-4d1ba.web.app";
const stamp = Date.now().toString(36);
const email = `qa.bot.${stamp}@agritech-qa.test`;
const password = `QaBot-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
const name = `QA Bot ${stamp}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400));
});
page.on("pageerror", (e) => consoleErrors.push(`PAGE: ${e.message}`));

console.log(`> signing up ${email}`);
await page.goto(`${BASE}/signup.html`, { waitUntil: "domcontentloaded", timeout: 25000 });
await page.fill("#su-name", name);
await page.fill("#su-email", email);
await page.fill("#su-password", password);

const before = page.url();
await page.click('button[type="submit"]');

// Wait for either: redirect away from signup.html, or an inline error alert.
let outcome = "unknown";
try {
  await Promise.race([
    page.waitForURL((u) => !u.toString().includes("signup.html"), { timeout: 15000 }).then(() => (outcome = "redirected")),
    page.waitForEvent("dialog", { timeout: 15000 }).then(async (d) => {
      outcome = `dialog:${d.message().slice(0, 200)}`;
      await d.dismiss();
    }),
  ]);
} catch (e) {
  outcome = `timeout:${String(e?.message || e).slice(0, 200)}`;
}

const finalUrl = page.url();
console.log(`> outcome=${outcome} finalUrl=${finalUrl}`);

if (consoleErrors.length) {
  console.log("> console errors during signup:");
  for (const c of consoleErrors.slice(0, 10)) console.log("  -", c);
}

await mkdir(".claude/audit-results", { recursive: true });
await page.screenshot({ path: ".claude/audit-results/post-signup.png", fullPage: false });

// Persist credentials for later test scripts.
const creds = { email, password, name, createdAt: new Date().toISOString(), outcome, finalUrl };
await writeFile(".claude/audit-results/test-creds.json", JSON.stringify(creds, null, 2));
console.log(`> saved creds to .claude/audit-results/test-creds.json`);

await browser.close();
