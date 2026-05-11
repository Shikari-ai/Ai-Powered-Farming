/**
 * 30-question isolated audit (fresh assistant state per prompt).
 * Run: node .claude/chat-quality-30-isolated.mjs
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
function isOneLine(text) {
  return !/\n/.test(String(text || "").trim());
}
function has(text, re) {
  return re.test(String(text || ""));
}

function score(id, reply) {
  if (/_([0-9]+)b$/.test(id)) return countBullets(reply) === Number(id.match(/_([0-9]+)b$/)?.[1] || 0);
  if (/_([0-9]+)s$/.test(id)) return countSentences(reply) === Number(id.match(/_([0-9]+)s$/)?.[1] || 0);
  switch (id) {
    case "weather_city": return has(reply, /nagpur/i) && has(reply, /weather|°c|rh|humidity/i);
    case "weather_forecast": return has(reply, /jaipur|rain|forecast|weather/i);
    case "yellow_1l":
    case "compact_answer": return isOneLine(reply);
    case "bot_identity": return has(reply, /ai|bot|assistant/i);
    case "micro_thanks":
    case "micro_ok":
    case "simple_greeting": return String(reply).trim().split(/\s+/).length <= 16;
    case "ops_snapshot": return has(reply, /task|alert|unread|snapshot/i);
    case "policy_subsidy": return countSentences(reply) === 2 && has(reply, /subsidy|fertiliz/i);
    case "market_mandi": return countSentences(reply) === 1 && has(reply, /mandi|market/i);
    case "tone_pro":
    case "followup_plan": return has(reply, /- |\bplan\b|priority|action/i);
    case "tone_casual": return has(reply, /here|rest|no rush|take it easy|support/i);
    case "weather_tokyo": return has(reply, /tokyo/i) && has(reply, /weather|°c|rh|humidity/i);
    case "weather_bhopal": return has(reply, /bhopal/i) && has(reply, /weather|°c|rh|humidity/i);
    case "scan_absent": return has(reply, /scan|spot|first|scout|action/i);
    default: return String(reply || "").trim().length > 0;
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
    if (m.type() === "error" || m.type() === "warning") consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 500) });
  });

  await page.goto(`${BASE}/email-login.html`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes("email-login"), { timeout: 20000 }),
    page.click('button[type="submit"]'),
  ]);

  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    console.log(`> [${i + 1}/${CASES.length}] ${c.id}`);
    await page.goto(`${BASE}/assistant.html?qa=iso30-${c.id}-${Date.now()}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);

    await page.waitForFunction(() => {
      const b = document.querySelector("#assistant-send");
      return !!b && !b.disabled;
    }, { timeout: 10000 }).catch(() => {});

    await page.fill("#assistant-input", c.prompt);
    const priorAssist = await page.locator(".msg.assistant:not(.streaming-reply):not(.typing)").count();
    const started = Date.now();
    await page.click("#assistant-send");

    await page.waitForFunction(
      (prior) => document.querySelectorAll(".msg.assistant:not(.streaming-reply):not(.typing)").length > prior,
      priorAssist,
      { timeout: 28000 },
    ).catch(() => {});

    const texts = page.locator(".msg.assistant:not(.streaming-reply):not(.typing) .text");
    const n = await texts.count();
    const reply = n > priorAssist ? ((await texts.nth(priorAssist).innerText().catch(() => "")) || "(no reply)") : "(no reply)";
    const latencyMs = Date.now() - started;
    results.push({ ...c, reply, latencyMs, passed: score(c.id, reply) });
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    avgLatencyMs: Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length),
  };

  const outFile = join(OUT, "chat-quality-30-isolated.json");
  await writeFile(outFile, JSON.stringify({ summary, results, consoleMsgs }, null, 2));
  console.log(`\nSUMMARY: ${summary.passed}/${summary.total} passed, avg latency ${summary.avgLatencyMs}ms`);
  console.log(`Report: ${outFile}`);

  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
