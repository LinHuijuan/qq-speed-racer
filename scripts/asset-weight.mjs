/**
 * Measures what the browser actually downloads, not what sits on disk.
 *
 * Walks menu -> race -> duo so every texture a player can reach gets requested,
 * then cross-checks the request list against `public/` to surface dead weight
 * (files shipped but never fetched).
 *
 *   node scripts/asset-weight.mjs [url] [label]
 *
 * Writes artifacts/asset-weight/<label>.json and prints a summary.
 */
import { chromium } from '@playwright/test';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const label = process.argv[3] ?? 'current';
const outDir = 'artifacts/asset-weight';
const publicDir = path.resolve('public');
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

/** Every file on disk under public/, as repo-relative POSIX paths. */
const walk = async (dir) => {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
};

const diskFiles = [];
for (const file of await walk(publicDir)) {
  diskFiles.push({
    rel: path.relative(publicDir, file).split(path.sep).join('/'),
    bytes: (await stat(file)).size,
  });
}

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
const page = await context.newPage();

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

/** Frames tick at ~0.3 fps under SwiftShader, so advance a few and move on. */
const advanceFrames = (page, count) =>
  page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let left = n;
        const tick = () => {
          left -= 1;
          if (left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    count,
  );

await page.goto(url, { waitUntil: 'domcontentloaded' });

// Wait for the texture loads triggered by boot to settle. In-flight entries
// have responseEnd === 0, so poll until none are pending.
const settle = async (timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let last = -1;
  while (Date.now() < deadline) {
    const pending = await page.evaluate(
      () =>
        performance
          .getEntriesByType('resource')
          .filter((e) => e.responseEnd === 0 || e.duration === 0).length,
    );
    const total = await page.evaluate(() => performance.getEntriesByType('resource').length);
    if (pending === 0 && total === last) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      stable = 0;
    }
    last = total;
    await page.waitForTimeout(500);
  }
};

await settle();

// Drive into a race so track + kart textures are requested too. Each track
// pulls its own scenery set, so walk all of them.
const tracks = await page.evaluate(() =>
  [...document.querySelectorAll('[data-track]')].map((el) => el.getAttribute('data-track')),
);
const visited = tracks.length ? tracks : [null];

for (const track of visited) {
  await page.evaluate((id) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (id) hooks?.setTrack?.(id);
    hooks?.forceRace?.();
  }, track);
  await page.waitForTimeout(1200);
  await advanceFrames(page, 2);
  await settle();
}

// And into duo, which builds a second camera and a second kart set.
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setMode?.('duo'));
await page.waitForTimeout(1500);
await advanceFrames(page, 2);
await settle();

const entries = await page.evaluate(() =>
  performance.getEntriesByType('resource').map((e) => ({
    name: new URL(e.name).pathname,
    initiatorType: e.initiatorType,
    transferSize: e.transferSize,
    encodedBodySize: e.encodedBodySize,
    decodedBodySize: e.decodedBodySize,
  })),
);

await browser.close();

const bytesOf = (e) => (e.transferSize > 0 ? e.transferSize : e.encodedBodySize);

const byExt = new Map();
for (const e of entries) {
  const ext = path.extname(e.name).toLowerCase() || '<none>';
  const prev = byExt.get(ext) ?? { count: 0, bytes: 0 };
  prev.count += 1;
  prev.bytes += bytesOf(e);
  byExt.set(ext, prev);
}

const images = entries.filter((e) => /\.(png|jpe?g|webp|avif|ktx2?|basis)$/i.test(e.name));
const requested = new Set(entries.map((e) => e.name));
const deadWeight = diskFiles.filter((f) => !requested.has('/' + f.rel));

const total = entries.reduce((sum, e) => sum + bytesOf(e), 0);
const imageBytes = images.reduce((sum, e) => sum + bytesOf(e), 0);

const report = {
  label,
  url,
  totalBytes: total,
  totalMB: +(total / 1024 / 1024).toFixed(2),
  requestCount: entries.length,
  imageBytes,
  imageMB: +(imageBytes / 1024 / 1024).toFixed(2),
  byExtension: Object.fromEntries(
    [...byExt].sort((a, b) => b[1].bytes - a[1].bytes).map(([k, v]) => [
      k,
      { count: v.count, kb: +(v.bytes / 1024).toFixed(1) },
    ]),
  ),
  heaviest: entries
    .map((e) => ({ name: e.name, kb: +(bytesOf(e) / 1024).toFixed(1) }))
    .sort((a, b) => b.kb - a.kb)
    .slice(0, 12),
  deadWeight: deadWeight.map((f) => ({ rel: f.rel, kb: +(f.bytes / 1024).toFixed(1) })),
  deadWeightMB: +(deadWeight.reduce((s, f) => s + f.bytes, 0) / 1024 / 1024).toFixed(2),
  consoleErrors: errors,
};

await writeFile(path.join(outDir, `${label}.json`), JSON.stringify(report, null, 2));

const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;
console.log(`\n=== asset weight: ${label} ===`);
console.log(`requests          ${report.requestCount}`);
console.log(`total downloaded  ${report.totalMB} MB`);
console.log(`  of which images ${report.imageMB} MB  (${images.length} files)`);
console.log('\nby extension:');
for (const [ext, v] of Object.entries(report.byExtension)) {
  console.log(`  ${ext.padEnd(8)} ${String(v.count).padStart(4)} req  ${v.kb.toFixed(1).padStart(10)} KB`);
}
console.log('\nheaviest requests:');
for (const h of report.heaviest) console.log(`  ${String(h.kb).padStart(9)} KB  ${h.name}`);
console.log(`\ndead weight on disk (never requested): ${report.deadWeightMB} MB`);
for (const d of report.deadWeight.slice(0, 12)) console.log(`  ${String(d.kb).padStart(9)} KB  ${d.rel}`);
if (errors.length) {
  console.log(`\nconsole errors (${errors.length}):`);
  for (const e of errors.slice(0, 5)) console.log(`  ${e}`);
}
console.log(`\nreport -> ${outDir}/${label}.json`);
void mb;
