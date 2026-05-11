/**
 * 50-question work-focused chat audit (disease, irrigation, ops, policy, weather).
 * Isolated navigation per prompt. Stricter scoring + pass gate for CI-style runs.
 *
 * Setup: create `.claude/audit-results/test-creds.json` as { "email", "password" }
 *    or set AGRI_TEST_EMAIL / AGRI_TEST_PASSWORD.
 *
 * Run: node .claude/chat-quality-50-work.mjs
 * Env: AGRI_BASE_URL (default https://agritech-4d1ba.web.app)
 *      WORK50_MIN_PASS (default 44) — exit 1 if fewer pass
 */
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";

const BASE = process.env.AGRI_BASE_URL || "https://agritech-4d1ba.web.app";
const OUT = ".claude/audit-results";
const GATE_MIN_PASS = Math.min(50, Math.max(1, Number(process.env.WORK50_MIN_PASS || 44)));

/** @type {{ id: string, category: string, prompt: string, score: (reply: string) => boolean }[]} */
const CASES = [
  // --- Disease (10) ---
  {
    id: "dis_tomato_blight_4b",
    category: "disease",
    prompt:
      "Tomato early blight after humid nights. Give exactly 4 priority bullets for the next 24 hours.",
    score: (r) => countBullets(r) === 4 && kw(r, [/blight|tomato|fung|scout|canopy|irrigat|label/i], 2),
  },
  {
    id: "dis_wheat_rust_3b",
    category: "disease",
    prompt: "High wheat rust pressure. Exactly 3 action bullets only.",
    score: (r) => countBullets(r) === 3 && kw(r, [/rust|wheat|fung|canopy|leaf/i], 2),
  },
  {
    id: "dis_aphid_chilli_2b",
    category: "disease",
    prompt: "Sudden aphids on chilli. Exactly 2 bullets, no extra text.",
    score: (r) => countBullets(r) === 2 && kw(r, [/aphid|chilli|chili|spray|water|label/i], 2),
  },
  {
    id: "dis_bacterial_spot_3b",
    category: "disease",
    prompt: "Bacterial leaf spot on capsicum. Exactly 3 bullets for immediate response.",
    score: (r) => countBullets(r) === 3 && kw(r, [/bacterial|splash|copper|sanit|overhead/i], 2),
  },
  {
    id: "dis_powdery_grape_3b",
    category: "disease",
    prompt: "Powdery mildew risk on grapes. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/mildew|grape|canopy|air|spray|scout/i], 2),
  },
  {
    id: "dis_rice_blast_2s",
    category: "disease",
    prompt: "Explain rice blast management briefly in exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/rice|blast|fung|humid|variet/i], 2),
  },
  {
    id: "dis_wilt_1l",
    category: "disease",
    prompt: "Say only one line: first check if plants are wilting suddenly.",
    score: (r) => oneLine(r) && words(r) <= 40 && kw(r, [/root|water|drain|moist|stress/i], 1),
  },
  {
    id: "dis_no_scan_spots_2b",
    category: "disease",
    prompt: "I have no scan data and new leaf spots. Exactly 2 bullets for what to do first.",
    score: (r) => countBullets(r) === 2 && kw(r, [/scout|photo|moist|air|spray|id/i], 2),
  },
  {
    id: "dis_humid_fungal_4b",
    category: "disease",
    prompt: "High humidity fungal risk. Give exactly 4 checklist bullets.",
    score: (r) => countBullets(r) === 4 && kw(r, [/humid|fung|wet|air|irrigat|scout/i], 2),
  },
  {
    id: "dis_ipm_2s",
    category: "disease",
    prompt: "What is integrated pest management? Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/integrated|pest|scout|economic|pesticid/i], 2),
  },
  // --- Irrigation (10) ---
  {
    id: "irr_drip_maize_3b",
    category: "irrigation",
    prompt: "Summer maize on drip. Exactly 3 bullets for scheduling discipline.",
    score: (r) => countBullets(r) === 3 && kw(r, [/drip|maize|corn|moist|emit|depth/i], 2),
  },
  {
    id: "irr_cotton_over_3b",
    category: "irrigation",
    prompt: "Cotton showing over-irrigation stress. Professional tone. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/cotton|drain|root|moist|oxygen|wilting/i], 2),
  },
  {
    id: "irr_paddy_stress_2s",
    category: "irrigation",
    prompt: "Water stress signals in paddy. Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/paddy|rice|water|depth|drain|root/i], 2),
  },
  {
    id: "irr_heatwave_fix_3b",
    category: "irrigation",
    prompt: "Heatwave irrigation correction. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/heat|irrigat|dawn|moist|et|stress/i], 2),
  },
  {
    id: "irr_timing_1l",
    category: "irrigation",
    prompt: "One line only: best irrigation timing in hot summer.",
    score: (r) => oneLine(r) && words(r) <= 35 && kw(r, /morning|evening|night|humid|summer|hot/i),
  },
  {
    id: "irr_sensor_feel_2b",
    category: "irrigation",
    prompt: "Moisture sensor versus hand-feel. Exactly 2 bullets.",
    score: (r) => countBullets(r) === 2 && kw(r, [/sensor|feel|depth|probe|soil/i], 2),
  },
  {
    id: "irr_deficit_wheat_2s",
    category: "irrigation",
    prompt: "Deficit irrigation concept for wheat in exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/deficit|wheat|water|stage|moist|yield/i], 2),
  },
  {
    id: "irr_mulch_3b",
    category: "irrigation",
    prompt: "Mulching for water conservation. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/mulch|moist|stem|weed|soil/i], 2),
  },
  {
    id: "irr_salinity_2s",
    category: "irrigation",
    prompt: "Irrigation-related salinity risk in exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/salin|water|drain|soil|quality|root/i], 2),
  },
  {
    id: "irr_rain_schedule_3b",
    category: "irrigation",
    prompt: "Adjust irrigation schedule using a rain forecast. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/rain|forecast|irrigat|runoff|soil|cycle/i], 2),
  },
  // --- Operations (8) ---
  {
    id: "ops_scout_3b",
    category: "operations",
    prompt: "Weekly field scouting routine. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/scout|pattern|photo|pest|edge|record/i], 2),
  },
  {
    id: "ops_harvest_records_2s",
    category: "operations",
    prompt: "Harvest record-keeping basics in exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/harvest|record|trace|quantity|grade|storage/i], 2),
  },
  {
    id: "ops_labor_peak_3b",
    category: "operations",
    prompt: "Peak-season labor coordination. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/labor|roster|harvest|safety|hydrat|transport/i], 2),
  },
  {
    id: "ops_spray_cal_2b",
    category: "operations",
    prompt: "Sprayer calibration discipline. Exactly 2 bullets.",
    score: (r) => countBullets(r) === 2 && kw(r, [/calibrat|flow|nozzle|pressure|swath|label/i], 2),
  },
  {
    id: "ops_grain_moisture_2s",
    category: "operations",
    prompt: "Safe grain storage moisture thinking in exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/grain|moist|storage|aerat|mold|monitor/i], 2),
  },
  {
    id: "ops_residue_3b",
    category: "operations",
    prompt: "Residue: burning versus incorporation. Exactly 3 bullets, environmental angle.",
    score: (r) => countBullets(r) === 3 && kw(r, [/residue|burn|incorporat|organic|soil|carbon/i], 2),
  },
  {
    id: "ops_cold_chain_2s",
    category: "operations",
    prompt: "Cold chain for vegetables in exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/cold|veget|cool|temperat|harvest|decay/i], 2),
  },
  {
    id: "ops_tasks_snapshot",
    category: "operations",
    prompt: "Show my open tasks and unread alerts in a quick snapshot.",
    score: (r) => kw(r, [/task|alert|unread|open|dashboard|snapshot|queue|list/i], 2),
  },
  // --- Policy / market (8) ---
  {
    id: "pol_msp_wheat_2s",
    category: "policy",
    prompt: "What is MSP for wheat context in India? Exactly 2 professional sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/msp|minimum|support|price|government|farmer/i], 2),
  },
  {
    id: "pol_pm_kisan_1s",
    category: "policy",
    prompt: "PM-KISAN in one sentence only.",
    score: (r) => countSentences(r) === 1 && kw(r, [/pm[\s-]?kisan|farmer|income|installment|government/i], 2),
  },
  {
    id: "pol_mandi_reg_2s",
    category: "policy",
    prompt: "Mandi regulation in India. Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/mandi|apmc|trade|state|auction|fee/i], 2),
  },
  {
    id: "pol_enam_2b",
    category: "policy",
    prompt: "What is e-NAM? Answer in exactly 2 bullets.",
    score: (r) => countBullets(r) === 2 && kw(r, [/e[\s-]?nam|electronic|mandi|trading|price/i], 2),
  },
  {
    id: "pol_pmfby_2s",
    category: "policy",
    prompt: "What is PMFBY? Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/pmfby|insurance|crop|yield|weather|peril/i], 2),
  },
  {
    id: "pol_icar_role_2s",
    category: "policy",
    prompt: "What is ICAR's role? Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/icar|research|extension|network|farmer|technolog/i], 2),
  },
  {
    id: "pol_fert_sub_2s",
    category: "policy",
    prompt: "Fertilizer subsidy in India. Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/fertil|subsidy|nutrient|government|farmer|cost/i], 2),
  },
  {
    id: "pol_organic_2s",
    category: "policy",
    prompt: "Organic certification basics in India. Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/organic|certif|inspect|standard|record|farm/i], 2),
  },
  // --- Weather (10) ---
  {
    id: "wx_nagpur",
    category: "weather",
    prompt: "Weather in Nagpur now?",
    score: (r) => kw(r, [/nagpur/i], 1) && kw(r, [/weather|tab|location|°c|rain|humid|forecast/i], 1),
  },
  {
    id: "wx_delhi_rain",
    category: "weather",
    prompt: "Will it rain in Delhi tomorrow?",
    score: (r) => kw(r, [/delhi/i], 1) && kw(r, [/rain|weather|forecast|tab|location/i], 1),
  },
  {
    id: "wx_heatwave_3b",
    category: "weather",
    prompt: "Heatwave crop mitigation. Exactly 3 bullets.",
    score: (r) => countBullets(r) === 3 && kw(r, [/heat|irrigat|scout|sun|stress|morning/i], 2),
  },
  {
    id: "wx_frost_2s",
    category: "weather",
    prompt: "Frost risk for sensitive crops. Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/frost|cold|forecast|canopy|damage|night/i], 2),
  },
  {
    id: "wx_tokyo",
    category: "weather",
    prompt: "Current weather in Tokyo?",
    score: (r) => kw(r, [/tokyo/i], 1) && kw(r, [/weather|tab|location|°c|rain|humid/i], 1),
  },
  {
    id: "wx_imd_1s",
    category: "weather",
    prompt: "Define IMD in one sentence.",
    score: (r) => countSentences(r) === 1 && kw(r, [/imd|meteorological|india|weather/i], 2),
  },
  {
    id: "wx_rh_disease_2s",
    category: "weather",
    prompt: "How relative humidity links to plant disease. Exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/humid|wet|leaf|disease|fung|bacter/i], 2),
  },
  {
    id: "wx_spray_drift_2b",
    category: "weather",
    prompt: "Wind drift when spraying. Exactly 2 bullets.",
    score: (r) => countBullets(r) === 2 && kw(r, [/wind|drift|spray|buffer|nozzle|label/i], 2),
  },
  {
    id: "wx_drought_2s",
    category: "weather",
    prompt: "Agricultural drought awareness in exactly 2 sentences.",
    score: (r) => countSentences(r) === 2 && kw(r, [/drought|moist|rain|crop|yield|risk/i], 2),
  },
  {
    id: "wx_bhopal",
    category: "weather",
    prompt: "Bhopal current weather?",
    score: (r) => kw(r, [/bhopal/i], 1) && kw(r, [/weather|tab|location|°c|humid/i], 1),
  },
  // --- Mixed (4) ---
  {
    id: "mix_emergency_5b",
    category: "mixed",
    prompt: "Unknown disease outbreak with no diagnosis yet. Exactly 5 emergency bullets.",
    score: (r) => countBullets(r) === 5 && kw(r, [/photo|boundary|sample|extension|lab|record/i], 3),
  },
  {
    id: "mix_soil_paragraph",
    category: "mixed",
    prompt: "One professional paragraph only: why soil testing matters before big fertilizer spends.",
    score: (r) =>
      !/^\s*[-*•]/m.test(r) &&
      (r.match(/\n/g) || []).length <= 2 &&
      words(r) >= 40 &&
      kw(r, [/soil|test|nutrient|lab|ph|fertil/i], 3),
  },
  {
    id: "mix_ai_identity",
    category: "mixed",
    prompt: "Are you an AI assistant?",
    score: (r) => kw(r, [/ai|assistant|farm|field|weather/i], 2),
  },
  {
    id: "mix_thanks",
    category: "mixed",
    prompt: "Thanks, that helped.",
    score: (r) => words(r) <= 28,
  },
];

function countBullets(text) {
  return (String(text || "").match(/^\s*[-*•]/gm) || []).length;
}

function countSentences(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return 0;
  const parts = s.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [s];
  return parts.filter((p) => p.trim().length > 0).length;
}

function oneLine(text) {
  return !/\n/.test(String(text || "").trim());
}

function words(text) {
  return String(text || "").trim().split(/\s+/).filter(Boolean).length;
}

/** @param {string} reply @param {RegExp | RegExp[]} pats @param {number} need */
function kw(reply, pats, need = 1) {
  const arr = Array.isArray(pats) ? pats : [pats];
  const hit = arr.filter((re) => re.test(reply)).length;
  return hit >= need;
}

function summarizeByCategory(results) {
  /** @type {Record<string, { pass: number, total: number }>} */
  const o = {};
  for (const r of results) {
    if (!o[r.category]) o[r.category] = { pass: 0, total: 0 };
    o[r.category].total += 1;
    if (r.passed) o[r.category].pass += 1;
  }
  return o;
}

(async () => {
  await mkdir(OUT, { recursive: true });

  let creds;
  try {
    creds = JSON.parse(await readFile(join(OUT, "test-creds.json"), "utf8"));
  } catch {
    creds = { email: process.env.AGRI_TEST_EMAIL, password: process.env.AGRI_TEST_PASSWORD };
  }
  if (!creds?.email || !creds?.password) {
    console.error("Missing credentials: add .claude/audit-results/test-creds.json or AGRI_TEST_EMAIL/PASSWORD");
    process.exit(1);
  }

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const consoleMsgs = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      consoleMsgs.push({ type: m.type(), text: m.text().slice(0, 500) });
    }
  });

  await page.goto(`${BASE}/email-login.html`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.fill('input[type="email"]', creds.email);
  await page.fill('input[type="password"]', creds.password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes("email-login"), { timeout: 25000 }),
    page.click('button[type="submit"]'),
  ]);

  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    console.log(`> [${i + 1}/${CASES.length}] ${c.category}/${c.id}`);
    await page.goto(`${BASE}/assistant.html?qa=work50-${c.id}-${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await page.waitForTimeout(1000);

    await page
      .waitForFunction(() => {
        const b = document.querySelector("#assistant-send");
        return !!b && !b.disabled;
      }, { timeout: 12000 })
      .catch(() => {});

    await page.fill("#assistant-input", c.prompt);
    const priorAssist = await page.locator(".msg.assistant:not(.streaming-reply):not(.typing)").count();
    const started = Date.now();
    await page.click("#assistant-send");

    await page
      .waitForFunction(
        (prior) => document.querySelectorAll(".msg.assistant:not(.streaming-reply):not(.typing)").length > prior,
        priorAssist,
        { timeout: 32000 },
      )
      .catch(() => {});

    const texts = page.locator(".msg.assistant:not(.streaming-reply):not(.typing) .text");
    const n = await texts.count();
    const reply =
      n > priorAssist ? ((await texts.nth(priorAssist).innerText().catch(() => "")) || "(no reply)") : "(no reply)";
    const latencyMs = Date.now() - started;
    const passed = c.score(reply);
    results.push({
      id: c.id,
      category: c.category,
      prompt: c.prompt,
      reply,
      latencyMs,
      passed,
    });
    await page.waitForTimeout(600);
  }

  const passedN = results.filter((r) => r.passed).length;
  const summary = {
    total: results.length,
    passed: passedN,
    failed: results.length - passedN,
    gateMinPass: GATE_MIN_PASS,
    gateOk: passedN >= GATE_MIN_PASS,
    passRate: Math.round((1000 * passedN) / results.length) / 1000,
    avgLatencyMs: Math.round(results.reduce((a, b) => a + b.latencyMs, 0) / results.length),
    byCategory: summarizeByCategory(results),
  };

  const outFile = join(OUT, "chat-quality-50-work.json");
  await writeFile(outFile, JSON.stringify({ summary, results, consoleMsgs }, null, 2));

  console.log(`\nSUMMARY: ${summary.passed}/${summary.total} passed (${summary.passRate * 100}%)`);
  console.log(`By category: ${JSON.stringify(summary.byCategory)}`);
  console.log(`Gate: need >= ${GATE_MIN_PASS}, gateOk=${summary.gateOk}`);
  console.log(`Report: ${outFile}`);

  await browser.close();

  if (!summary.gateOk) {
    console.error(`\nFAIL: work-50 gate (${passedN} < ${GATE_MIN_PASS})`);
    const failed = results.filter((r) => !r.passed).map((r) => r.id);
    console.error("Failed ids:", failed.join(", "));
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
