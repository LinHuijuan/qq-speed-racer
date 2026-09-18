/**
 * Verifies the start line faces the way the road actually goes.
 *
 * The closed CatmullRomCurve3 derivative at the seam blends the incoming and
 * outgoing legs, which pointed the spawn heading up to 39 deg off-road and
 * launched the kart into the barrier within ~10 units. This drives straight off
 * the line on every layout and checks the kart stays on the racing surface.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
const TRACKS = ['neon', 'hairpin', 'harbor', 'mountain'];

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
    const p = window.__THREE_GAME_DIAGNOSTICS__.player;
    return {
      x: Number(p.position.x.toFixed(2)),
      z: Number(p.position.z.toFixed(2)),
      speed: Number(p.speed.toFixed(2)),
      progress: Number(p.progress.toFixed(4)),
      heading: Number(p.heading.toFixed(4)),
      offTrack: p.offTrack,
    };
  });

const results = [];
for (const track of TRACKS) {
  await page.evaluate((id) => window.__THREE_GAME_TEST_HOOKS__.setTrack(id), track);
  await waitFrames(2);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.forceRace());
  await waitFrames(1);
  const spawn = await snap();

  // Straight launch: throttle only, no steering.
  await page.keyboard.down('KeyW');
  const trail = [];
  let leftRoadAtFrame = null;
  for (let i = 0; i < 16; i += 1) {
    await waitFrames(1);
    const s = await snap();
    trail.push(s);
    if (s.offTrack && leftRoadAtFrame === null) leftRoadAtFrame = i + 1;
  }
  await page.keyboard.up('KeyW');

  const last = trail[trail.length - 1];
  const travelled = Math.hypot(last.x - spawn.x, last.z - spawn.z);
  results.push({
    track,
    spawnHeading: spawn.heading,
    travelled: Number(travelled.toFixed(2)),
    progressGain: Number((last.progress - spawn.progress).toFixed(4)),
    leftRoadAtFrame,
    finalOffTrack: last.offTrack,
    finalSpeed: last.speed,
    trail,
  });
}

console.log(JSON.stringify(results, null, 2));

console.log('\ntrack      spawn heading  travelled  progress gain  left road at  final speed');
for (const r of results) {
  console.log(
    `${r.track.padEnd(10)} ${String(r.spawnHeading).padStart(13)} ${String(r.travelled).padStart(10)} ${String(r.progressGain).padStart(14)} ${String(r.leftRoadAtFrame ?? '-').padStart(13)} ${String(r.finalSpeed).padStart(12)}`,
  );
}

const checks = {};
for (const r of results) {
  checks[`${r.track}_staysOnRoad`] = r.leftRoadAtFrame === null;
}
checks.allTracksOk = Object.values(checks).every(Boolean);
console.log('\nchecks:', JSON.stringify(checks, null, 2));
console.log('pass:', checks.allTracksOk);

await browser.close();
if (!checks.allTracksOk) process.exitCode = 1;
