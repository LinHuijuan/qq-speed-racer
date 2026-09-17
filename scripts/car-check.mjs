import { chromium } from '@playwright/test';

const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errs.push(m.text());
});

await page.goto('http://127.0.0.1:5190', { waitUntil: 'networkidle', timeout: 25000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 3, null, {
  timeout: 25000,
});

const cars = await page.locator('.car-btn').count();
await page.locator('.car-btn[data-car-id="crimson"]').click();
await page.waitForTimeout(400);
const active = await page.locator('.car-btn.active').getAttribute('data-car-id');
const saved = await page.evaluate(
  () => JSON.parse(localStorage.getItem('neon-rush-settings') || '{}').carId,
);
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await page.waitForTimeout(500);
await page.screenshot({ path: 'artifacts/car-picker.png', fullPage: true });

console.log(JSON.stringify({ cars, active, saved, errs }, null, 2));
await browser.close();
if (cars !== 4 || active !== 'crimson' || saved !== 'crimson' || errs.length) {
  process.exitCode = 1;
}
