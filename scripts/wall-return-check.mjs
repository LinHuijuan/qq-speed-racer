/**
 * Hitting a barrier must spit the kart back onto the road by itself.
 *
 * What the wall used to do: clamp the kart to the barrier line, reverse its
 * lateral speed, and then multiply its speed by 0.86 **once per rendered
 * frame**. That last part compounds 60×/s, so one touch took the kart from top
 * speed to a crawl in about half a second — and it was frame-rate dependent,
 * costing half as much at 30 fps. The kart was left sitting in the runoff
 * pressed against the wall with no speed and no way back on the road except
 * steering out or pressing R.
 *
 * What it does now:
 *   - the speed cost is `exp(-wallDrag * delta)`, i.e. per *second*, so it is
 *     frame-rate independent and a bounce is survivable;
 *   - once the kart touches the barrier band it is slid back toward the
 *     centreline at a fixed speed, which reads as the barrier spitting it out.
 *
 * Observable contract: drive into the barrier, stop steering, keep the
 * throttle. The kart must end up back on the asphalt on its own, still moving.
 * Everything runs through `stepSim`, which calls the real `update(1/60, …)` —
 * see the hook's comment for why wall-clock frames cannot be used here.
 *
 *   node scripts/wall-return-check.mjs [url]
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });

const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
await page.waitForFunction(() => window.__THREE_GAME_DIAGNOSTICS__?.phase === 'racing', null, {
  timeout: 30000,
});

const stepSim = (frames) =>
  page.evaluate((n) => window.__THREE_GAME_TEST_HOOKS__.stepSim(n), frames);
const sample = () =>
  page.evaluate(() => {
    const p = window.__THREE_GAME_DIAGNOSTICS__.player;
    return {
      lateral: p.lateral,
      roadHalfWidth: p.roadHalfWidth,
      speed: p.speed,
      offTrack: p.offTrack,
    };
  });

const CHUNK = 3;
const barrierBand = (s) => s.roadHalfWidth + 0.35;

// --- Phase 1: steer into the left barrier with the throttle held ------------
await page.keyboard.down('KeyW');
await page.keyboard.down('KeyA');

let maxLateral = 0;
let hitSpeed = 0;
let sawBarrier = false;
let halfWidth = 0;
for (let i = 0; i < 60 && !sawBarrier; i += 1) {
  await stepSim(CHUNK);
  const s = await sample();
  halfWidth = s.roadHalfWidth;
  maxLateral = Math.max(maxLateral, Math.abs(s.lateral));
  if (Math.abs(s.lateral) > barrierBand(s)) {
    sawBarrier = true;
    hitSpeed = s.speed;
  }
}

// --- Phase 2: stop steering, keep the throttle, let the wall do its job -----
await page.keyboard.up('KeyA');

let returned = null;
let framesToReturn = 0;
const trace = [];
for (let i = 0; i < 80; i += 1) {
  await stepSim(CHUNK);
  framesToReturn += CHUNK;
  const s = await sample();
  trace.push(Math.abs(s.lateral));
  if (Math.abs(s.lateral) <= s.roadHalfWidth * 0.9) {
    returned = s;
    break;
  }
}
await page.keyboard.up('KeyW');

await browser.close();

console.log(`\nroad half-width    ${halfWidth.toFixed(2)}`);
console.log(`max |lateral|      ${maxLateral.toFixed(2)}  (barrier band starts at ${(halfWidth + 0.35).toFixed(2)}, wall clamps at ${(halfWidth + 0.85).toFixed(2)})`);
console.log(`speed at contact   ${hitSpeed.toFixed(1)}`);
// One point per 3 sim frames, so this reads as ~0.05 s per character.
console.log(
  `|lateral| trace    ${trace
    .filter((_, i) => i % 4 === 0)
    .map((v) => v.toFixed(1))
    .join(' ')}`,
);
console.log(
  returned
    ? `back on road       |lateral| ${Math.abs(returned.lateral).toFixed(2)} after ${framesToReturn} frames, speed ${returned.speed.toFixed(1)}`
    : 'back on road       never within the frame budget',
);

// The setup has to have actually reached the barrier, otherwise the return
// assertion below would be vacuously true.
check(
  'droveIntoTheBarrier',
  sawBarrier,
  `max |lateral| ${maxLateral.toFixed(2)} vs band ${(halfWidth + 0.35).toFixed(2)}`,
);
check(
  'returnsToTheRoadByItself',
  returned !== null,
  returned
    ? `${framesToReturn} frames to |lateral| ${Math.abs(returned.lateral).toFixed(2)}`
    : 'still off the road after 240 frames of sim',
);
check(
  'bounceKeepsMomentum',
  returned !== null && returned.speed > 8,
  returned ? `speed ${returned.speed.toFixed(1)} > 8` : 'no return, no speed to report',
);
check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
