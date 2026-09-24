/**
 * Three-frame visual strip of the barrier auto-return.
 *
 * `wall-return-check.mjs` proves the behaviour numerically (the |lateral|
 * trace is the real evidence — the return is a *temporal* thing, so a single
 * still cannot show it). This script exists for the other half of the
 * question: does it *look* like the barrier spat the kart out, or like the
 * kart teleported?
 *
 * It drives into the left barrier, then stops steering and keeps the
 * throttle, and grabs three chase-view frames:
 *
 *   1-contact.png    the moment the kart reaches the barrier band
 *   2-returning.png  mid-slide, still off the asphalt
 *   3-back-on-road.png  back on the asphalt, still moving
 *
 * Sim stepping goes through `stepSim` (cheap, no render — real frames are
 * 0.3~5 s each here), and each frame is only *rendered* with a couple of
 * requestAnimationFrame ticks right before the screenshot. Those ticks do
 * advance the sim by a real (clamped) delta, which is why the captured
 * numbers are read after the render, not before.
 *
 *   node scripts/wall-return-shots.mjs [url]
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
const outDir = 'artifacts/wall-return';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.phase === 'racing', null, {
  timeout: 30000,
});

const stepSim = (n) => page.evaluate((f) => window.__THREE_GAME_TEST_HOOKS__.stepSim(f), n);
// Two real frames: enough for the chase rig and the renderer to catch up.
const render = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
const sample = () =>
  page.evaluate(() => {
    const p = window.__THREE_GAME_DIAGNOSTICS__.player;
    return { lateral: p.lateral, roadHalfWidth: p.roadHalfWidth, speed: p.speed };
  });

const shots = [];
const shoot = async (name) => {
  await render();
  const s = await sample();
  const path = `${outDir}/${name}.png`;
  await page.screenshot({ path });
  shots.push({ name, ...s });
  console.log(
    `  ${name.padEnd(18)} |lateral| ${Math.abs(s.lateral).toFixed(2)}  speed ${s.speed.toFixed(1)}`,
  );
};

const CHUNK = 3;

// --- 1. drive into the left barrier --------------------------------------
await page.keyboard.down('KeyW');
await page.keyboard.down('KeyA');
let halfWidth = 0;
for (let i = 0; i < 60; i += 1) {
  await stepSim(CHUNK);
  const s = await sample();
  halfWidth = s.roadHalfWidth;
  if (Math.abs(s.lateral) > s.roadHalfWidth + 0.35) break;
}
await shoot('1-contact');

// --- 2. stop steering, keep the throttle, catch the slide mid-flight ------
await page.keyboard.up('KeyA');
const returnEdge = halfWidth * 0.9;
for (let i = 0; i < 80; i += 1) {
  await stepSim(CHUNK);
  const s = await sample();
  // Halfway between the barrier band and the return target.
  if (Math.abs(s.lateral) < (halfWidth + 0.85 + returnEdge) / 2) break;
}
await shoot('2-returning');

// --- 3. let it finish, back on the asphalt -------------------------------
for (let i = 0; i < 80; i += 1) {
  await stepSim(CHUNK);
  const s = await sample();
  if (Math.abs(s.lateral) <= returnEdge) break;
}
await shoot('3-back-on-road');
await page.keyboard.up('KeyW');

await browser.close();

console.log(`\nroad half-width  ${halfWidth.toFixed(2)}   return target ${returnEdge.toFixed(2)}`);
console.log(`console errors:  ${errors.length}${errors.length ? '  ' + errors.slice(0, 3).join(' | ') : ''}`);
console.log(`\nsaved to ${outDir}/`);
if (errors.length) process.exitCode = 1;
