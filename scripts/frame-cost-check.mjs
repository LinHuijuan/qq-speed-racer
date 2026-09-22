/**
 * Per-frame cost meter for the HUD / diagnostics path.
 *
 * Software rendering makes wall-clock frame time useless for judging JS work
 * (a frame is ~330ms of SwiftShader), so this measures the two things that were
 * actually changed and that are renderer independent:
 *
 *  - bytes of JS heap allocated per frame (forced GC, then a heap delta)
 *  - DOM mutations per frame inside the HUD subtree
 *
 * Both are objective counters rather than timings, so they can be compared
 * across revisions without a stopwatch.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';
const FRAMES = 40;

/** Functions whose allocation is the point of this measurement. */
const WATCHED = /(publishDiagnostics|installDiagnostics|updateHud|rankOf|Hud\.update|drawMinimap)/;

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--use-angle=swiftshader',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--js-flags=--expose-gc',
  ],
});
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.forceRace());

const advance = (n) =>
  page.evaluate(
    (count) =>
      new Promise((resolve) => {
        const from = window.__THREE_GAME_DIAGNOSTICS__.frame;
        const tick = () => {
          if (window.__THREE_GAME_DIAGNOSTICS__.frame - from >= count) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    n,
  );

// Warm up so one-off lazy allocations (shaders, textures, caches) are out of the way.
await advance(10);

// --- allocation attributed to specific functions -------------------------
// A whole-heap delta is useless here: three.js allocates tens of KB per frame
// inside render(), which drowns out the handful of objects the HUD path built.
// The sampling profiler attributes bytes to call frames instead.
await cdp.send('HeapProfiler.enable');
await cdp.send('HeapProfiler.startSampling', { samplingInterval: 2048 });
const sampleStart = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.frame);
await advance(FRAMES);
const sampleEnd = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.frame);
const { profile } = await cdp.send('HeapProfiler.stopSampling');

const byFunction = new Map();
(function walk(node) {
  const callFrame = node.callFrame;
  const name = callFrame?.functionName || '(anonymous)';
  const size = node.selfSize ?? 0;
  if (size > 0) byFunction.set(name, (byFunction.get(name) ?? 0) + size);
  for (const child of node.children ?? []) walk(child);
})(profile.head);

const sampledFrames = sampleEnd - sampleStart;

await cdp.send('HeapProfiler.collectGarbage');
const before = await page.evaluate(() => performance.memory.usedJSHeapSize);

// Count every kind of HUD mutation the update path could cause.
await page.evaluate(() => {
  const hud = document.querySelector('#hud');
  window.__MUT = { total: 0, childList: 0, attributes: 0, characterData: 0 };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      window.__MUT.total += 1;
      if (r.type === 'childList') window.__MUT.childList += 1;
      else if (r.type === 'attributes') window.__MUT.attributes += 1;
      else window.__MUT.characterData += 1;
    }
  });
  observer.observe(hud, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  window.__MUT_OBSERVER__ = observer;
});

const startFrame = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.frame);
await advance(FRAMES);
const endFrame = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__.frame);
const mut = await page.evaluate(() => {
  window.__MUT_OBSERVER__.disconnect();
  return window.__MUT;
});
await cdp.send('HeapProfiler.collectGarbage');
const after = await page.evaluate(() => performance.memory.usedJSHeapSize);

await browser.close();

const frames = endFrame - startFrame;
const bytesPerFrame = (after - before) / frames;

const watched = [...byFunction.entries()]
  .filter(([name]) => WATCHED.test(name))
  .sort((a, b) => b[1] - a[1]);
const watchedTotal = watched.reduce((sum, [, bytes]) => sum + bytes, 0);
const heapTotal = [...byFunction.values()].reduce((sum, bytes) => sum + bytes, 0);

console.log('=== frame cost ===');
console.log(`frames measured        : ${frames}`);
console.log(`HUD DOM mutations      : ${mut.total} total, ${(mut.total / frames).toFixed(2)} per frame`);
console.log(`  childList            : ${mut.childList}`);
console.log(`  attributes           : ${mut.attributes}`);
console.log(`  characterData        : ${mut.characterData}`);
console.log(`heap delta / frame     : ${bytesPerFrame.toFixed(1)} bytes  (renderer dominated, FYI only)`);
console.log(`--- sampled allocation over ${sampledFrames} frames ---`);
console.log(
  `watched functions      : ${(watchedTotal / sampledFrames).toFixed(1)} bytes/frame ` +
    `(${((watchedTotal / Math.max(1, heapTotal)) * 100).toFixed(1)}% of all sampled)`,
);
for (const [name, bytes] of watched) {
  console.log(`    ${name.padEnd(28)} ${(bytes / sampledFrames).toFixed(1)} bytes/frame`);
}
if (!watched.length) {
  console.log('    (no allocation attributed to the HUD/diagnostics path at all)');
}
