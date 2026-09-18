/**
 * Covers the two player-facing paths that were never exercised: the on-screen
 * touch controls (joystick + drift/nitro/item/reset buttons, multi-touch) and
 * the pause -> save -> continue flow.
 *
 * Two environment quirks drive the design:
 *   1. SwiftShader renders at ~3fps, so every wait is expressed in rendered
 *      frames (each frame advances at most 0.05s of simulated time).
 *   2. InputController binds *pointer* events, not touch events. A probe is
 *      installed first so we can prove whether CDP-synthesised touches actually
 *      reach those handlers, instead of inferring it from gameplay side effects.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/interaction-check';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const SELECTORS = [
  '#touch-stick',
  '#drift-button',
  '#nitro-button',
  '#item-button',
  '#reset-button',
];

const readState = (page) =>
  page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    const p = d?.player;
    const continueEl = document.querySelector('#continue-button');
    return {
      frame: d?.frame ?? 0,
      raceTime: Number((d?.raceTime ?? 0).toFixed(3)),
      phase: d?.phase ?? null,
      x: Number((p?.position.x ?? 0).toFixed(2)),
      z: Number((p?.position.z ?? 0).toFixed(2)),
      heading: Number((p?.heading ?? 0).toFixed(4)),
      speed: Number((p?.speed ?? 0).toFixed(2)),
      nitro: Number((p?.nitro ?? 0).toFixed(3)),
      progress: Number((p?.progress ?? 0).toFixed(4)),
      drifting: p?.drifting ?? false,
      boosting: p?.boosting ?? false,
      offTrack: p?.offTrack ?? false,
      hasItem: !!document.querySelector('#item-slot.has-item'),
      pipsOn: document.querySelectorAll('#drift-pip-1.on, #drift-pip-2.on, #drift-pip-3.on')
        .length,
      pauseVisible: !!document.querySelector('#overlay-pause.visible'),
      continueVisible: continueEl ? getComputedStyle(continueEl).display !== 'none' : false,
    };
  });

const frameOf = (page) =>
  page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);

/** Waits for `count` *rendered* frames — wall clock is meaningless at 3fps. */
const waitFrames = async (page, count) => {
  const start = await frameOf(page);
  await page.waitForFunction(
    (target) => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) >= target,
    start + count,
    { timeout: 240000 },
  );
};

/**
 * Advances frames until `predicate(state)` holds. Returns the state either way
 * plus how many frames it took, so a timeout is reported as "did not happen"
 * rather than silently passing.
 */
const waitUntilState = async (page, predicate, maxFrames) => {
  let last = await readState(page);
  for (let i = 0; i < maxFrames; i += 1) {
    if (predicate(last)) return { reached: true, frames: i, state: last };
    await waitFrames(page, 1);
    last = await readState(page);
  }
  return { reached: predicate(last), frames: maxFrames, state: last };
};

// ---------------------------------------------------------------- touch input
const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});
const mp = await mobile.newPage();
const touchErrors = [];
mp.on('pageerror', (e) => touchErrors.push(String(e)));
mp.on('console', (m) => {
  if (m.type() === 'error') touchErrors.push(m.text());
});

await mp.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await mp.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

// Probe: count the pointer events each control actually receives.
await mp.evaluate((selectors) => {
  const probe = { down: 0, move: 0, up: 0, perControl: {} };
  window.__POINTER_PROBE__ = probe;
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    probe.perControl[sel] = { down: 0, move: 0, up: 0 };
    if (!el) continue;
    el.addEventListener('pointerdown', () => {
      probe.down += 1;
      probe.perControl[sel].down += 1;
    });
    el.addEventListener('pointermove', () => {
      probe.move += 1;
      probe.perControl[sel].move += 1;
    });
    el.addEventListener('pointerup', () => {
      probe.up += 1;
      probe.perControl[sel].up += 1;
    });
  }
}, SELECTORS);

const touch = {};
touch.layout = await mp.evaluate((selectors) => {
  const controls = document.querySelector('#touch-controls');
  const box = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), visible: r.width > 0 && r.height > 0 };
  };
  const out = { controlsDisplay: controls ? getComputedStyle(controls).display : 'missing' };
  for (const sel of selectors) out[sel] = box(sel);
  return out;
}, SELECTORS);

const center = async (sel) => {
  const b = await mp.locator(sel).boundingBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2, r: b.width * 0.42 };
};

const stick = await center('#touch-stick');
const driftBtn = await center('#drift-button');
const nitroBtn = await center('#nitro-button');
const itemBtn = await center('#item-button');
const resetBtn = await center('#reset-button');

const cdp = await mobile.newCDPSession(mp);
const point = (p, id) => ({ x: p.x, y: p.y, id, radiusX: 10, radiusY: 10, force: 1 });

/**
 * Gesture helpers. The event type is stated explicitly rather than inferred
 * from the point count: a gesture that moves an existing touch onto a *different
 * control* keeps the same count, and inferring would send touchMove — the
 * control would never see a pointerdown.
 */
const releaseAll = () =>
  cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const touchStart = (points) =>
  cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points });
const touchMove = (points) =>
  cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points });

// 1. Joystick throttle, measured against a coasting control run.
//    Driving with no steering leaves the road on the first corner, so the window
//    is kept short and the comparison is throttle-vs-coast rather than a raw
//    before/after speed reading.
await mp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.forceRace());
await waitFrames(mp, 6);
touch.coast = await readState(mp);

await mp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.forceRace());
await waitFrames(mp, 2);
touch.beforeThrottle = await readState(mp);
await touchStart([point({ x: stick.x, y: stick.y }, 1)]);
await touchMove([point({ x: stick.x, y: stick.y - stick.r }, 1)]);
await waitFrames(mp, 6);
touch.afterThrottle = await readState(mp);

// 2. Joystick steering — same gesture, pushed right instead of up.
await touchMove([point({ x: stick.x + stick.r, y: stick.y }, 1)]);
await waitFrames(mp, 8);
touch.afterSteer = await readState(mp);
await releaseAll();

// 3. Drift button — needs throttle + steer held simultaneously.
await mp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await waitFrames(mp, 2);
const diagonal = { x: stick.x + stick.r * 0.7, y: stick.y - stick.r * 0.7 };
await touchStart([point(diagonal, 1)]);
await waitFrames(mp, 3);
touch.beforeDrift = await readState(mp);
await touchStart([point(diagonal, 1), point(driftBtn, 2)]);
await waitFrames(mp, 4);
touch.whileDrift = await readState(mp);
// Charge build-up is a separate concern: it depends on drift angle and duration,
// so it is polled rather than sampled at a fixed frame.
touch.driftCharge = await waitUntilState(mp, (s) => s.pipsOn > 0 || !s.drifting, 20);

// 4. Nitro button as a third simultaneous touch, drift still held. State is reset
//    first so the boost is measured from a known speed and nitro level.
await mp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await waitFrames(mp, 2);
await touchStart([point(diagonal, 1), point(driftBtn, 2)]);
await waitFrames(mp, 3);
touch.beforeNitro = await readState(mp);
await touchStart([point(diagonal, 1), point(driftBtn, 2), point(nitroBtn, 3)]);
await waitFrames(mp, 5);
touch.whileNitro = await readState(mp);
await releaseAll();

// 5. Item pickup + fire. Boxes sit at randomised lateral offsets, so the item is
//    granted through the test hook and the touch button is what's under test.
await mp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await mp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.grantItem('turbo'));
await waitFrames(mp, 2);
touch.afterDrive = await readState(mp);
await touchStart([point({ x: stick.x, y: stick.y - stick.r }, 1)]);
await touchStart([point({ x: stick.x, y: stick.y - stick.r }, 1), point(itemBtn, 2)]);
await waitFrames(mp, 4);
touch.afterItemFire = await readState(mp);
await releaseAll();

// 6. Reset-to-track. Steer hard until the kart leaves the surface, then tap R.
//    Every previous touch is released first so the tap registers as a fresh
//    touchStart on the button.
await mp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await touchStart([point({ x: stick.x + stick.r, y: stick.y - stick.r }, 1)]);
touch.offTrackRun = await waitUntilState(mp, (s) => s.offTrack, 60);
touch.beforeReset = touch.offTrackRun.state;
await releaseAll();
await waitFrames(mp, 1);
await touchStart([point(resetBtn, 1)]);
await waitFrames(mp, 3);
touch.afterReset = await readState(mp);
await releaseAll();

touch.pointerProbe = await mp.evaluate(() => window.__POINTER_PROBE__);
touch.errors = touchErrors;
await mp.screenshot({ path: path.join(outDir, 'mobile.png') });
await mobile.close();

// ------------------------------------------------------------- pause/continue
const desktop = await browser.newContext({ viewport: { width: 800, height: 450 } });
const dp = await desktop.newPage();
const pauseErrors = [];
dp.on('pageerror', (e) => pauseErrors.push(String(e)));
dp.on('console', (m) => {
  if (m.type() === 'error') pauseErrors.push(m.text());
});

await dp.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await dp.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

const pause = {};
// Start from a mid-race state (raceTime 18.5) so "restored" is distinguishable
// from "a fresh race that happens to be near zero".
await dp.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await waitFrames(dp, 6);
pause.beforePause = await readState(dp);

// Escape pauses and persists the race
await dp.keyboard.press('Escape');
await waitFrames(dp, 1);
pause.afterEscape = await readState(dp);
pause.saved = await dp.evaluate(() => {
  const raw = localStorage.getItem('neon-rush-race-save');
  if (!raw) return null;
  const s = JSON.parse(raw);
  return {
    phase: s.phase,
    raceTime: Number(s.raceTime.toFixed(3)),
    lap: s.player1.lap,
    speed: Number(s.player1.speed.toFixed(2)),
  };
});

// Clock must be frozen while paused
await waitFrames(dp, 4);
pause.whilePaused = await readState(dp);
pause.frozenWhilePaused = pause.whilePaused.raceTime === pause.afterEscape.raceTime;

// Resume
await dp.locator('#resume-button').click();
await waitFrames(dp, 4);
pause.afterResume = await readState(dp);

// Pause again, then return to menu
await dp.keyboard.press('Escape');
await waitFrames(dp, 1);
await dp.locator('#pause-menu-button').click();
await waitFrames(dp, 2);
pause.backToMenu = await readState(dp);

// Continue from the menu
await dp.locator('#continue-button').click();
await waitFrames(dp, 4);
pause.afterContinue = await readState(dp);

pause.errors = pauseErrors;
await dp.screenshot({ path: path.join(outDir, 'desktop.png') });
await desktop.close();

const report = { touch, pause };
const probe = touch.pointerProbe;
report.checks = {
  // --- touch controls ---
  touchControlsRendered: touch.layout.controlsDisplay === 'flex',
  touchControlsSized: SELECTORS.every((s) => touch.layout[s]?.visible),
  touchReachesHandlers: probe.down > 0 && probe.perControl['#touch-stick'].down > 0,
  everyControlTouched: SELECTORS.every((s) => probe.perControl[s].down > 0),
  joystickThrottle: touch.afterThrottle.speed > touch.coast.speed + 1,
  joystickSteer: Math.abs(touch.afterSteer.heading - touch.afterThrottle.heading) > 0.05,
  driftNotAlreadyActive: touch.beforeDrift.drifting === false,
  driftButton: touch.whileDrift.drifting === true,
  driftChargeLightsPip: touch.driftCharge.state.pipsOn > 0,
  nitroButton: touch.whileNitro.boosting === true && touch.beforeNitro.boosting === false,
  itemGranted: touch.afterDrive.hasItem,
  itemFire: touch.afterDrive.hasItem && !touch.afterItemFire.hasItem,
  resetGotOffTrack: touch.offTrackRun.reached && touch.beforeReset.offTrack === true,
  resetButton: touch.afterReset.offTrack === false,
  noTouchErrors: touchErrors.length === 0,
  // --- pause / continue ---
  pauseOverlay: pause.afterEscape.pauseVisible,
  pauseFrozeClock: pause.frozenWhilePaused,
  saveWritten: !!pause.saved && pause.saved.phase === 'racing',
  saveMatchesClock: !!pause.saved && Math.abs(pause.saved.raceTime - pause.afterEscape.raceTime) < 0.05,
  resumeWorks: !pause.afterResume.pauseVisible && pause.afterResume.raceTime > pause.afterEscape.raceTime,
  continueOffered: pause.backToMenu.continueVisible,
  menuResetClock: pause.backToMenu.raceTime < 1,
  continueRestored: pause.afterContinue.raceTime >= (pause.saved?.raceTime ?? Infinity),
  noPauseErrors: pauseErrors.length === 0,
};
report.pass = Object.values(report.checks).every(Boolean);

await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
if (!report.pass) process.exitCode = 1;
