/**
 * Verifies the ground glow two ways, because the light-to-decal swap is an
 * intentional visual change and a pixel diff is the wrong tool for it:
 *
 *   - wiring, numerically: opacity must be ~0 at cruise and rise while drifting
 *     or boosting, then fall back. This is what a broken decal would fail.
 *   - appearance, by eye: a clean frame while boosting in a straight line, since
 *     holding a drift under scripted input ends in the barrier and buries the
 *     kart in sparks.
 *
 *   node scripts/glow-look.mjs [url]
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/glow';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

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

const readState = () =>
  page.evaluate(() => {
    const p = window.__THREE_GAME_DIAGNOSTICS__?.player;
    return {
      speed: +(p?.speed ?? 0).toFixed(1),
      nitro: +(p?.nitro ?? 0).toFixed(2),
      drifting: p?.drifting ?? false,
      boosting: p?.boosting ?? false,
      glow: +(p?.glow ?? 0).toFixed(3),
    };
  });

// Crop to the lower centre, where the chase camera puts the kart.
const clip = { x: 400, y: 330, width: 480, height: 330 };
const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png`, clip });

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await page.waitForTimeout(1500);

await page.keyboard.down('KeyW');
await advance(24);
const cruise = await readState();
await shot('01-cruise');

// Drift first, and for a single frame. Drifting needs |steer| > 0.12, so it
// cannot be done straight, and under SwiftShader each frame advances a large
// simulated delta — three frames is already enough to leave the road and bury
// the kart in sparks.
await page.keyboard.down('KeyA');
await page.keyboard.down('ShiftLeft');
await advance(1);
const drift = await readState();
await shot('02-drift');
// Opacity eases in, so the 1-frame sample above is mid-ramp. Assert on the
// settled value instead; the early frame is only kept for the screenshot.
await advance(2);
const driftSettled = await readState();
await shot('03-drift-late');

// Releasing a charged drift fires a mini turbo, which is a boost that needs no
// nitro — so this frame shows the glow with the kart still roughly straight.
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('KeyA');
await advance(1);
const boost = await readState();
await shot('04-boost');
await advance(2);
await shot('05-boost-late');

await advance(12);
const settled = await readState();
await shot('06-settled');
await page.keyboard.up('KeyW');

await browser.close();

console.log('\nstate        speed  nitro  drift  boost   glow');
for (const [label, s] of [
  ['cruise', cruise],
  ['drift x1', drift],
  ['drift x3', driftSettled],
  ['boost', boost],
  ['settled', settled],
]) {
  console.log(
    `${label.padEnd(12)} ${String(s.speed).padStart(5)}  ${String(s.nitro).padStart(5)}  ` +
      `${String(s.drifting).padStart(5)}  ${String(s.boosting).padStart(5)}  ${String(s.glow).padStart(5)}`,
  );
}

check('kartActuallyMoved', cruise.speed > 20, `cruise speed ${cruise.speed}`);
check('glowIsDarkWhenIdle', cruise.glow < 0.05, `cruise glow ${cruise.glow}`);
check('glowLightsUpWhileBoosting', boost.glow > 0.2, `boost glow ${boost.glow}`);
check(
  'glowLightsUpWhileDrifting',
  driftSettled.glow > 0.2,
  `drift glow ${driftSettled.glow} (mid-ramp at 1 frame: ${drift.glow})`,
);
check(
  'glowFadesAfterRelease',
  settled.glow < Math.max(boost.glow, drift.glow),
  `settled ${settled.glow} vs peak ${Math.max(boost.glow, drift.glow)}`,
);
check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
console.log(`shots -> ${outDir}/`);
process.exit(failed ? 1 : 0);
