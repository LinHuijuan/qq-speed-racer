/**
 * Guards the texture pipeline in both directions:
 *
 *   - runtime: every /assets/* the page requests must return 200 with an image
 *     content type, and nothing may log a console error (three.js only warns on
 *     a failed texture, so a silent 404 would otherwise render an untextured
 *     surface and still pass every other suite).
 *   - static: every file shipped in public/assets must be referenced somewhere
 *     in src/ or index.html, so a renamed extension or an orphaned file is
 *     caught at review time rather than on the network tab.
 *
 *   node scripts/texture-check.mjs [url]
 */
import { chromium } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// ---------------------------------------------------------------- static side
const srcRoots = ['src'];
const sourceText = [];
for (const root of srcRoots) {
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|css|html)$/.test(entry.name)) sourceText.push(await readFile(full, 'utf8'));
    }
  };
  await walk(root);
}
sourceText.push(await readFile('index.html', 'utf8'));
const blob = sourceText.join('\n');

const shipped = (await readdir('public/assets')).sort();
const unreferenced = shipped.filter((f) => !blob.includes(`/assets/${f}`));
check(
  'everyShippedAssetIsReferenced',
  unreferenced.length === 0,
  unreferenced.length ? `unreferenced: ${unreferenced.join(', ')}` : `${shipped.length} files`,
);

const stalePngRefs = [...blob.matchAll(/\/assets\/[a-z0-9-]+\.png/g)].map((m) => m[0]);
check(
  'noStalePngReferences',
  stalePngRefs.length === 0,
  stalePngRefs.length ? stalePngRefs.join(', ') : 'none',
);

// --------------------------------------------------------------- runtime side
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const context = await browser.newContext({ viewport: { width: 800, height: 450 } });
const page = await context.newPage();

const assetResponses = new Map();
const errors = [];
page.on('response', (res) => {
  const pathname = new URL(res.url()).pathname;
  if (pathname.startsWith('/assets/')) {
    assetResponses.set(pathname, {
      status: res.status(),
      type: res.headers()['content-type'] ?? '',
    });
  }
});
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

await page.goto(url, { waitUntil: 'domcontentloaded' });

const settle = async (timeoutMs = 40000) => {
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
    } else stable = 0;
    last = total;
    await page.waitForTimeout(400);
  }
};

await settle();

// Each car has its own livery texture and the picker is the only way to switch,
// so walk every card or three of the seventeen assets never get requested.
const cars = await page.evaluate(() =>
  [...document.querySelectorAll('.car-btn')].map((el) => el.dataset.carId),
);
for (const car of cars) {
  await page.click(`.car-btn[data-car-id="${car}"]`);
  await page.waitForTimeout(400);
  await settle();
}

const tracks = await page.evaluate(() =>
  [...document.querySelectorAll('[data-track]')].map((el) => el.getAttribute('data-track')),
);
for (const track of tracks.length ? tracks : [null]) {
  await page.evaluate((id) => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (id) hooks?.setTrack?.(id);
    hooks?.forceRace?.();
  }, track);
  await page.waitForTimeout(900);
  await settle();
}

const failed = [...assetResponses.entries()].filter(([, r]) => r.status !== 200);
check(
  'allAssetRequestsReturn200',
  failed.length === 0,
  failed.length ? failed.map(([p, r]) => `${p} -> ${r.status}`).join(', ') : `${assetResponses.size} requests`,
);

const badType = [...assetResponses.entries()].filter(
  ([, r]) => r.status === 200 && !r.type.startsWith('image/'),
);
check(
  'allAssetsServedAsImages',
  badType.length === 0,
  badType.length ? badType.map(([p, r]) => `${p} -> ${r.type}`).join(', ') : 'ok',
);

const loaded = [...assetResponses.keys()];
check('texturesActuallyLoaded', loaded.length >= 8, `${loaded.length} distinct assets`);

const notLoaded = shipped.filter((f) => !loaded.includes(`/assets/${f}`));
check(
  'everyAssetReachedTheNetwork',
  notLoaded.length === 0,
  notLoaded.length ? `not fetched: ${notLoaded.join(', ')}` : `${loaded.length}/${shipped.length}`,
);

check('noConsoleErrors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');

await browser.close();

const failedCount = checks.filter((c) => !c.pass).length;
console.log(`\n${checks.length - failedCount}/${checks.length} checks passed`);
process.exit(failedCount ? 1 : 0);
