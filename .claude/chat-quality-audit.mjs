/**
 * Conversational quality audit — varied, unpredictable prompts.
 * Account has zero fields/scans, so this stresses the "empty farm" path.
 * Run: node .claude/chat-quality-audit.mjs
 */
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const BASE = "https://agritech-4d1ba.web.app";
const OUT = ".claude/audit-results";

const PROMPTS = [
  // Greetings / micro-social
  "hey",
  "how's your day going?",
  // Casual / off-topic
  "i'm tired",
  "tell me a joke",
  "are you real?",
  // Location-weather (named place — should NOT redirect to default)
  "what's the weather in Mumbai?",
  "is it going to rain in Bhopal tomorrow?",
  "weather in Tokyo",
  // Vague farming
  "what should I plant?",
  "my crops look weird",
  // Gratitude
  "thanks!",
  // Rapid-fire interrupt test
  "actually wait —",
];

(async () => {
  await mkdir(OUT, { recursive: true });
  const creds = JSON.parse(await readFile(join(OUT, "test-creds.json"), "utf8"));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();

  const consoleMsgs = [];
  pg.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 400) });
  });
  pg.on("pageerror", (e) => consoleMsgs.push({ type: "exception", text: String(e?.message || e).slice(0, 400) }));

  // Sign in
  console.log(`> signing in as ${creds.email}`);
  await pg.goto(`${BASE}/email-login.html`, { waitUntil: "domcontentloaded" });
  await pg.fill('input[type="email"]', creds.email);
  await pg.fill('input[type="password"]', creds.password);
  await Promise.all([
    pg.waitForURL((u) => !u.toString().includes("email-login"), { timeout: 20000 }),
    pg.click('button[type="submit"]'),
  ]);
  await pg.goto(`${BASE}/assistant.html`, { waitUntil: "domcontentloaded" });
  await pg.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await pg.waitForTimeout(2500);

  // Optional: clear any prior chat to get a fresh transcript
  try {
    pg.on("dialog", async (d) => { await d.accept(); });
    const clearBtn = await pg.$("#assistant-clear");
    if (clearBtn) {
      await clearBtn.click();
      await pg.waitForTimeout(1800);
    }
  } catch { /* fine */ }

  const turns = [];
  for (let i = 0; i < PROMPTS.length; i++) {
    const prompt = PROMPTS[i];
    console.log(`> [${i + 1}/${PROMPTS.length}] "${prompt}"`);
    const priorCount = await pg.locator(".msg").count();
    await pg.fill("#assistant-input", prompt);
    await pg.click("#assistant-send");
    const sentAt = Date.now();

    // Wait until message count grows by at least 1 (user msg) and we see a non-streaming assistant reply
    let firstReplyMs = null;
    let finalText = null;
    try {
      await pg.waitForFunction(
        (prior) => document.querySelectorAll(".msg.assistant:not(.streaming-reply):not(.typing)").length > prior,
        priorCount,
        { timeout: 25000 },
      ).catch(() => {});
      // grab the latest assistant reply text
      const replies = await pg.locator(".msg.assistant:not(.streaming-reply):not(.typing) .text").allInnerTexts();
      finalText = replies[replies.length - 1] || null;
      firstReplyMs = Date.now() - sentAt;
    } catch {
      finalText = "(no reply within 25s)";
    }

    turns.push({ idx: i + 1, prompt, replyMs: firstReplyMs, reply: finalText });
    await pg.waitForTimeout(1100);
  }

  const shot = join(OUT, "chat-quality.png");
  await pg.screenshot({ path: shot, fullPage: true }).catch(() => {});
  await writeFile(join(OUT, "chat-quality.json"), JSON.stringify({ turns, consoleMsgs }, null, 2));
  console.log(`\nDone. Report: ${join(OUT, "chat-quality.json")}, screenshot: ${shot}`);
  console.log(`Console issues: ${consoleMsgs.length}`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
