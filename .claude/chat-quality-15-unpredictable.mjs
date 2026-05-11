/**
 * 15-question unpredictable chat quality audit.
 * Run: node .claude/chat-quality-15-unpredictable.mjs
 */
import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const BASE = "https://agritech-4d1ba.web.app";
const OUT = ".claude/audit-results";

const CASES = [
  { id: "casual_joke", prompt: "i had a rough day, cheer me up with a short farming joke" },
  { id: "weather_pune", prompt: "weather in pune now?" },
  { id: "icar_2_sentences", prompt: "What is ICAR? Answer in exactly 2 sentences, professional tone." },
  { id: "msp_2_sentences", prompt: "What is MSP in India? Answer in exactly 2 sentences, professional tone." },
  { id: "blight_4_bullets", prompt: "My tomato leaves have early blight symptoms. Give exactly 4 priority actions for next 24 hours, bullets only." },
  { id: "drip_3_bullets", prompt: "Best drip irrigation schedule for summer tomato. Answer in exactly 3 bullets only." },
  { id: "one_line_yellowing", prompt: "say only one line: best first step if leaves are yellowing suddenly" },
  { id: "aphid_2_steps", prompt: "Give 2 steps only for sudden aphid outbreak in chilli." },
  { id: "micro_thanks", prompt: "thanks!" },
  { id: "weather_tokyo", prompt: "what's weather in tokyo tomorrow?" },
  { id: "empathy", prompt: "i am stressed and confused about crop decisions" },
  { id: "wheat_rust_priority", prompt: "next 24 hours priority list for wheat rust risk" },
  { id: "imd_one_sentence", prompt: "define IMD in one sentence" },
  { id: "are_you_bot", prompt: "are you a bot?" },
  { id: "no_scan_spots", prompt: "what should i do first if i have no scan data and sudden leaf spots?" },
];

function countBullets(text) {
  return (String(text || "").match(/^\s*[-*•]/gm) || []).length;
}

function countSentences(text) {
  return (String(text || "").replace(/\s+/g, " ").match(/[^.!?]+[.!?]+|[^.!?]+$/g) || []).length;
}

function shortWords(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

function scoreCase(c) {
  const t = String(c.reply || "");
  switch (c.id) {
    case "casual_joke":
      return /joke|scarecrow|tomato|forecast crops|laugh/i.test(t);
    case "weather_pune":
      return /pune/i.test(t) && /weather|°c|humidity|rh/i.test(t);
    case "icar_2_sentences":
      return /Indian Council of Agricultural Research|ICAR/i.test(t) && countSentences(t) === 2;
    case "msp_2_sentences":
      return /Minimum Support Price|MSP/i.test(t) && countSentences(t) === 2;
    case "blight_4_bullets":
      return countBullets(t) === 4;
    case "drip_3_bullets":
      return countBullets(t) === 3;
    case "one_line_yellowing":
      return !/\n/.test(t.trim()) && shortWords(t) <= 30;
    case "aphid_2_steps":
      return countBullets(t) === 2 || /1\)|2\)/.test(t);
    case "micro_thanks":
      return shortWords(t) <= 12;
    case "weather_tokyo":
      return /tokyo/i.test(t) && /weather|°c|humidity|rh|rain/i.test(t);
    case "empathy":
      return /here|take|rest|understand|stress|no rush/i.test(t);
    case "wheat_rust_priority":
      return /rust|wheat/i.test(t) && (countBullets(t) >= 3 || /priority/i.test(t));
    case "imd_one_sentence":
      return /IMD|Meteorological Department|Meteorological/i.test(t) && countSentences(t) === 1;
    case "are_you_bot":
      return /ai|bot|assistant/i.test(t);
    case "no_scan_spots":
      return /first|scout|scan|leaf|spot|action/i.test(t);
    default:
      return false;
  }
}

(async () => {
  await mkdir(OUT, { recursive: true });
  const creds = JSON.parse(await readFile(join(OUT, "test-creds.json"), "utf8"));

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = await ctx.newPage();

  const consoleMsgs = [];
  pg.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 500) });
    }
  });
  pg.on("pageerror", (e) => consoleMsgs.push({ type: "exception", text: String(e?.message || e).slice(0, 500) }));

  await pg.goto(`${BASE}/email-login.html`, { waitUntil: "domcontentloaded" });
  await pg.fill('input[type="email"]', creds.email);
  await pg.fill('input[type="password"]', creds.password);
  await Promise.all([
    pg.waitForURL((u) => !u.toString().includes("email-login"), { timeout: 20000 }),
    pg.click('button[type="submit"]'),
  ]);

  await pg.goto(`${BASE}/assistant.html?qa=15unpredictable`, { waitUntil: "domcontentloaded" });
  await pg.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await pg.waitForTimeout(2000);

  try {
    pg.on("dialog", async (d) => d.accept());
    const clearBtn = await pg.$("#assistant-clear");
    if (clearBtn) {
      await clearBtn.click();
      await pg.waitForTimeout(1500);
    }
  } catch {}

  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    console.log(`> [${i + 1}/15] ${c.id}`);
    const priorCount = await pg.locator(".msg").count();
    await pg.fill("#assistant-input", c.prompt);
    await pg.click("#assistant-send");
    const started = Date.now();

    await pg.waitForFunction(
      (prior) => document.querySelectorAll(".msg.assistant:not(.streaming-reply):not(.typing)").length > prior,
      priorCount,
      { timeout: 28000 },
    ).catch(() => {});

    const replies = await pg.locator(".msg.assistant:not(.streaming-reply):not(.typing) .text").allInnerTexts();
    const reply = replies[replies.length - 1] || "(no reply)";
    const latencyMs = Date.now() - started;
    const passed = scoreCase({ ...c, reply });
    results.push({ ...c, reply, latencyMs, passed });
    await pg.waitForTimeout(900);
  }

  const passed = results.filter((r) => r.passed).length;
  const summary = {
    total: results.length,
    passed,
    failed: results.length - passed,
    avgLatencyMs: Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length),
  };

  await writeFile(
    join(OUT, "chat-quality-15-unpredictable.json"),
    JSON.stringify({ summary, results, consoleMsgs }, null, 2),
  );

  console.log(`\nSUMMARY: ${summary.passed}/${summary.total} passed, avg latency ${summary.avgLatencyMs}ms`);
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
