/**
 * Sanity check: on a long straight, holding throttle must accelerate the kart.
 * Uses simulated frame counts because software rendering is too slow for waits.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

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
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5, null, {
  timeout: 60000,
});

// Harbor has the long straight; forceRace gives a rolling start with no walls.
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setTrack('harbor'));
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.forceRace());
await page.waitForTimeout(400);

const start = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return { frame: d.frame, speed: d.player.speed, x: d.player.position.x, z: d.player.position.z };
});

await page.keyboard.down('KeyW');
await page.waitForFunction(
  (t) => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) >= t,
  start.frame + 12,
  { timeout: 180000 },
);
const end = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return { frame: d.frame, speed: d.player.speed, x: d.player.position.x, z: d.player.position.z };
});
await page.keyboard.up('KeyW');

const report = {
  track: 'harbor',
  frames: end.frame - start.frame,
  speedStart: Number(start.speed.toFixed(2)),
  speedEnd: Number(end.speed.toFixed(2)),
  accelerated: end.speed > start.speed,
  moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
  errors,
};
console.log(JSON.stringify(report, null, 2));

await browser.close();
if (!report.accelerated) process.exitCode = 1;
