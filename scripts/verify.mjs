/**
 * Static checks for this repo (no npm deps). Run: node scripts/verify.mjs
 */
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function walkJson(dir, acc = []) {
  for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) walkJson(p, acc);
    else if (name.name.endsWith(".json")) acc.push(p);
  }
  return acc;
}

const i18nDir = path.join(root, "js", "i18n");
for (const f of walkJson(i18nDir)) {
  try {
    JSON.parse(fs.readFileSync(f, "utf8"));
  } catch (e) {
    console.error("Invalid JSON:", path.relative(root, f), e.message);
    process.exit(1);
  }
}
console.log("i18n JSON:", walkJson(i18nDir).length, "files OK");

const jsDir = path.join(root, "js");
for (const name of fs.readdirSync(jsDir)) {
  if (!name.endsWith(".js")) continue;
  const p = path.join(jsDir, name);
  execSync(`node --check "${p}"`, { stdio: "inherit", shell: true });
}
console.log("js syntax: OK");
