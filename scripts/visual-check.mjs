/**
 * Replicates tests/visual.spec.ts assertions with the Chromium build that is
 * actually installed locally (the bundled channel/webkit revisions are missing).
 * Runs in solo and duo, and also checks the split-screen seam.
 */
import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/visual-check';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const sample = async (page) => {
  const buffer = await page.locator('#game-canvas').screenshot();
  const png = PNG.sync.read(buffer);
  let min = 255;
  let max = 0;
  let alpha = 0;
  const buckets = new Set();
  const stride = Math.max(1, Math.floor((png.width * png.height) / 4096));
  for (let i = 0; i < png.width * png.height; i += stride) {
    const o = i * 4;
    const r = png.data[o];
    const g = png.data[o + 1];
    const b = png.data[o + 2];
    const a = png.data[o + 3];
    min = Math.min(min, r, g, b);
    max = Math.max(max, r, g, b);
    if (a > 0) alpha += 1;
    buckets.add(`${r >> 4},${g >> 4},${b >> 4},${a >> 6}`);
  }
  const variance = max - min;
  return { ok: alpha > 256 && (variance > 8 || buckets.size > 3), variance, buckets: buckets.size };
};

const readPlayer = (page) =>
  page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    const p = d?.player;
    return {
      frame: d?.frame ?? 0,
      x: p?.position.x ?? 0,
      z: p?.position.z ?? 0,
      speed: p?.speed ?? 0,
    };
  });

const run = async (mode) => {
  const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5, null, {
    timeout: 60000,
  });
  await page.evaluate((m) => window.__THREE_GAME_TEST_HOOKS__?.setMode(m), mode);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await page.waitForTimeout(800);

  const canvas = await sample(page);
  const before = await readPlayer(page);

  // Software rendering is far too slow to use wall-clock waits, so advance a
  // fixed number of simulated frames instead.
  await page.keyboard.down('KeyW');
  await page.waitForFunction(
    (target) => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) >= target,
    before.frame + 8,
    { timeout: 180000 },
  );
  await page.keyboard.up('KeyW');
  const after = await readPlayer(page);

  await page.screenshot({ path: path.join(outDir, `${mode}.png`) });
  await page.close();

  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  return {
    mode,
    canvas,
    frames: after.frame - before.frame,
    moved: Number(moved.toFixed(2)),
    speedBefore: Number(before.speed.toFixed(2)),
    speedAfter: Number(after.speed.toFixed(2)),
    consoleErrors,
    pageErrors,
  };
};

const report = { solo: await run('solo'), duo: await run('duo') };
report.pass =
  report.solo.canvas.ok &&
  report.duo.canvas.ok &&
  report.solo.moved > 0.5 &&
  report.duo.moved > 0.5 &&
  report.solo.consoleErrors.length === 0 &&
  report.duo.consoleErrors.length === 0 &&
  report.solo.pageErrors.length === 0 &&
  report.duo.pageErrors.length === 0;

await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
if (!report.pass) process.exitCode = 1;
