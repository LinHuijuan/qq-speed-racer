import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = process.argv[3] ?? 'artifacts/flow-check';
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

const steps = [];

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 5, null, {
  timeout: 20000,
});
steps.push({ name: 'load', ok: true });

// 1) Menu visible
const startVisible = await page.locator('#start-button').isVisible();
steps.push({ name: 'menu-start-visible', ok: startVisible });

// 2) Select duo, start race via UI
await page.click('#mode-duo');
await page.waitForTimeout(200);
await page.click('#start-button');
await page.waitForTimeout(600);
const afterStart = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.phase);
steps.push({ name: 'start-race-phase', ok: afterStart === 'countdown' || afterStart === 'racing', value: afterStart });

// Force racing for deterministic headless timing
const forced = await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
steps.push({ name: 'force-racing', ok: forced?.phase === 'racing', value: forced });
await page.waitForTimeout(100);
const racingPhase = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.phase);
steps.push({ name: 'countdown-to-racing', ok: racingPhase === 'racing', value: racingPhase });

// Drive a bit
await page.keyboard.down('KeyW');
await page.keyboard.down('ArrowUp');
await page.waitForTimeout(1200);
await page.keyboard.up('KeyW');
await page.keyboard.up('ArrowUp');

// 3) Force complete state
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setState('complete');
});
await page.waitForTimeout(400);
const finishVisible = await page.locator('#overlay-finish').evaluate((el) => {
  return window.getComputedStyle(el).display !== 'none' && el.classList.contains('visible');
});
const finishTitle = await page.locator('#finish-title').textContent();
steps.push({ name: 'finish-overlay', ok: finishVisible, value: finishTitle });
await page.screenshot({ path: path.join(outDir, 'finish-duo.png'), fullPage: true });

// 4) Restart keeps duo
await page.click('#restart-button');
await page.waitForTimeout(800);
const afterRestart = await page.evaluate(() => ({
  phase: window.__THREE_GAME_DIAGNOSTICS__?.phase,
  mode: window.__THREE_GAME_DIAGNOSTICS__?.mode,
  duoPanel: !!document.querySelector('#duo-panel') && window.getComputedStyle(document.querySelector('#duo-panel')).display !== 'none',
}));
steps.push({
  name: 'restart-duo',
  ok:
    afterRestart.mode === 'duo' &&
    (afterRestart.phase === 'countdown' || afterRestart.phase === 'racing' || afterRestart.phase === 'menu'),
  value: afterRestart,
});

// Ensure racing after restart via forceRace as well
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await page.waitForTimeout(150);
const restartRacing = await page.evaluate(() => ({
  phase: window.__THREE_GAME_DIAGNOSTICS__?.phase,
  mode: window.__THREE_GAME_DIAGNOSTICS__?.mode,
}));
steps.push({
  name: 'restart-force-racing',
  ok: restartRacing.phase === 'racing' && restartRacing.mode === 'duo',
  value: restartRacing,
});

// 5) Switch solo mid-menu after forcing menu
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setMode?.('solo');
  window.__THREE_GAME_TEST_HOOKS__?.setState('menu');
});
await page.waitForTimeout(300);
const soloMenu = await page.evaluate(() => ({
  mode: window.__THREE_GAME_DIAGNOSTICS__?.mode,
  startVisible: !!document.querySelector('#overlay-start') && window.getComputedStyle(document.querySelector('#overlay-start')).display !== 'none',
}));
steps.push({ name: 'solo-menu', ok: soloMenu.mode === 'solo' && soloMenu.startVisible, value: soloMenu });
await page.screenshot({ path: path.join(outDir, 'solo-menu.png'), fullPage: true });

// 6) Solo active play nonblank
await page.evaluate(() => {
  window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
  window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
});
await page.waitForTimeout(300);
const canvasShot = await page.locator('#game-canvas').screenshot();
const hasPixels = canvasShot.length > 1000;
steps.push({ name: 'solo-canvas', ok: hasPixels, value: canvasShot.length });

const report = { steps, errors, allOk: steps.every((s) => s.ok) && errors.length === 0 };
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (!report.allOk) process.exitCode = 1;
