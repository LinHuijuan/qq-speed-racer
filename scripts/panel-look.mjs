/**
 * Overlay panel look pass. `.panel` is shared by the start, pause and finish
 * screens, and the finish stats grid is its own thing — neither was covered by
 * the race shots, so they get their own capture.
 *
 * Usage:
 *   node scripts/panel-look.mjs [url] [width] [height] [prefix]
 * Run it once at 1280x720 and again at 844x390: the short-landscape reflow is
 * driven by a media query, so these panels lay out completely differently there
 * and the desktop shots cannot stand in for them.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const width = Number(process.argv[3] ?? 1280);
const height = Number(process.argv[4] ?? 720);
const prefix = process.argv[5] ?? '';
const outDir = 'artifacts/round5';
mkdirSync(outDir, { recursive: true });

const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
// Touch emulation matters here: `(pointer: coarse)` is what stacks
// `.finish-stats` into one column, so a plain 844x390 window would not exercise
// the same code path a real landscape phone does.
const mobile = width < 900;
const ctx = await browser.newContext({
  viewport: { width, height },
  hasTouch: mobile,
  isMobile: mobile,
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});

// The overlay fades in over 0.28s and document.timeline never advances under
// headless, so the transition has to be dropped or the shot lands at opacity 0.
const settle = () =>
  page.evaluate(() => {
    document.querySelectorAll('.overlay').forEach((el) => {
      el.style.transition = 'none';
    });
  });

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('complete'));
await settle();
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/${prefix}12-finish-panel.png` });
console.log(`${outDir}/${prefix}12-finish-panel.png`);

const stats = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('#overlay-finish .finish-stats > div')];
  const panel = document.querySelector('#overlay-finish .panel');
  return {
    cards: cards.length,
    heights: cards.map((el) => Math.round(el.getBoundingClientRect().height)),
    borders: cards.map((el) => getComputedStyle(el).backgroundImage.split('),').length),
    rankColor: getComputedStyle(cards[1].querySelector('strong')).color,
    overflow: panel.scrollWidth - panel.clientWidth,
    // The finish panel scrolls in principle; its CTA should still fit.
    ctaFits: (() => {
      const btn = document.querySelector('#restart-button');
      const pr = panel.getBoundingClientRect();
      return btn.getBoundingClientRect().bottom <= pr.bottom + 0.5;
    })(),
  };
});
console.log(JSON.stringify(stats, null, 2));

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await page.keyboard.down('w');
await page.waitForTimeout(900);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('menu'));
await page.waitForTimeout(300);
await page.evaluate(() => {
  document.querySelectorAll('.overlay').forEach((el) => {
    el.style.transition = 'none';
  });
  // togglePause bails out on phase 'menu', so drive the overlay directly.
  document.querySelector('#overlay-pause').classList.add('visible');
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${outDir}/${prefix}13-pause-panel.png` });
console.log(`${outDir}/${prefix}13-pause-panel.png`);

const pause = await page.evaluate(() => {
  const panel = document.querySelector('#overlay-pause .panel');
  return {
    overflow: panel.scrollWidth - panel.clientWidth,
    ctaFits: (() => {
      const btn = document.querySelector('#resume-button');
      const pr = panel.getBoundingClientRect();
      return btn.getBoundingClientRect().bottom <= pr.bottom + 0.5;
    })(),
  };
});
console.log(JSON.stringify(pause, null, 2));

await ctx.close();
await browser.close();
