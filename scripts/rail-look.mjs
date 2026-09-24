/**
 * Chase-view screenshot of the guardrail.
 *
 * The guardrail used to read as a parallel glowing pair — two horizontal neon
 * tubes in cyan (left) and magenta (right), the same colour and the same
 * "horizontal glowing line" language as the road's own edge strips — so from
 * the chase camera the wall and the road edge looked like one band, and
 * players did not realise they had hit a wall until after the fact.
 *
 * The fix swapped the tubes for a yellow/black hazard kickplate. This script
 * does not pixel-diff the wall vs the road edge (the visual check is a human
 * one), but it does:
 *
 *   - boot the game, force into a race, hold W long enough to reach chase
 *     camera framing, screenshot the chase view → artifacts/rail-look/chase.png
 *   - assert no console errors along the way
 *
 * If you change the wall again, eyeball the resulting PNG. If the wall stops
 * reading as a yellow/black surface, the change is the wrong direction.
 *
 *   node scripts/rail-look.mjs [url]
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir('artifacts/rail-look', { recursive: true });

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
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('active-play'));
await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.phase === 'racing', null, {
  timeout: 30000,
});
// A few frames so the chase rig catches up to the cart's mid-track pose.
const advance = (n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        let left = count;
        const tick = () => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
await advance(12);

const stats = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return { speed: d.player.speed, progress: d.player.progress };
});

await page.screenshot({ path: 'artifacts/rail-look/chase.png' });
await browser.close();

console.log(`chase shot saved   artifacts/rail-look/chase.png   speed=${stats.speed.toFixed(1)} progress=${stats.progress.toFixed(2)}`);
console.log(`console errors:    ${errors.length}${errors.length ? '  ' + errors.slice(0, 3).join(' | ') : ''}`);
if (errors.length) process.exitCode = 1;