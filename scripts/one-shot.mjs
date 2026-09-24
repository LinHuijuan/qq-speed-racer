/**
 * One livery, one angle, one PNG — for dye tests.
 *
 * kart-look-2.mjs does 32 shots in ~5 minutes, which is too slow when the
 * question is "where on the wheel does part X actually land?". This is the
 * same setup with the loop removed.
 *
 *   node artifacts/one-shot.mjs <angle> <livery> <tag>
 *   node artifacts/one-shot.mjs side crimson dye
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const angleName = process.argv[2] ?? 'side';
const livery = process.argv[3] ?? 'crimson';
const tag = process.argv[4] ?? 'one';
const url = process.argv[5] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/kart-look';
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

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

await page.evaluate((id) => {
  const h = window.__THREE_GAME_TEST_HOOKS__;
  h?.setMode?.('solo');
  h?.setState?.('active-play');
  h?.hideRivals?.(true);
  h?.selectCar?.(id);
  for (const sel of ['#overlay-start', '#overlay-finish', '#hud', '#touch-controls']) {
    const el = document.querySelector(sel);
    if (el) el.style.display = 'none';
  }
}, livery);
await page.waitForTimeout(400);

const pose = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
  return { position: d.player.position, heading: d.player.heading ?? 0 };
});

const { x, z } = pose.position;
const h = pose.heading;
const fwd = [Math.sin(h), 0, Math.cos(h)];
const right = [Math.cos(h), 0, -Math.sin(h)];
const at = (r, u, f) => [x + right[0] * r + fwd[0] * f, u, z + right[2] * r + fwd[2] * f];

const angles = {
  side: { pos: at(2.6, 0.8, 0.1), look: at(0, 0.5, 0) },
  // Tighter on the front wheel, which is where the dye test needs to look.
  wheel: { pos: at(2.0, 0.34, 0.9), look: at(0.62, 0.32, 0.78) },
  'rear-3q': { pos: at(-1.5, 1.05, -2.2), look: at(0, 0.5, 0) },
  chase: { pos: at(0, 2.75, -9.6), look: at(0, 0.85, 7.4) },
};
const angle = angles[angleName];
if (!angle) throw new Error(`unknown angle "${angleName}" (have: ${Object.keys(angles).join(', ')})`);

await page.evaluate(
  ({ pos, look }) => window.__THREE_GAME_TEST_HOOKS__?.placeCamera?.(pos, look),
  angle,
);
await page.waitForTimeout(200);
const file = `${tag}-${angleName}.png`;
await page.screenshot({ path: path.join(outDir, file) });
console.log(JSON.stringify({ ok: errors.length === 0, file, errors }, null, 2));
await browser.close();
