import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = process.argv[3] ?? 'artifacts/tracks';
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

const buttons = await page.locator('.track-btn').count();
const results = [];
const ids = ['neon', 'hairpin', 'harbor', 'mountain'];

for (const id of ids) {
  await page.evaluate((tid) => {
    window.__THREE_GAME_TEST_HOOKS__?.setTrack?.(tid);
    window.__THREE_GAME_TEST_HOOKS__?.setState('active-play');
    window.__THREE_GAME_TEST_HOOKS__?.setPausedForScreenshot(true);
    const start = document.querySelector('#overlay-start');
    const finish = document.querySelector('#overlay-finish');
    if (start) {
      start.classList.remove('visible');
      start.style.display = 'none';
    }
    if (finish) {
      finish.classList.remove('visible');
      finish.style.display = 'none';
    }
  }, id);
  await page.waitForTimeout(350);
  const diag = await page.evaluate(() => ({
    track: window.__THREE_GAME_DIAGNOSTICS__?.track,
    phase: window.__THREE_GAME_DIAGNOSTICS__?.phase,
    x: window.__THREE_GAME_DIAGNOSTICS__?.player?.position.x,
    z: window.__THREE_GAME_DIAGNOSTICS__?.player?.position.z,
  }));
  await page.screenshot({ path: path.join(outDir, `${id}.png`), fullPage: true });
  results.push({ id, diag });
}

const report = { buttons, results, errors, allOk: buttons >= 4 && errors.length === 0 };
await writeFile(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
await browser.close();
if (!report.allOk) process.exitCode = 1;
