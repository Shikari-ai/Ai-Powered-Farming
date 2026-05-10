import { chromium } from 'playwright';

const URL = process.argv[2] || 'https://agritech-4d1ba.web.app/index.html';

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();

const consoleMsgs = [];
const pageErrs = [];
page.on('console', m => consoleMsgs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => pageErrs.push(`PAGEERROR ${e.message}`));

await page.goto(URL, { waitUntil: 'networkidle', timeout: 30000 }).catch(e => pageErrs.push('NAV ' + e.message));

await page.waitForTimeout(3500); // give dashboard.js / safety reveal time

const state = await page.evaluate(() => ({
  url: location.href,
  title: document.title,
  bodyClass: document.body.className,
  appOpacity: document.querySelector('.app') ? getComputedStyle(document.querySelector('.app')).opacity : null,
  hdrGreet: document.getElementById('hdr-greet')?.innerText || null,
  hdrName: document.getElementById('hdr-name')?.innerText || null,
  weatherCardExists: !!document.querySelector('.wcard'),
  glanceCardCount: document.querySelectorAll('.glance-card').length,
  pageH: document.body.scrollHeight,
}));

console.log(JSON.stringify({ state, consoleMsgs: consoleMsgs.slice(-30), pageErrs }, null, 2));

await browser.close();
