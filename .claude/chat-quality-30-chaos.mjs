/**
 * 30-question chaos audit for assistant quality.
 * Run: node .claude/chat-quality-30-chaos.mjs
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const BASE = "https://agritech-4d1ba.web.app";
const OUT = ".claude/audit-results";

const CASES = [
  { id: "casual_joke_1", prompt: "cheer me up with a farm joke in one line" },
  { id: "casual_joke_2", prompt: "i am exhausted, say something light and funny about farming" },
  { id: "weather_city", prompt: "weather in nagpur now?" },
  { id: "weather_forecast", prompt: "will it rain in jaipur tomorrow?" },
  { id: "icar_2s", prompt: "what is ICAR? answer in exactly 2 sentences." },
  { id: "msp_2s", prompt: "what is MSP? exactly 2 professional sentences." },
  { id: "imd_1s", prompt: "define IMD in one sentence only" },
  { id: "rust_3b", prompt: "wheat rust risk high. give exactly 3 priority actions in bullets." },
  { id: "blight_4b", prompt: "tomato blight signs after humidity. give exactly 4 bullets for next 24h." },
  { id: "aphid_2b", prompt: "sudden aphids in chilli. 2 bullets only." },
  { id: "drip_3b", prompt: "summer tomato drip schedule, exactly 3 bullets" },
  { id: "yellow_1l", prompt: "one line only: first check for sudden leaf yellowing" },
  { id: "bot_identity", prompt: "are you a human or bot?" },
  { id: "micro_thanks", prompt: "thanks" },
  { id: "micro_ok", prompt: "okay cool" },
  { id: "mixed_constraints", prompt: "give exactly 2 bullets: first response for unknown leaf spots without scans" },
  { id: "ops_snapshot", prompt: "show my open tasks and unread alerts quickly" },
  { id: "policy_subsidy", prompt: "what is fertilizer subsidy in India? 2 sentences only." },
  { id: "market_mandi", prompt: "what does mandi mean in agri trade? one sentence." },
  { id: "tone_pro", prompt: "professional response: first 3 actions for over-irrigation stress in cotton" },
  { id: "tone_casual", prompt: "im overwhelmed, keep it short and kind" },
  { id: "weather_tokyo", prompt: "weather in tokyo now?" },
  { id: "weather_bhopal", prompt: "current weather bhopal?" },
  { id: "scan_absent", prompt: "i have no scans yet and leaf spots appeared, what first?" },
  { id: "fungal_general", prompt: "high humidity fungal risk checklist in 3 bullets" },
  { id: "irrigation_priority", prompt: "priority list for irrigation correction in heatwave, 3 bullets" },
  { id: "compact_answer", prompt: "answer in one line: best time to irrigate in hot summer" },
  { id: "simple_greeting", prompt: "hey" },
  { id: "followup_plan", prompt: "step-by-step plan for next 24 hours if disease spread is rising" },
  { id: "final_random", prompt: "if i ask messy questions can you still stay precise?" },
];

function countBullets(text) {
  return (String(text || "").match(/^\s*[-*•]/gm) || []).length;
}

function countSentences(text) {
  return (String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).length;
}

function oneLine(text) {
  return !/\n/.test(String(text || "").trim());
}

function hasAny(text, re) {
  return re.test(String(text || ""));
}

function score(c) {
  const t = String(c.reply || "");
  if (/_(\d+)b$/.test(c.id)) {
    const n = Number(c.id.match(/_(\d+)b$/)?.[1] || 0);
    return countBullets(t) === n;
  }
  if (/_(\d+)s$/.test(c.id)) {
    const n = Number(c.id.match(/_(\d+)s$/)?.[1] || 0);
    return countSentences(t) === n;
  }
  switch (c.id) {
    case "weather_city":
      return hasAny(t, /nagpur/i) && hasAny(t, /weather|°c|rh|humidity/i);
    case "weather_forecast":
      return hasAny(t, /jaipur|rain|weather|forecast/i);
    case "yellow_1l":
    case "compact_answer":
      return oneLine(t);
    case "bot_identity":
      return hasAny(t, /ai|bot|assistant/i);
    case "micro_thanks":
    case "micro_ok":
    case "simple_greeting":
      return String(t).trim().split(/\s+/).length <= 16;
    case "ops_snapshot":
      return hasAny(t, /task|alert|snapshot|unread/i);
    case "policy_subsidy":
      return countSentences(t) === 2 && hasAny(t, /subsidy|fertiliz/i);
    case "market_mandi":
      return countSentences(t) === 1 && hasAny(t, /mandi|market/i);
    case "tone_pro":
    case "followup_plan":
      return hasAny(t, /- |\b1\b|\b2\b|\b3\b|priority|plan|action/i);
    case "tone_casual":
      return hasAny(t, /here|rest|you|breathe|no rush|take it easy|support/i);
    case "weather_tokyo":
      return hasAny(t, /tokyo/i) && hasAny(t, /weather|°c|rh|humidity/i);
    case "weather_bhopal":
      return hasAny(t, /bhopal/i) && hasAny(t, /weather|°c|rh|humidity/i);
    case "scan_absent":
      return hasAny(t, /scan|first|spot|action|scout/i);
    case "fungal_general":
    case "irrigation_priority":
      return countBullets(t) === 3;
    default:
      return t.length > 0;
  }
}

(async () => {
  await mkdir(OUT, { recursive: true });
  const creds = JSON.parse(await readFile(join(OUT, "test-creds.json"), "utf8"));

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleMsgs = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 500) });
    }
  });

  await page.goto(`${BASE}/email-login.html`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes("email-login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);

  await page.goto(`${BASE}/assistant.html?qa=chaos30`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  try {
    page.on("dialog", async (d) => d.accept());
    const clearBtn = await page.$("#assistant-clear");
    if (clearBtn) {
      await clearBtn.click();
      await page.waitForTimeout(1200);
    }
  } catch {}

  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    console.log(`> [${i + 1}/${CASES.length}] ${c.id}`);
    await page.waitForFunction(() => {
      const b = document.querySelector("#assistant-send");
      return !!b && !b.disabled;
    }, { timeout: 15000 }).catch(() => {});

    const priorAssistCount = await page.locator(".msg.assistant:not(.streaming-reply):not(.typing)").count();
    const priorUserCount = await page.locator(".msg.user .text").count();
    await page.fill("#assistant-input", c.prompt);
    await page.click("#assistant-send");
    const started = Date.now();

    // Ensure this prompt was actually submitted as a new user bubble.
    await page
      .waitForFunction(
        ({ prior, prompt }) => {
          const users = Array.from(document.querySelectorAll(".msg.user .text"));
          if (users.length <= prior) return false;
          const last = users[users.length - 1]?.textContent || "";
          return last.trim() === String(prompt).trim();
        },
        { prior: priorUserCount, prompt: c.prompt },
        { timeout: 12000 },
      )
      .catch(() => {});

    await page
      .waitForFunction(
        (prior) => document.querySelectorAll(".msg.assistant:not(.streaming-reply):not(.typing)").length > prior,
        priorAssistCount,
        { timeout: 28000 },
      )
      .catch(() => {});

    const assistantTexts = page.locator(".msg.assistant:not(.streaming-reply):not(.typing) .text");
    const newIdx = await assistantTexts.count();
    const reply =
      newIdx > priorAssistCount
        ? ((await assistantTexts.nth(priorAssistCount).innerText().catch(() => "")) || "(no reply)")
        : "(no reply)";
    const latencyMs = Date.now() - started;
    const passed = score({ ...c, reply });
    results.push({ ...c, reply, latencyMs, passed });
    await page.waitForTimeout(600);
  }

  const passed = results.filter((r) => r.passed).length;
  const summary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    avgLatencyMs: Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length),
  };

  const outFile = join(OUT, "chat-quality-30-chaos.json");
  await writeFile(outFile, JSON.stringify({ summary, results, consoleMsgs }, null, 2));
  console.log(`\nSUMMARY: ${summary.passed}/${summary.total} passed, avg latency ${summary.avgLatencyMs}ms`);
  console.log(`Report: ${outFile}`);

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
