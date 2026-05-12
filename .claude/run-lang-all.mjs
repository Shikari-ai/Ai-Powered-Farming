/**
 * Run language tests in sequence with inherited stdio (avoids npm output buffering on Windows).
 */
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const node = process.execPath;
const allSteps = [
  ["lang-core-smoke.mjs", "locale packs + basic t()"],
  ["lang-pages-audit.mjs", "per-HTML data-i18n keys vs all locales"],
  ["lang-pages-playwright.mjs", "browser DOM harness (needs: npx playwright install chromium)"],
];

const skipPw = /^1|true$/i.test(process.env.AGRI_SKIP_PLAYWRIGHT || "");
const scripts = skipPw ? allSteps.filter(([name]) => !name.includes("playwright")) : allSteps;

if (skipPw) {
  console.error("[run-lang-all] AGRI_SKIP_PLAYWRIGHT=1 — skipping Playwright harness");
}

for (const [name, label] of scripts) {
  const script = join(here, name);
  console.error(`[run-lang-all] → ${name} (${label})`);
  const r = spawnSync(node, [script], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log("run-lang-all: OK (core + pages-audit + playwright harness)");
