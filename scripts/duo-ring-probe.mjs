/**
 * Identify the bright ring that shows up around the kart in duo mode.
 *
 * The candidates, from reading the source, are:
 *   - Kart.groundGlow  — a flat additive PlaneGeometry(3.8, 3.8) with a radial
 *     gradient map. Diagnostics expose its opacity as `player.glow`, so if that
 *     reads 0 while the ring is on screen the ground glow is ruled out.
 *   - the boost-pad ring — RingGeometry(2.3, 2.7) in #7cf6ff, flat on the road,
 *     unlit MeshBasicMaterial at opacity 0.9. That one is bolted to the track, so
 *     it stays put while the kart drives away from it.
 *
 * So: log `glow`, and take two frames a second apart. A ring that stays glued to
 * the kart is a kart child; one that slides away is a track object.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/audit6';
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

await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__.setMode('duo');
  window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
});
await page.keyboard.down('w');
await page.keyboard.down('ArrowUp');

const sample = () =>
  page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return {
      glow: d.player?.glow,
      drifting: d.player?.drifting,
      boosting: d.player?.boosting,
      speed: Math.round(d.player?.speed ?? 0),
      pos: d.player?.position,
      p2glow: d.player2?.glow,
      p2speed: Math.round(d.player2?.speed ?? 0),
      p2pos: d.player2?.position,
    };
  });

for (const [i, wait] of [1200, 1200, 1200].entries()) {
  await page.waitForTimeout(wait);
  const s = await sample();
  console.log(`\n--- frame ${i} ---`);
  console.log(
    `P1 glow=${s.glow} drifting=${s.drifting} boosting=${s.boosting} speed=${s.speed}`,
  );
  console.log(`P1 pos=${JSON.stringify(s.pos)}`);
  console.log(`P2 glow=${s.p2glow} speed=${s.p2speed} pos=${JSON.stringify(s.p2pos)}`);
  await page.screenshot({ path: `${outDir}/duo-ring-${i}.png` });
}

await browser.close();
console.log('\ndone');
