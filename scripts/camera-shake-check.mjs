/**
 * Chase camera must not wobble.
 *
 * The rig used to carry a trauma/shake channel: every wall scrape added 0.06
 * *per frame* (so sliding along a barrier saturated it to full amplitude),
 * off-road added 0.08 every 0.15s, and nitro / item hits added one-shot kicks.
 * The camera position and roll were then offset by sin/cos noise every frame,
 * which is what made the whole picture swing around. Shake is gone; impact is
 * carried by wheel spin, scrape sparks, shockwaves, the HUD flash and audio.
 *
 * Observable contract: with the kart pose and speed pinned to constants, the
 * rig is a pure damped follower — after it settles, feeding it the same input
 * must leave the camera at exactly the same place, frame after frame. Any
 * per-frame noise term shows up as a spread across samples. The old shake
 * moved the camera by up to 0.28 world units and 0.025 rad of roll, nine
 * orders of magnitude above the damped-follower residual.
 *
 * `addTrauma` must also be gone, so the knob cannot be turned back on by
 * accident from a call site that was missed.
 *
 *   node scripts/camera-shake-check.mjs [url]
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

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});

/**
 * Runs the *real* CameraRig module in the page — not a copy of its maths. Vite
 * serves the transformed source, so the module can be imported by path; the
 * three.js URL it was rewritten to is read back out of that same source, so a
 * dep-optimizer hash change cannot break the probe.
 */
const probe = await page.evaluate(async () => {
  const src = await (await fetch('/src/systems/CameraRig.ts')).text();
  const match = src.match(/from\s*["']([^"']*three[^"']*)["']/);
  if (!match) throw new Error('could not find the three.js import in CameraRig.ts');
  const THREE = await import(match[1]);
  const { CameraRig } = await import('/src/systems/CameraRig.ts');

  const camera = new THREE.PerspectiveCamera(58, 16 / 9, 0.1, 400);
  const rig = new CameraRig(camera);
  const position = new THREE.Vector3(12, 0, -30);
  const heading = 0.7;
  const speed = 30;
  const dt = 1 / 60;

  // Settle. Every term here is exponential, so 240 frames at 60Hz is ~4s of
  // damping: the residual left to bleed off during sampling is ~1e-9.
  for (let i = 0; i < 240; i += 1) rig.update(dt, position, heading, speed, false);

  const samples = [];
  for (let i = 0; i < 120; i += 1) {
    rig.update(dt, position, heading, speed, false);
    samples.push([
      camera.position.x,
      camera.position.y,
      camera.position.z,
      camera.rotation.x,
      camera.rotation.y,
      camera.rotation.z,
      camera.fov,
    ]);
  }

  const spread = (axis) => {
    const values = samples.map((s) => s[axis]);
    return Math.max(...values) - Math.min(...values);
  };

  // The rig is also driven through a boost pass: fov punch + faster follow is
  // the only other thing that moves the camera, and it must stay smooth too.
  const boosted = [];
  for (let i = 0; i < 240; i += 1) rig.update(dt, position, heading, speed, true);
  for (let i = 0; i < 60; i += 1) {
    rig.update(dt, position, heading, speed, true);
    boosted.push([camera.position.x, camera.position.y, camera.position.z, camera.fov]);
  }
  const boostSpread = (axis) => {
    const values = boosted.map((s) => s[axis]);
    return Math.max(...values) - Math.min(...values);
  };

  const last = samples[samples.length - 1];
  return {
    hasTraumaApi: typeof rig.addTrauma === 'function',
    posSpread: Math.max(spread(0), spread(1), spread(2)),
    rotSpread: Math.max(spread(3), spread(4), spread(5)),
    fovSpread: spread(6),
    boostPosSpread: Math.max(boostSpread(0), boostSpread(1), boostSpread(2)),
    boostFovSpread: boostSpread(3),
    settled: [last[0], last[1], last[2]].map((v) => Number(v.toFixed(4))),
    settledFov: Number(last[6].toFixed(4)),
  };
});

await browser.close();

// 1e-3 is the pass bar. The old shake was ~0.28 units / 0.025 rad; the damped
// follower's residual over this window is ~1e-9. Nine orders of slack.
const BAR = 1e-3;

console.log(`settled camera      ${probe.settled.join(', ')}   fov ${probe.settledFov}`);
console.log(`cruise pos spread   ${probe.posSpread.toExponential(2)}`);
console.log(`cruise rot spread   ${probe.rotSpread.toExponential(2)}`);
console.log(`cruise fov spread   ${probe.fovSpread.toExponential(2)}`);
console.log(`boost  pos spread   ${probe.boostPosSpread.toExponential(2)}`);
console.log(`boost  fov spread   ${probe.boostFovSpread.toExponential(2)}`);

check(
  'noTraumaApiOnRig',
  probe.hasTraumaApi === false,
  probe.hasTraumaApi ? 'addTrauma() still exists' : 'addTrauma() is gone',
);
check(
  'cameraPositionDoesNotWobble',
  probe.posSpread < BAR,
  `spread ${probe.posSpread.toExponential(2)} < ${BAR}`,
);
check(
  'cameraRotationDoesNotWobble',
  probe.rotSpread < BAR,
  `spread ${probe.rotSpread.toExponential(2)} < ${BAR}`,
);
check(
  'cameraFovDoesNotWobble',
  probe.fovSpread < BAR,
  `spread ${probe.fovSpread.toExponential(2)} < ${BAR}`,
);
check(
  'boostPassStaysSmooth',
  probe.boostPosSpread < BAR && probe.boostFovSpread < BAR,
  `pos ${probe.boostPosSpread.toExponential(2)}, fov ${probe.boostFovSpread.toExponential(2)}`,
);
check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

const failed = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed ? 1 : 0);
