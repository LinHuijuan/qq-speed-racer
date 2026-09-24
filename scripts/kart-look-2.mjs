/**
 * Model inspection shots. The chase camera in the game sits ~3m behind and
 * low, which collapses the kart's silhouette into "a dark wedge with lights" —
 * useless for judging whether the model itself looks good. This parks a free
 * camera (added to the test hooks for exactly this) at fixed body-relative
 * offsets and orbits the kart: front 3/4, side, rear 3/4, top, and a low hero
 * angle, once per livery.
 *
 *   node scripts/kart-look-2.mjs [url]        -> artifacts/kart-look/{tag}-*.png
 *   TAG=before node scripts/kart-look-2.mjs   (default tag is "shot")
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const tag = process.env.TAG ?? 'shot';
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

/**
 * Vite's HMR reloads the page whenever a source file changes, which destroys
 * the `page.evaluate` execution context mid-run ("Execution context was
 * destroyed, most likely because of a navigation"). That is expected when
 * another process is editing the same working tree, so every evaluate goes
 * through this: on failure it waits for the app to come back and re-applies
 * the setup, then retries. Without it a single stray save aborts a 28-shot
 * run ten shots in.
 */
let ready = false;
async function waitForApp() {
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 60000,
  });
  await page.evaluate(() => {
    const h = window.__THREE_GAME_TEST_HOOKS__;
    h?.setMode?.('solo');
    h?.setState?.('active-play');
    h?.hideRivals?.(true);
    for (const sel of ['#overlay-start', '#overlay-finish', '#hud', '#touch-controls']) {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'none';
    }
  });
  await page.waitForTimeout(400);
  ready = true;
}

async function run(fn, arg) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (err) {
      if (attempt === 3) throw err;
      ready = false;
      await waitForApp();
      await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true));
    }
  }
  throw new Error('unreachable');
}

await waitForApp();

// Freeze the simulation. Rendering keeps running with the parked camera, but
// the kart stops sliding out of frame while the screenshots are taken.
const pose = await run(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
  return { position: d.player.position, heading: d.player.heading ?? 0 };
});

const { x, z } = pose.position;
const heading = pose.heading;
// forward = (sin h, cos h) — the same convention Kart.syncTransform uses.
const fwd = [Math.sin(heading), 0, Math.cos(heading)];
const right = [Math.cos(heading), 0, -Math.sin(heading)];
/**
 * Body-relative offset -> world point. `u` is an absolute height, not an
 * offset from the kart origin — the kart sits at y = 0 and every interesting
 * part is between 0 and 1.2, so absolute is easier to reason about.
 */
function at(r, u, f) {
  return [
    x + right[0] * r + fwd[0] * f,
    u,
    z + right[2] * r + fwd[2] * f,
  ];
}

/*
 * Distances are deliberately tight. At the original ~4.6m orbit the kart
 * filled about a third of a 1280x720 frame and the detail work (splitter
 * lip, hood LED, canopy tint, diffuser fins) was invisible — which defeats
 * the point of a model-inspection shot. At 2.6m the kart's 2.35m length
 * spans roughly 80% of the frame height. The two `detail-*` angles go
 * closer still and aim at a sub-part rather than the hull centre.
 */
const angles = [
  { name: 'front-3q', pos: at(1.5, 0.95, 2.2), look: at(0, 0.5, 0) },
  { name: 'rear-3q', pos: at(-1.5, 1.05, -2.2), look: at(0, 0.5, 0) },
  { name: 'side', pos: at(2.6, 0.8, 0.1), look: at(0, 0.5, 0) },
  { name: 'top', pos: at(0.2, 3.0, 0.15), look: at(0, 0.5, 0) },
  { name: 'hero-low', pos: at(1.15, 0.5, 1.8), look: at(0, 0.45, 0) },
  // Sub-part shots: nose (splitter + headlights + halo) and cockpit (canopy
  // tint, helmet, roll hoop, wing struts).
  { name: 'detail-nose', pos: at(0.85, 0.72, 1.55), look: at(0, 0.44, 1.0) },
  { name: 'detail-cockpit', pos: at(1.25, 1.35, 1.15), look: at(0, 0.84, 0.02) },
  /*
   * The real chase rig, so the harness can answer "does any of this detail
   * survive the camera the player actually has?".
   *
   * CameraRig at race speed: distance = 7.2 + clamp(speed*0.06, 0, 2.4), height
   * = 2.35 + clamp(speed*0.01, 0, 0.5), and it looks at the car plus
   * (4.2 + speed*0.08) forward. At speed 40 that is 9.6 back, 2.75 up, aiming
   * 7.4 ahead. The free camera inherits whatever fov the rig last wrote
   * (58 + clamp((speed-8)*0.22, 0, 12) ~= 65 at speed 40), so this framing is
   * faithful rather than approximate.
   *
   * The answer, measured on the shot: the 1.2m-wide kart lands at roughly 5% of
   * a 1280px frame — about 60px. Silhouette and light signature read; nothing
   * smaller than about 5cm does.
   */
  { name: 'chase', pos: at(0, 2.75, -9.6), look: at(0, 0.85, 7.4) },
];

const liveries = ['neon-blue', 'crimson', 'gold', 'violet'];
const shots = [];

for (const livery of liveries) {
  await run((id) => window.__THREE_GAME_TEST_HOOKS__?.selectCar?.(id), livery);
  await page.waitForTimeout(150);
  for (const angle of angles) {
    await run(
      ({ pos, look }) => window.__THREE_GAME_TEST_HOOKS__?.placeCamera?.(pos, look),
      { pos: angle.pos, look: angle.look },
    );
    await page.waitForTimeout(120);
    const file = `${tag}-${livery}-${angle.name}.png`;
    await page.screenshot({ path: path.join(outDir, file) });
    shots.push(file);
  }
}

console.log(
  JSON.stringify(
    { ok: errors.length === 0, shots: shots.length, outDir, pose: { x, z, heading }, errors },
    null,
    2,
  ),
);
await browser.close();
