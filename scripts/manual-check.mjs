import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5188';
const outDir = process.argv[3] ?? 'artifacts/manual-check';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 15000,
});

const menuShot = await page.screenshot({ fullPage: true });
await writeFile(path.join(outDir, 'menu.png'), menuShot);

// Enter race via test hook for deterministic capture
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(true);
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
  const start = document.querySelector('#overlay-start');
  const finish = document.querySelector('#overlay-finish');
  if (start) {
    start.classList.remove('visible');
    start.style.display = 'none';
  }
  if (finish) {
    finish.classList.remove('visible');
    finish.style.display = 'none';
  }
});
await page.waitForTimeout(500);

const activeShot = await page.screenshot({ fullPage: true });
await writeFile(path.join(outDir, 'active-play.png'), activeShot);

const canvasShot = await page.locator('#game-canvas').screenshot();
const png = PNG.sync.read(canvasShot);
let min = 255;
let max = 0;
const buckets = new Set();
const stride = Math.max(1, Math.floor((png.width * png.height) / 5000));
for (let i = 0; i < png.width * png.height; i += stride) {
  const o = i * 4;
  const r = png.data[o];
  const g = png.data[o + 1];
  const b = png.data[o + 2];
  min = Math.min(min, r, g, b);
  max = Math.max(max, r, g, b);
  buckets.add(`${r >> 4},${g >> 4},${b >> 4}`);
}

// Resume play and try throttle
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(false);
  window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(false);
});
await page.locator('#game-canvas').click({ position: { x: 40, y: 40 } });
const before = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player?.speed ?? 0);
await page.keyboard.down('KeyW');
await page.waitForTimeout(2500);
await page.keyboard.up('KeyW');
const after = await page.evaluate(() => ({
  speed: window.__THREE_GAME_DIAGNOSTICS__?.player?.speed ?? 0,
  x: window.__THREE_GAME_DIAGNOSTICS__?.player?.position.x ?? 0,
  z: window.__THREE_GAME_DIAGNOSTICS__?.player?.position.z ?? 0,
  phase: window.__THREE_GAME_DIAGNOSTICS__?.phase,
  lap: window.__THREE_GAME_DIAGNOSTICS__?.lap,
  rank: window.__THREE_GAME_DIAGNOSTICS__?.rank,
  renderer: window.__THREE_GAME_DIAGNOSTICS__?.renderer,
}));

const report = {
  canvas: {
    width: png.width,
    height: png.height,
    variance: max - min,
    colorBuckets: buckets.size,
    nonBlank: max - min > 8 && buckets.size > 3,
  },
  speedBefore: before,
  speedAfter: after,
  errors,
};
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
if (errors.length || !report.canvas.nonBlank || after.speed <= before) {
  process.exitCode = 1;
}
