/**
 * Hit production hosting (no local server). Run: node scripts/production-smoke.mjs
 */
const ORIGIN = process.env.AGRI_PRODUCTION_ORIGIN || "https://agritech-4d1ba.web.app";

const paths = ["/login.html", "/profile.html", "/index.html"];

let failed = false;
for (const p of paths) {
  const url = ORIGIN.replace(/\/$/, "") + p;
  try {
    const res = await fetch(url, { redirect: "manual" });
    const ok = res.status === 200 || (res.status >= 300 && res.status < 400);
    if (!ok) {
      console.error("FAIL", url, res.status);
      failed = true;
      continue;
    }
    console.log("OK ", res.status, url);
  } catch (e) {
    console.error("FAIL", url, e.message);
    failed = true;
  }
}

const profileUrl = ORIGIN.replace(/\/$/, "") + "/profile.html";
const html = await (await fetch(profileUrl)).text();
const checks = [
  ["panel-language", /id="panel-language"/.test(html)],
  ["lang-list", /id="lang-list"/.test(html)],
  ["main-location (no data-i18n)", /id="main-location"/.test(html) && !/id="main-location"[^>]*data-i18n/.test(html)],
];
for (const [name, pass] of checks) {
  if (!pass) {
    console.error("FAIL markup:", name);
    failed = true;
  } else console.log("OK  markup:", name);
}

process.exit(failed ? 1 : 0);
