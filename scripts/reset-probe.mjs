/**
 * Focused probe: what does the reset-to-track button actually do?
 *
 * The interaction test showed `offTrack` still true 3 frames after a reset,
 * even though the kart only travelled ~2 units and the track half-width is 7.5.
 * This dumps every frame around the reset so the cause is observed, not guessed.
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
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

const frameOf = () => page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);
const waitFrames = async (n) => {
  const start = await frameOf();
  await page.waitForFunction(
    (t) => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) >= t,
    start + n,
    { timeout: 240000 },
  );
};
const snap = () =>
  page.evaluate(() => {
    const d = window.__THREE_GAME_DIAGNOSTICS__;
    const p = d.player;
    return {
      frame: d.frame,
      progress: Number(p.progress.toFixed(4)),
      x: Number(p.position.x.toFixed(2)),
      z: Number(p.position.z.toFixed(2)),
      speed: Number(p.speed.toFixed(2)),
      heading: Number(p.heading.toFixed(3)),
      offTrack: p.offTrack,
      drifting: p.drifting,
    };
  });

// Drive off track using the keyboard (same input.reset path as the touch button).
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
await waitFrames(2);

await page.keyboard.down('KeyW');
await page.keyboard.down('KeyD');
const trail = [];
for (let i = 0; i < 25; i += 1) {
  await waitFrames(1);
  const s = await snap();
  trail.push(s);
  if (s.offTrack && i > 4) break;
}
await page.keyboard.up('KeyD');
await page.keyboard.up('KeyW');

const beforeReset = await snap();

// Tap R and watch the next 6 frames closely.
await page.keyboard.press('KeyR');
const afterReset = [];
for (let i = 0; i < 6; i += 1) {
  await waitFrames(1);
  afterReset.push(await snap());
}

console.log(
  JSON.stringify({ approach: trail, beforeReset, afterReset }, null, 2),
);

await browser.close();
