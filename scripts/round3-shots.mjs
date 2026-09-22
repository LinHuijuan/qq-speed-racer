/**
 * Screenshot pass for the round-3 UI changes:
 *  - the new settings block on the start panel (desktop + phone)
 *  - the relocated off-track toast, forced visible
 *  - duo split screen with the HUD
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/round3';
mkdirSync(outDir, { recursive: true });

const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

async function shoot(name, viewport, setup) {
  const ctx = await browser.newContext({
    viewport,
    hasTouch: viewport.width < 900,
    isMobile: viewport.width < 900,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 90000,
  });
  if (setup) await setup(page);
  // The toast fades in over 0.2s; shooting immediately captures it mid-fade.
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`${outDir}/${name}.png`);
  await ctx.close();
}

const showToast = (page) =>
  page.evaluate(() => {
    // Freeze the sim first: updateOffTrackHelp() re-derives the class every
    // frame and would strip it again before the screenshot lands.
    window.__THREE_GAME_TEST_HOOKS__.setPausedForScreenshot(true);
    const el = document.querySelector('#offtrack-help');
    // Under headless + SwiftShader `document.timeline` never advances, so every
    // CSS transition is stuck at its start value — the toast would still be at
    // opacity 0 when the shot is taken. Drop the transition to capture the
    // settled state a real browser reaches after 200ms.
    el.style.transition = 'none';
    el.classList.add('visible');
  });

await shoot('01-menu-desktop', { width: 1280, height: 720 });
await shoot('02-menu-phone', { width: 390, height: 844 });
await shoot('03-race-desktop', { width: 1280, height: 720 }, async (page) => {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
  await showToast(page);
});
await shoot('04-race-phone', { width: 390, height: 844 }, async (page) => {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
  await showToast(page);
});
await shoot('05-race-landscape', { width: 844, height: 390 }, async (page) => {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
  await showToast(page);
});
await shoot('06-duo-desktop', { width: 1280, height: 720 }, async (page) => {
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setMode('duo');
    window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
  });
});
await shoot('07-finish', { width: 1280, height: 720 }, async (page) => {
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('complete'));
});
await shoot('08-pause-phone', { width: 390, height: 844 }, async (page) => {
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
    // setState resets to the menu chrome; the in-race buttons are hidden there.
    document.querySelector('#pause-fab').classList.remove('hidden-ctl');
  });
  await page.click('#pause-fab');
  await page.waitForTimeout(600);
});

await browser.close();
