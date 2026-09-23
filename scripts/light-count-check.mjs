/**
 * Watches the visible light count and the compiled-program count while a kart
 * drifts and boosts.
 *
 * Each Kart used to carry a PointLight whose `visible` toggled with the drift
 * state. three.js drops invisible lights from the light list, and the light
 * counts are part of the material program cache key — so every kart starting or
 * stopping a drift changed the key and forced a recompile of every lit material.
 * The invariant this asserts is the fix: the light count must not move.
 *
 *   node scripts/light-count-check.mjs [url]
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

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
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

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

const sample = () =>
  page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return {
      frame: d?.frame ?? 0,
      lights: d?.renderer?.lights ?? -1,
      programs: d?.renderer?.programs ?? -1,
      drifting: d?.player?.drifting ?? false,
      boosting: d?.player?.boosting ?? false,
      speed: d?.player?.speed ?? 0,
    };
  });

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await page.waitForTimeout(1200);

// Build up speed first, then drift — a stationary kart cannot drift.
await page.keyboard.down('KeyW');
await advance(24);

const samples = [await sample()];
for (let i = 0; i < 8; i += 1) {
  await advance(2);
  samples.push(await sample());
}

// Drift: throttle + steer + drift key, held across many frames.
await page.keyboard.down('KeyA');
await page.keyboard.down('ShiftLeft');
for (let i = 0; i < 14; i += 1) {
  await advance(2);
  samples.push(await sample());
}
await page.keyboard.up('ShiftLeft');
await page.keyboard.up('KeyA');

// Boost, which drove the same light through the other branch.
await page.keyboard.down('Space');
for (let i = 0; i < 8; i += 1) {
  await advance(2);
  samples.push(await sample());
}
await page.keyboard.up('Space');
await page.keyboard.up('KeyW');
await advance(4);

await browser.close();

const lights = samples.map((s) => s.lights);
const uniqueLights = [...new Set(lights)];
const driftSamples = samples.filter((s) => s.drifting || s.boosting);
const programCounts = samples.map((s) => s.programs);
const maxSpeed = Math.max(...samples.map((s) => s.speed));

console.log(`\nsamples            ${samples.length}`);
console.log(`speed range        ${Math.min(...samples.map((s) => s.speed)).toFixed(1)} .. ${maxSpeed.toFixed(1)}`);
console.log(`drifting/boosting  ${driftSamples.length} samples`);
console.log(`visible lights     ${uniqueLights.join(', ')}  (values seen)`);
console.log(`programs           ${Math.min(...programCounts)} .. ${Math.max(...programCounts)}`);

check('raceActuallyDrove', maxSpeed > 20, `max speed ${maxSpeed.toFixed(1)}`);
check(
  'driftOrBoostWasActive',
  driftSamples.length > 0,
  `${driftSamples.length} samples with drift/boost active`,
);
check(
  'visibleLightCountIsConstant',
  uniqueLights.length === 1,
  uniqueLights.length === 1
    ? `always ${uniqueLights[0]}`
    : `oscillated between ${uniqueLights.join(' and ')}`,
);
check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
