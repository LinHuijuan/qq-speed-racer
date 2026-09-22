/**
 * Slipstream regression.
 *
 * Two things were wrong and neither had any coverage:
 *
 *  1. The draft kick was never verified at all — there is no way to reach the
 *     draft window by driving in a headless run, so the hook places the kart
 *     behind the leader directly.
 *  2. The "尾流" toast sat in a per-frame branch and had no cooldown, so holding
 *     a draft appended a combo chip — and a pending setTimeout — on every
 *     single frame. Asserting on the kick alone would not have caught it, so
 *     the DOM churn is counted separately.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

/** Frames to hold each measurement. 1 frame == one clamped delta (0.05s). */
const A_B_FRAMES = 10;
const CHURN_FRAMES = 48;
const CHURN_REDRAFT_EVERY = 3;

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});

const result = await page.evaluate(
  async ({ aFrames, churnFrames, redraftEvery }) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const diag = () => window.__THREE_GAME_DIAGNOSTICS__;

    const advance = (n) =>
      new Promise((resolve) => {
        const from = diag().frame;
        const tick = () => {
          if (diag().frame - from >= n) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

    // --- A/B: identical race, the only difference is the draft position ---
    const run = async (withDraft) => {
      hooks.forceRace();
      if (withDraft) hooks.draftPlayer();
      await advance(2); // let the sim settle into the first real step
      const before = diag().player.speed;
      await advance(aFrames);
      return { before, after: diag().player.speed };
    };

    const baseline = await run(false);
    const drafted = await run(true);

    // --- DOM churn while the draft window is held open ---
    hooks.forceRace();
    hooks.draftPlayer();
    const stack = document.querySelector('#combo-stack');
    let chips = 0;
    const observer = new MutationObserver((records) => {
      for (const record of records) chips += record.addedNodes.length;
    });
    observer.observe(stack, { childList: true });

    const from = diag().frame;
    let frame = 0;
    await new Promise((resolve) => {
      const tick = () => {
        frame += 1;
        if (frame % redraftEvery === 0) hooks.draftPlayer();
        if (diag().frame - from >= churnFrames) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const simFrames = diag().frame - from;
    observer.disconnect();

    return { baseline, drafted, chips, simFrames };
  },
  { aFrames: A_B_FRAMES, churnFrames: CHURN_FRAMES, redraftEvery: CHURN_REDRAFT_EVERY },
);

await browser.close();

const baseGain = result.baseline.after - result.baseline.before;
const draftGain = result.drafted.after - result.drafted.before;
// A draft held for ~1.6s of sim time may legitimately fire twice; anything
// near one-per-frame is the bug.
const chipBudget = Math.ceil((result.simFrames * 0.05) / 1.6) + 1;

console.log('=== slipstream check ===');
console.log(
  `coasting  : ${result.baseline.before.toFixed(2)} -> ${result.baseline.after.toFixed(2)}  (${baseGain >= 0 ? '+' : ''}${baseGain.toFixed(2)})`,
);
console.log(
  `drafting  : ${result.drafted.before.toFixed(2)} -> ${result.drafted.after.toFixed(2)}  (${draftGain >= 0 ? '+' : ''}${draftGain.toFixed(2)})`,
);
console.log(
  `combo chips appended over ${result.simFrames} frames of continuous drafting: ${result.chips} (budget ${chipBudget})`,
);
console.log(`console errors: ${errors.length}`);

const checks = {
  draftKicksHarderThanCoasting: draftGain > baseGain + 1,
  toastIsRateLimited: result.chips <= chipBudget,
  noConsoleErrors: errors.length === 0,
};
console.log(JSON.stringify(checks, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log('pass:', pass);
if (!pass) process.exitCode = 1;
