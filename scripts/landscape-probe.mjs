/**
 * Vertical budget probe for the start panel on short viewports.
 *
 * The landscape menu buried 开始比赛 566px below the fold because `.panel` is a
 * flat block: on a 390px-tall viewport every child stacks and the CTA lands off
 * screen. Fixing that means reflowing the panel, and a reflow needs a real
 * height budget — font metrics are not something to guess at. So this prints
 * each child's measured height and margins, then optionally re-measures after
 * injecting a candidate stylesheet, which lets the layout be iterated without
 * editing styles.css and waiting on HMR.
 *
 * Usage:
 *   node scripts/landscape-probe.mjs [url] [viewportW] [viewportH] [candidate.css]
 *   ZOOM=3 node scripts/landscape-probe.mjs ...   # magnified region crops
 */
import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const width = Number(process.argv[3] ?? 844);
const height = Number(process.argv[4] ?? 390);
const candidatePath = process.argv[5];
const candidate = candidatePath ? readFileSync(candidatePath, 'utf8') : null;

const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const mobile = width < 900;
// ZOOM=3 rasterises the page at 3x so `clip` screenshots come back magnified —
// the only way to eyeball sub-pixel detail without an image library.
const zoom = Number(process.env.ZOOM ?? 1);
const ctx = await browser.newContext({
  viewport: { width, height },
  hasTouch: mobile,
  isMobile: mobile,
  deviceScaleFactor: zoom,
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
  timeout: 90000,
});

mkdirSync('artifacts/round5', { recursive: true });

/** Per-child height dump for one panel, plus the panel's own box. */
const DUMP = (panelSel) =>
  (() => {
    const panel = document.querySelector(panelSel);
    if (!panel) return { missing: true };
    const pr = panel.getBoundingClientRect();
    const cs = getComputedStyle(panel);
    const rows = [...panel.children].map((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        cls: el.className || el.id || '',
        h: Math.round(r.height),
        mt: Math.round(parseFloat(s.marginTop) || 0),
        mb: Math.round(parseFloat(s.marginBottom) || 0),
        w: Math.round(r.width),
      };
    });
    return {
      panel: {
        clientH: panel.clientHeight,
        scrollH: panel.scrollHeight,
        clientW: panel.clientWidth,
        scrollW: panel.scrollWidth,
        top: Math.round(pr.top),
        bottom: Math.round(pr.bottom),
        display: cs.display,
        gtc: cs.gridTemplateColumns,
      },
      rows,
    };
  })();

const PROBE = () =>
  (() => {
    const btn = document.querySelector('#start-button');
    const cont = document.querySelector('#continue-button');
    const panel = document.querySelector('#overlay-start .panel');
    const pr = panel.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      cta: {
        fits: br.bottom <= pr.bottom + 0.5,
        slack: Math.round(pr.bottom - br.bottom),
        h: Math.round(br.height),
      },
      continueShown: cont ? getComputedStyle(cont).display !== 'none' : null,
    };
  })();

/**
 * CTA reachability for every overlay.
 *
 * Every overlay keeps layout at opacity 0, so all three panels can be measured
 * without showing them — except the finish overlay, whose contents are only
 * populated once the race completes. The same defect that buried 开始比赛 would
 * bury 再来一局, and on a landscape phone being unable to restart is as fatal
 * as being unable to start.
 */
const MEASURE = ([sel, ctaSel]) =>
  (() => {
    const p = document.querySelector(`${sel} .panel`);
    const cta = document.querySelector(ctaSel);
    if (!p || !cta) return { sel, missing: true };
    const pr = p.getBoundingClientRect();
    const cr = cta.getBoundingClientRect();
    return {
      sel,
      h: Math.round(pr.height),
      scroll: p.scrollHeight - p.clientHeight,
      over: p.scrollWidth - p.clientWidth,
      ctaFits: cr.bottom <= pr.bottom + 0.5,
      slack: Math.round(pr.bottom - cr.bottom),
      ctaBottom: Math.round(cr.bottom),
    };
  })();

async function measureAll() {
  const start = await page.evaluate(MEASURE, ['#overlay-start', '#start-button']);
  const startDump = await page.evaluate(DUMP, '#overlay-start .panel');
  const pause = await page.evaluate(MEASURE, ['#overlay-pause', '#resume-button']);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('complete'));
  await page.waitForTimeout(300);
  const finish = await page.evaluate(MEASURE, ['#overlay-finish', '#restart-button']);
  const finishDump = await page.evaluate(DUMP, '#overlay-finish .panel');
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('menu'));
  await page.waitForTimeout(300);
  return { overlays: [start, finish, pause], startDump, finishDump };
}

function reportPanel(dump) {
  if (dump.missing) {
    console.log('  (panel missing)');
    return;
  }
  console.log(
    `  ${dump.panel.clientW}x${dump.panel.clientH} (scroll ${dump.panel.scrollW}x${dump.panel.scrollH}) ` +
      `display=${dump.panel.display} cols=${dump.panel.gtc} ` +
      `stacked=${dump.rows.reduce((a, r) => a + r.h + r.mt + r.mb, 0)}px`,
  );
  for (const r of dump.rows) {
    console.log(
      `    ${String(r.h).padStart(4)}px  w=${String(r.w).padStart(4)}  ` +
        `m=${String(r.mt).padStart(3)}/${String(r.mb).padStart(3)}  ${r.tag}.${r.cls}`,
    );
  }
}

function report(tag, { overlays, startDump, finishDump }, probe) {
  console.log(`\n--- ${tag} ---`);
  console.log(
    `start CTA fits=${probe.cta.fits} slack=${probe.cta.slack}px  continue shown=${probe.continueShown}`,
  );
  console.log(`  overlay CTAs (viewport ${height}px tall):`);
  for (const o of overlays) {
    if (o.missing) {
      console.log(`    ${o.sel.padEnd(17)} (panel or CTA missing)`);
      continue;
    }
    console.log(
      `    ${o.sel.padEnd(17)} panel ${String(o.h).padStart(4)}px scroll ${String(o.scroll).padStart(4)}px  ` +
        `CTA ${o.ctaFits ? 'visible' : 'BURIED '} slack=${String(o.slack).padStart(5)}px ` +
        `bottom=${o.ctaBottom}px over=${o.over}px`,
    );
  }
  console.log('  start panel:');
  reportPanel(startDump);
  console.log('  finish panel:');
  reportPanel(finishDump);
}

console.log(`== ${width}x${height} ==`);
report('baseline', await measureAll(), await page.evaluate(PROBE));
await page.screenshot({ path: 'artifacts/round5/probe-landscape-before.png' });

if (candidate) {
  await page.evaluate((css) => {
    let el = document.getElementById('__landscape_candidate__');
    if (!el) {
      el = document.createElement('style');
      el.id = '__landscape_candidate__';
      document.head.appendChild(el);
    }
    el.textContent = css;
  }, candidate);
  await page.waitForTimeout(250);
  report(`with ${candidatePath}`, await measureAll(), await page.evaluate(PROBE));
  await page.screenshot({ path: 'artifacts/round5/probe-landscape-after.png' });
  console.log(`\n  artifacts/round5/probe-landscape-after.png`);

  // Region crops, magnified by ZOOM. The full shot is fine for composition but
  // too small to judge a 0.74rem label or a 48px card.
  const regions = {
    'left-column': { x: 26, y: 22, width: 300, height: 350 },
    'right-pickers': { x: 340, y: 22, width: 480, height: 200 },
    'right-settings': { x: 340, y: 220, width: 480, height: 150 },
  };
  for (const [name, clip] of Object.entries(regions)) {
    await page.screenshot({ path: `artifacts/round5/zoom-landscape-${name}.png`, clip });
    console.log(`  artifacts/round5/zoom-landscape-${name}.png`);
  }
}

await ctx.close();
await browser.close();
