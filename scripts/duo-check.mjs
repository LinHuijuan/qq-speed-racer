import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = process.argv[3] ?? 'artifacts/duo-check';
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

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5, null, {
  timeout: 20000,
});

// Duo mode via hook (overlay-independent)
const modeAck = await page.evaluate(() => {
  const hooks = window.__THREE_GAME_TEST_HOOKS__;
  if (!hooks?.setMode) throw new Error('setMode hook missing');
  return hooks.setMode('duo');
});
await page.waitForTimeout(200);
const duoVisible = await page.evaluate(() => {
  const el = document.querySelector('#duo-panel');
  return !!el && window.getComputedStyle(el).display !== 'none';
});

await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(false);
  window.__THREE_GAME_TEST_HOOKS__?.setReducedMotion(false);
});
// Force-hide overlays in case race already started
await page.evaluate(() => {
  for (const sel of ['#overlay-start', '#overlay-finish']) {
    const el = document.querySelector(sel);
    if (el) {
      el.classList.remove('visible');
      el.style.display = 'none';
    }
  }
});

const before = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return {
    mode: d?.mode,
    p1: d?.player ? { x: d.player.position.x, z: d.player.position.z, speed: d.player.speed } : null,
    p2: d?.player2 ? { x: d.player2.position.x, z: d.player2.position.z, speed: d.player2.speed } : null,
  };
});

await page.locator('#game-canvas').click({ position: { x: 20, y: 20 } });
await page.keyboard.down('KeyW');
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(3000);
await page.keyboard.up('KeyW');
await page.keyboard.up('ArrowUp');

const after = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  return {
    mode: d?.mode,
    phase: d?.phase,
    p1: d?.player ? { x: d.player.position.x, z: d.player.position.z, speed: d.player.speed } : null,
    p2: d?.player2 ? { x: d.player2.position.x, z: d.player2.position.z, speed: d.player2.speed } : null,
  };
});

const shot = await page.screenshot({ fullPage: true });
await writeFile(path.join(outDir, 'duo-race.png'), shot);

// Solo regression
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setMode?.('solo');
  window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
  for (const sel of ['#overlay-start', '#overlay-finish']) {
    const el = document.querySelector(sel);
    if (el) {
      el.classList.remove('visible');
      el.style.display = 'none';
    }
  }
});
await page.waitForTimeout(350);
const soloShot = await page.screenshot({ fullPage: true });
await writeFile(path.join(outDir, 'solo-race.png'), soloShot);

const p1Moved =
  before.p1 && after.p1 ? Math.hypot(after.p1.x - before.p1.x, after.p1.z - before.p1.z) : 0;
const p2Moved =
  before.p2 && after.p2 ? Math.hypot(after.p2.x - before.p2.x, after.p2.z - before.p2.z) : 0;

const report = {
  modeAck,
  duoPanelVisible: duoVisible,
  before,
  after,
  p1Moved: Number(p1Moved.toFixed(3)),
  p2Moved: Number(p2Moved.toFixed(3)),
  errors,
};
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();

const failed =
  errors.length > 0 ||
  !duoVisible ||
  after.mode !== 'duo' ||
  !after.p2 ||
  p1Moved < 0.4 ||
  p2Moved < 0.4;
if (failed) process.exitCode = 1;
