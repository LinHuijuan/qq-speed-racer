/**
 * prefers-reduced-motion regression.
 *
 * The stylesheet honoured the media query, but the 3D scene did not: the
 * `reducedMotion` flag could only be set through the test hook and was never
 * read from matchMedia, so particles and the full-screen boost flash kept
 * firing for users who had asked the OS for less motion.
 *
 * (Camera shake used to be on that list too; it has since been removed from
 * `CameraRig` altogether — see `camera-shake-check.mjs`. This script still
 * guards the flag and the particle path, which are the two things left.)
 *
 * Observable contract: with the preference on, the flag reaches the game AND a
 * shockwave that would normally spawn particles spawns none. Without the
 * preference the same action must still spawn them, so the test cannot pass by
 * accident.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

/** Advances the sim by `n` rendered frames (software rendering is ~3fps). */
function advanceFrames(page, n) {
  return page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const from = window.__THREE_GAME_DIAGNOSTICS__.frame;
        const tick = () => {
          if (window.__THREE_GAME_DIAGNOSTICS__.frame - from >= count) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );
}

async function probe(reducedMotion) {
  const ctx = await browser.newContext({
    viewport: { width: 640, height: 360 },
    reducedMotion,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 90000,
  });

  const mediaMatches = await page.evaluate(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.forceRace());
  await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__.phase === 'racing', null, {
    timeout: 30000,
  });

  // The one-key "back to track" is the cheapest deterministic VFX trigger: it
  // always emits a shockwave. A frame takes ~0.3s under software rendering, so
  // the key has to be held across a frame — press() would go down and up
  // between two ticks and the edge detector would never see it.
  await page.keyboard.down('KeyR');
  await advanceFrames(page, 3);
  await page.keyboard.up('KeyR');

  const out = await page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    return { flag: d.reducedMotion, vfxLive: d.vfxLive, phase: d.phase };
  });
  await ctx.close();
  return { ...out, mediaMatches, errors };
}

const off = await probe('no-preference');
const on = await probe('reduce');
await browser.close();

console.log('=== prefers-reduced-motion ===');
console.log(
  `no-preference : media=${off.mediaMatches} flag=${off.flag} vfxLive=${off.vfxLive} phase=${off.phase}`,
);
console.log(
  `reduce        : media=${on.mediaMatches} flag=${on.flag} vfxLive=${on.vfxLive} phase=${on.phase}`,
);
console.log(`console errors: off=${off.errors.length} on=${on.errors.length}`);

const checks = {
  // The preference reaches the game instead of only the stylesheet.
  preferenceReachesScene: off.flag === false && on.flag === true,
  // Without the preference the same action still produces particles...
  particlesSpawnWhenMotionAllowed: (off.vfxLive ?? 0) > 0,
  // ...and with it, none are emitted at all.
  particlesSuppressedWhenReduced: (on.vfxLive ?? 0) === 0,
  raceStillRunsWhenReduced: on.phase === 'racing',
  noConsoleErrors: off.errors.length === 0 && on.errors.length === 0,
};
console.log(JSON.stringify(checks, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log('pass:', pass);
if (!pass) process.exitCode = 1;
