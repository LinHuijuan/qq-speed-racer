/**
 * Viewpoint-independent A/B probe. Both revisions are measured in the menu with
 * duo mode active, where every kart sits on the start grid — no motion, so the
 * camera and frustum culling are identical between runs.
 *
 * Old revision: duo bypassed the composer, so renderer.info held real numbers.
 * New revision: the composer masks it, so the measureDrawCalls hook is used.
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const label = process.argv[3] ?? 'unknown';
const outDir = 'artifacts/drawcall-ab';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 60000,
});

// Deterministic: duo grid, menu phase, nothing moving.
await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setMode('duo'));
await page.waitForTimeout(1500);

const report = await page.evaluate(() => {
  const d = window.__THREE_GAME_DIAGNOSTICS__;
  const raw = window.__THREE_GAME_TEST_HOOKS__.measureDrawCalls?.();
  return {
    phase: d.phase,
    mode: d.mode,
    masked: { calls: d.renderer.calls, triangles: d.renderer.triangles },
    raw: raw ?? null,
    geometries: d.renderer.geometries,
    textures: d.renderer.textures,
  };
});

const out = { label, ...report, errors };
await writeFile(path.join(outDir, `${label}.json`), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));

await browser.close();
