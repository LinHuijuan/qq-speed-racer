/**
 * Fast iteration loop for the boost look. The full round5-shots pass takes
 * minutes; tuning bloom strength and particle size needs a 40-second turnaround,
 * so this captures only the two frames that matter — cruise and boost — plus the
 * numbers behind them.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/round5';
mkdirSync(outDir, { recursive: true });

const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await page.keyboard.down('w');
await page.waitForTimeout(1600);
await page.screenshot({ path: `${outDir}/boost-A-cruise.png` });

await page.keyboard.down(' ');
await page.waitForTimeout(700);
const boost = await page.evaluate(() => ({
  live: window.__THREE_GAME_DIAGNOSTICS__.vfxLive,
  speed: document.querySelector('#speed-value').textContent,
  glow: window.__THREE_GAME_DIAGNOSTICS__.player?.glowOpacity ?? null,
}));
await page.screenshot({ path: `${outDir}/boost-B-boost.png` });
await page.keyboard.up(' ');

// Blown-out fraction: the share of the frame that is near-white. A readable
// kart shot sits well under 1%; a bloom-soaked one climbs past 5%.
const blowout = await page.evaluate(async () => {
  const canvas = document.querySelector('#game-canvas');
  const off = document.createElement('canvas');
  off.width = 320;
  off.height = 180;
  const g = off.getContext('2d');
  g.drawImage(canvas, 0, 0, 320, 180);
  const { data } = g.getImageData(0, 0, 320, 180);
  let bright = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += 4) {
    total += 1;
    if (data[i] > 235 && data[i + 1] > 235 && data[i + 2] > 235) bright += 1;
  }
  return { pct: (bright / total) * 100 };
});

console.log(JSON.stringify({ ...boost, nearWhitePct: Number(blowout.pct.toFixed(2)) }, null, 2));
await ctx.close();
await browser.close();
