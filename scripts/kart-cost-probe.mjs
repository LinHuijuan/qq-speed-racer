/**
 * Draw-call / triangle cost of the kart model. The beautify pass added four
 * meshes per kart (hood LED, side-skirt underglow, headlight halos, wheel glow
 * rings), and each new mesh is a new draw call because parts are merged per
 * material. This measures whether that is affordable.
 *
 *   node scripts/kart-cost-probe.mjs [url]
 *
 * Reports a solo race (P1 + 3 AI = 4 karts) and a duo race (P1 + P2 + 2 AI),
 * each with the free camera parked away from the field so the numbers are the
 * scene total rather than a frustum-culled subset.
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
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

/** `measureDrawCalls` renders once with the composer bypassed, so it reports
 *  the real scene cost rather than the final fullscreen quad. */
async function measure(mode) {
  await page.evaluate((m) => {
    const h = window.__THREE_GAME_TEST_HOOKS__;
    h?.setMode?.(m);
    h?.setState?.('active-play');
    h?.setPausedForScreenshot?.(true);
  }, mode);
  await page.waitForTimeout(400);
  const geo = await page.evaluate(() => {
    // Two views: the chase camera (what players see) and a wide shot with the
    // whole field in frustum, so culling cannot flatter the result.
    const h = window.__THREE_GAME_TEST_HOOKS__;
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    const p = d.player.position;
    h.placeCamera([p.x + 18, 12, p.z + 18], [p.x, 0.5, p.z]);
    return { chase: h.measureDrawCalls(), lights: d.renderer?.lights, programs: d.renderer?.programs };
  });
  return { mode, ...geo };
}

const solo = await measure('solo');
const duo = await measure('duo');
console.log(JSON.stringify({ solo, duo }, null, 2));
await browser.close();
