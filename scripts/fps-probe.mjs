/**
 * Compares frame throughput between solo and duo at a given viewport, to see
 * what the split-screen post chain costs.
 */
import { chromium } from '@playwright/test';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const width = Number(process.argv[3] ?? 1280);
const height = Number(process.argv[4] ?? 720);
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width, height } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5, null, {
  timeout: 60000,
});

const measure = async (mode) => {
  await page.evaluate((m) => window.__THREE_GAME_TEST_HOOKS__?.setMode(m), mode);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await page.waitForTimeout(600);

  const before = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return { frame: d.frame, x: d.player.position.x, z: d.player.position.z, raceTime: d.raceTime };
  });
  await page.keyboard.down('KeyW');
  const t0 = Date.now();
  await page.waitForTimeout(4000);
  await page.keyboard.up('KeyW');
  const wall = (Date.now() - t0) / 1000;
  const after = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return { frame: d.frame, x: d.player.position.x, z: d.player.position.z, raceTime: d.raceTime };
  });

  const frames = after.frame - before.frame;
  return {
    mode,
    frames,
    wallSeconds: Number(wall.toFixed(2)),
    fps: Number((frames / wall).toFixed(2)),
    simSeconds: Number((after.raceTime - before.raceTime).toFixed(3)),
    moved: Number(Math.hypot(after.x - before.x, after.z - before.z).toFixed(2)),
  };
};

const report = {
  viewport: `${width}x${height}`,
  solo: await measure('solo'),
  duo: await measure('duo'),
  errors,
};
console.log(JSON.stringify(report, null, 2));

await browser.close();
