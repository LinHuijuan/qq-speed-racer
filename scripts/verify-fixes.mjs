/**
 * Verifies the optimization pass: race clock, draw-call reduction, split-screen
 * post processing, PiP, and event-driven resize.
 */
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = process.argv[3] ?? 'artifacts/verify-fixes';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

const results = {};

results.menu = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.measureDrawCalls());

// --- Race clock must advance while racing -----------------------------------
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await page.waitForTimeout(400);
const clock = [];
for (let i = 0; i < 3; i += 1) {
  clock.push(
    await page.evaluate(() => {
      const d = window.__THREE_GAME_DIAGNOSTICS__;
      return {
        frame: d.frame,
        raceTime: Number(d.raceTime.toFixed(3)),
        hud: document.querySelector('#timer-value')?.textContent ?? null,
      };
    }),
  );
  await page.waitForTimeout(2000);
}
results.clock = clock;
results.clockAdvanced = clock[clock.length - 1].raceTime > clock[0].raceTime;
results.hudAdvanced = clock[clock.length - 1].hud !== clock[0].hud;

// --- Solo cost ---------------------------------------------------------------
results.solo = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.measureDrawCalls());
await page.screenshot({ path: path.join(outDir, 'solo.png') });

// --- Duo split screen (now through the composer) ----------------------------
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setMode('duo'));
await page.waitForTimeout(1200);
results.duo = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.measureDrawCalls());

const duoShot = await page.locator('#game-canvas').screenshot();
await writeFile(path.join(outDir, 'duo.png'), duoShot);

const analyse = (buffer, fromX, toX) => {
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  const buckets = new Set();
  for (let y = 0; y < png.height; y += 2) {
    for (let x = fromX; x < toX; x += 2) {
      const o = (y * png.width + x) * 4;
      const r = png.data[o];
      const g = png.data[o + 1];
      const b = png.data[o + 2];
      min = Math.min(min, r, g, b);
      max = Math.max(max, r, g, b);
      buckets.add(`${r >> 4},${g >> 4},${b >> 4}`);
    }
  }
  return { variance: max - min, colorBuckets: buckets.size };
};
const duoPng = PNG.sync.read(duoShot);
const mid = Math.floor(duoPng.width / 2);
results.duoLeft = analyse(duoShot, 0, mid);
results.duoRight = analyse(duoShot, mid, duoPng.width);

// --- PiP ---------------------------------------------------------------------
// The toggle carries .hidden-ctl outside a live race, so invoke it directly.
await page.evaluate(() => document.querySelector('#pip-toggle')?.click());
await page.waitForTimeout(2500);
results.pip = await page.evaluate(() => ({
  visible: !document.querySelector('#pip-frame')?.classList.contains('hidden'),
  canvasCount: document.querySelectorAll('#pip-canvas-wrap canvas').length,
}));
await page.screenshot({ path: path.join(outDir, 'duo-pip.png') });
await page.evaluate(() => document.querySelector('#pip-toggle')?.click());

// --- Event-driven resize -----------------------------------------------------
const beforeResize = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.canvas);
await page.setViewportSize({ width: 900, height: 500 });
await page.waitForTimeout(900);
const afterResize = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.canvas);
results.resize = { beforeResize, afterResize };

// --- Best-time persistence path ---------------------------------------------
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('complete'));
await page.waitForTimeout(600);
results.bestRecords = await page.evaluate(() =>
  Object.fromEntries(
    Object.entries(localStorage).filter(([k]) => k.toLowerCase().includes('best')),
  ),
);
await page.screenshot({ path: path.join(outDir, 'finish.png') });

results.errors = errors;
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

await browser.close();
