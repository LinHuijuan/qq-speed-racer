import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = process.argv[3] ?? 'artifacts/bug-hunt';
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
const warnings = [];
page.on('pageerror', (e) => errors.push('PAGE: ' + String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('CON: ' + m.text());
  if (m.type() === 'warning') warnings.push(m.text());
});

const issues = [];
const ok = (name, cond, extra) => {
  if (!cond) issues.push({ name, extra });
  return cond;
};

await page.goto(url, { waitUntil: 'networkidle', timeout: 25000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 3, null, {
  timeout: 25000,
});

// 1) Menu buttons exist
ok('start-btn', await page.locator('#start-button').isVisible());
ok('mode-solo', await page.locator('#mode-solo').isVisible());
ok('mode-duo', await page.locator('#mode-duo').isVisible());
ok('track-btns', (await page.locator('.track-btn').count()) >= 4);
ok('reset-btn', await page.locator('#reset-button').count() === 1);

const waitFrames = async (n = 3, timeout = 25000) => {
  const start = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);
  const target = start + n;
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const f = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);
    if (f >= target) return;
    await page.waitForTimeout(80);
  }
};

// 2) Solo force race + W moves forward
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setMode?.('solo');
  window.__THREE_GAME_TEST_HOOKS__?.forceRace?.();
});
await waitFrames(2);
await page.locator('#game-canvas').click({ position: { x: 30, y: 30 } });
const p0 = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return { x: d?.player?.position.x, z: d?.player?.position.z, h: d?.player?.heading };
});
await page.keyboard.down('KeyW');
await waitFrames(4);
const p1 = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return { x: d?.player?.position.x, z: d?.player?.position.z, speed: d?.player?.speed };
});
await page.keyboard.up('KeyW');
ok('w-moves', Math.hypot(p1.x - p0.x, p1.z - p0.z) > 0.2, { p0, p1 });

// 3) Steering: hold W+A (left) vs W+D (right) — check heading delta sign
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await waitFrames(2);
const h0 = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player?.heading ?? 0);
await page.keyboard.down('KeyW');
await page.keyboard.down('KeyA');
await waitFrames(4);
await page.keyboard.up('KeyA');
const hLeft = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player?.heading ?? 0);
await page.keyboard.up('KeyW');

await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await waitFrames(2);
const h1 = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player?.heading ?? 0);
await page.keyboard.down('KeyW');
await page.keyboard.down('KeyD');
await waitFrames(4);
await page.keyboard.up('KeyD');
const hRight = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player?.heading ?? 0);
await page.keyboard.up('KeyW');

// Normalize heading deltas
const wrap = (a, b) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};
const dLeft = wrap(h0, hLeft);
const dRight = wrap(h1, hRight);
ok('steer-differs', Math.abs(dLeft - dRight) > 0.05, { dLeft, dRight });

// 4) Reset to track: teleport off, press R
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.forceRace?.();
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  // push far off via evaluate on game internals is not exposed; use offTrack by steering hard
});
// Drive hard to go off, then reset
await page.keyboard.down('KeyW');
await page.keyboard.down('KeyA');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyA');
const off = await page.evaluate(() => {
  // We can't read offTrack from diagnostics; check help toast class after delay
  return null;
});
await page.keyboard.press('KeyR');
await page.waitForTimeout(200);
const afterReset = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__?.player;
  return { x: d?.position.x, z: d?.position.z, speed: d?.speed };
});
ok('reset-keeps-speed', (afterReset.speed ?? 0) > 0, afterReset);
await page.keyboard.up('KeyW');

// 5) All 4 tracks switch without errors
for (const id of ['neon', 'hairpin', 'harbor', 'mountain']) {
  await page.evaluate((tid) => {
    window.__THREE_GAME_TEST_HOOKS__?.setTrack?.(tid);
    window.__THREE_GAME_TEST_HOOKS__?.setState?.('active-play');
  }, id);
  await page.waitForTimeout(150);
  const t = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.track);
  ok(`track-${id}`, t === id, { got: t });
}

// 6) Duo simultaneous input
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setMode?.('duo');
  window.__THREE_GAME_TEST_HOOKS__?.forceRace?.();
});
await waitFrames(2);
const d0 = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return {
    p1: d?.player ? { x: d.player.position.x, z: d.player.position.z } : null,
    p2: d?.player2 ? { x: d.player2.position.x, z: d.player2.position.z } : null,
  };
});
await page.keyboard.down('KeyW');
await page.keyboard.down('ArrowUp');
await waitFrames(4);
await page.keyboard.up('KeyW');
await page.keyboard.up('ArrowUp');
const d1 = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return {
    p1: d?.player ? { x: d.player.position.x, z: d.player.position.z } : null,
    p2: d?.player2 ? { x: d.player2.position.x, z: d.player2.position.z } : null,
  };
});
ok(
  'duo-both-move',
  d0.p1 && d1.p1 && d0.p2 && d1.p2 &&
    Math.hypot(d1.p1.x - d0.p1.x, d1.p1.z - d0.p1.z) > 0.15 &&
    Math.hypot(d1.p2.x - d0.p2.x, d1.p2.z - d0.p2.z) > 0.15,
  { d0, d1 },
);

// 7) Finish + restart
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState?.('complete'));
await page.waitForTimeout(200);
ok('finish-visible', await page.locator('#overlay-finish.visible').count() === 1);
await page.click('#restart-button');
await page.waitForTimeout(400);
const afterRestart = await page.evaluate(() => ({
  mode: window.__THREE_GAME_DIAGNOSTICS__?.mode,
  phase: window.__THREE_GAME_DIAGNOSTICS__?.phase,
}));
ok('restart-duo-kept', afterRestart.mode === 'duo', afterRestart);

// 8) Track name chip
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setTrack?.('harbor'));
await page.waitForTimeout(150);
const trackName = await page.locator('#track-name').textContent();
ok('track-name', trackName?.includes('港口'), { trackName });

// 9) Combo stack element exists
ok('combo-stack', (await page.locator('#combo-stack').count()) === 1);
ok('center-banner', (await page.locator('#center-banner').count()) === 1);
ok('offtrack-help', (await page.locator('#offtrack-help').count()) === 1);

// 10) No NaN in player position
const posOk = await page.evaluate(() => {
  const p = window.__THREE_GAME_DIAGNOSTICS__?.player?.position;
  return p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
});
ok('finite-pos', !!posOk);

await page.screenshot({ path: path.join(outDir, 'final.png'), fullPage: true });

const report = {
  issues,
  errors: errors.slice(0, 30),
  warnings: warnings.slice(0, 10),
  steering: { dLeft, dRight },
  allOk: issues.length === 0 && errors.length === 0,
};
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (!report.allOk) process.exitCode = 1;
