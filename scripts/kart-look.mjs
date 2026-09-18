/**
 * Captures clean start-line views so merged kart geometry can be eyeballed.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/kart-look';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

// Menu = camera parked behind the player on the grid, nothing moving.
// The start overlay would cover the karts, so hide it first.
for (const mode of ['solo', 'duo']) {
  await page.evaluate((m) => window.__THREE_GAME_TEST_HOOKS__?.setMode(m), mode);
  await page.evaluate(() => {
    for (const sel of ['#overlay-start', '#overlay-finish', '#hud']) {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    }
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, `${mode}-grid.png`) });
}

// Mid-race view with a drifting, boosting kart.
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setMode('solo'));
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 30, null, {
  timeout: 180000,
});
await page.screenshot({ path: path.join(outDir, 'racing.png') });

console.log(JSON.stringify({ ok: true, errors }, null, 2));
await browser.close();
