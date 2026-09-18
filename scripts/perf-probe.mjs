/**
 * Runtime probe: verifies race timing actually advances and collects
 * renderer cost (draw calls / triangles / geometries / textures).
 * Uses a small viewport because the probe runs on SwiftShader (software GL).
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = process.argv[3] ?? 'artifacts/perf-probe';
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

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 20000,
});

// Jump straight into a rolling race so the timer logic is exercised.
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
});
await page.waitForTimeout(500);

const read = () =>
  page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return {
      frame: d.frame,
      raceTime: Number(d.raceTime.toFixed(3)),
      phase: d.phase,
      speed: Number(d.player.speed.toFixed(2)),
      hudTimer: document.querySelector('#timer-value')?.textContent ?? null,
      calls: d.renderer.calls,
      triangles: d.renderer.triangles,
      geometries: d.renderer.geometries,
      textures: d.renderer.textures,
    };
  });

await page.locator('#game-canvas').click({ position: { x: 320, y: 200 } });
await page.keyboard.down('KeyW');

const samples = [await read()];
for (let i = 0; i < 4; i += 1) {
  await page.waitForTimeout(2500);
  samples.push(await read());
}
await page.keyboard.up('KeyW');

const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const t0 = performance.now();
      const f0 = window.__THREE_GAME_DIAGNOSTICS__.frame;
      setTimeout(() => {
        const dt = (performance.now() - t0) / 1000;
        resolve(Number(((window.__THREE_GAME_DIAGNOSTICS__.frame - f0) / dt).toFixed(1)));
      }, 3000);
    }),
);

// Render cost per viewport in duo (direct render, no post chain to mask counts)
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setMode('duo'));
await page.waitForTimeout(1200);
const duoInfo = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return { mode: d.mode, calls: d.renderer.calls, triangles: d.renderer.triangles };
});
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setMode('solo'));
await page.waitForTimeout(1200);
const soloInfo = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return { mode: d.mode, calls: d.renderer.calls, triangles: d.renderer.triangles };
});

const report = { samples, fps, duoInfo, soloInfo, errors };
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
