/**
 * Screenshot + wiring pass for the round-5 UI/motion changes.
 *
 * Captures the menu, the in-race HUD, both close-ups and the duo split, and
 * asserts the things a screenshot cannot show:
 *   - --speed-t is actually published on #app while racing
 *   - .track-arc resolves to a url(#...) gradient stroke, not a flat colour
 *   - every track card got a real path (the preview is data-driven)
 *   - the per-card accent variables landed on the DOM
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const outDir = 'artifacts/round5';
mkdirSync(outDir, { recursive: true });

const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

async function open(viewport) {
  const mobile = viewport.width < 900;
  const ctx = await browser.newContext({
    viewport,
    hasTouch: mobile,
    isMobile: mobile,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 90000,
  });
  return { ctx, page };
}

async function shoot(page, name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`  ${outDir}/${name}.png`);
}

async function closeUp(page, selector, name) {
  await page.waitForTimeout(300);
  const el = page.locator(selector).first();
  await el.screenshot({ path: `${outDir}/${name}.png` });
  console.log(`  ${outDir}/${name}.png`);
}

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

/* ---------------------------------------------------------------- desktop */

{
  const { ctx, page } = await open({ width: 1280, height: 720 });
  console.log('\n== desktop 1280x720 ==');
  await shoot(page, '01-menu-desktop');
  await closeUp(page, '#track-picker', '02-track-cards');
  await closeUp(page, '#car-picker', '03-car-cards');

  // Hover a card so the hover state is on screen for the panel shot.
  await page.locator('.track-btn').nth(1).hover();
  await shoot(page, '04-menu-hover-track');

  const menu = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.track-btn')];
    return {
      count: cards.length,
      paths: cards.map((el) => el.querySelector('.track-map-line')?.getAttribute('d')?.length ?? 0),
      accentA: cards.map((el) => el.style.getPropertyValue('--track-a')),
      glow: cards.map((el) => el.style.getPropertyValue('--track-glow')),
      stroke: cards.map((el) => el.querySelector('.track-map-line')?.style.stroke ?? ''),
      carVars: [...document.querySelectorAll('.car-btn')].map((el) => ({
        a: el.style.getPropertyValue('--car-a'),
        glow: el.style.getPropertyValue('--car-glow'),
      })),
      activeCards: document.querySelectorAll('.track-btn.active').length,
      // The panel is allowed to scroll in principle, but on a 1280x720 desktop
      // the primary CTA has to be reachable without scrolling it. Taller cards
      // are exactly the kind of change that quietly pushes it under the fold.
      cta: (() => {
        const panel = document.querySelector('#overlay-start .panel');
        const btn = document.querySelector('#start-button');
        const pr = panel.getBoundingClientRect();
        const br = btn.getBoundingClientRect();
        return {
          fits: br.bottom <= pr.bottom + 0.5,
          slack: Math.round(pr.bottom - br.bottom),
          scroll: panel.scrollHeight - panel.clientHeight,
        };
      })(),
      // The panel must not be clipping anything horizontally.
      panelOver: (() => {
        const el = document.querySelector('#overlay-start .panel');
        return el.scrollWidth - el.clientWidth;
      })(),
    };
  });

  check('four track cards', menu.count === 4, `count=${menu.count}`);
  check(
    'every card has a real path',
    menu.paths.every((n) => n > 200),
    `min d length=${Math.min(...menu.paths)}`,
  );
  check(
    'cards carry distinct accents',
    new Set(menu.accentA).size === 4,
    menu.accentA.join(' '),
  );
  check(
    'glow var is an rgba',
    menu.glow.every((g) => g.startsWith('rgba(')),
    menu.glow[0],
  );
  check(
    'line stroke points at a gradient',
    // The DOM normalises `style.stroke` to url("#...") — quotes included — so
    // matching on `url(#` would fail on a correct value.
    menu.stroke.every((s) => s.replace(/["']/g, '').startsWith('url(#track-map-grad-')),
    menu.stroke[0],
  );
  check(
    'car orbs carry accent vars',
    menu.carVars.length === 4 && menu.carVars.every((c) => c.a && c.glow.startsWith('rgba(')),
    menu.carVars.map((c) => c.a).join(' '),
  );
  check('exactly one active card', menu.activeCards === 1, `n=${menu.activeCards}`);
  check('menu panel has no horizontal overflow', menu.panelOver <= 1, `+${menu.panelOver}px`);
  check(
    'start CTA is above the fold',
    menu.cta.fits,
    `slack=${menu.cta.slack}px panelScroll=${menu.cta.scroll}px`,
  );

  await ctx.close();
}

/* ------------------------------------------------------------ race desktop */

{
  const { ctx, page } = await open({ width: 1280, height: 720 });
  console.log('\n== race desktop ==');
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
    window.__THREE_GAME_TEST_HOOKS__.grantItem('turbo');
  });
  // active-play hands the kart 42 units of speed and then the sim keeps
  // running: with no throttle it coasts to a standstill and the speed ring,
  // the nitro bar and --speed-t all read zero by the time the shot lands.
  // Hold the throttle so the captured frame is an actual racing frame.
  await page.keyboard.down('w');
  await page.waitForTimeout(1500);
  await shoot(page, '05-race-desktop');
  // Sampled here, while the kart is actually moving. Reading --speed-t after the
  // close-up pass instead would measure a kart that has already coasted into a
  // barrier and slowed to a crawl, where 0 is the correct value.
  const cruise = await page.evaluate(() => ({
    t: document.querySelector('#app').style.getPropertyValue('--speed-t'),
    speed: document.querySelector('#speed-value').textContent,
  }));

  // Fire the nitro so the frame carries the boost trail, then read the live
  // particle count. The sprite shader replaced PointsMaterial, and a broken
  // ShaderMaterial fails silently — nothing renders, no console error — so the
  // particle pool has to be asserted rather than assumed.
  await page.keyboard.down(' ');
  await page.waitForTimeout(600);
  const boosted = await page.evaluate(() => ({
    t: document.querySelector('#app').style.getPropertyValue('--speed-t'),
    live: window.__THREE_GAME_DIAGNOSTICS__.vfxLive,
  }));
  await shoot(page, '05b-race-boost');
  await page.keyboard.up(' ');

  check('cruise publishes speed-t', Number(cruise.t) > 0, `--speed-t=${cruise.t} @ ${cruise.speed} km/h`);
  check('boost pins speed-t to 1', Number(boosted.t) === 1, `--speed-t=${boosted.t}`);
  check('boost trail has live particles', boosted.live > 0, `vfxLive=${boosted.live}`);
  await closeUp(page, '.speed-cluster', '06-speed-ring');
  await closeUp(page, '.hud-bottom-right', '07-nitro-cluster');
  await closeUp(page, '.hud-top', '08-hud-chips');

  const hud = await page.evaluate(() => {
    const arc = document.querySelector('#speed-arc');
    const cs = getComputedStyle(arc);
    const ring = document.querySelector('.speed-ring');
    const chip = document.querySelector('.hud-chip');
    return {
      arcStroke: cs.stroke,
      arcDash: arc.style.strokeDasharray,
      arcFilter: cs.filter,
      ringBezel: getComputedStyle(ring, '::before').maskImage.slice(0, 24),
      chipHairline: getComputedStyle(chip).boxShadow.includes('inset'),
      speedText: document.querySelector('#speed-value').textContent,
      nitroFill: document.querySelector('#nitro-fill').style.width,
      itemHas: document.querySelector('#item-slot').className,
      gradients: document.querySelectorAll('#speed-grad, #speed-grad-hot').length,
    };
  });

  check(
    'speed arc uses the gradient',
    hud.arcStroke.includes('url('),
    hud.arcStroke,
  );
  check('speed arc has an arc length', hud.arcDash !== '0 327', hud.arcDash);
  check('speed arc has a glow filter', hud.arcFilter.includes('drop-shadow'), hud.arcFilter);
  check('ring tick bezel is masked', hud.ringBezel.length > 0, hud.ringBezel);
  check('chips keep their hairline', hud.chipHairline);
  check('both speed gradients declared', hud.gradients === 2, `n=${hud.gradients}`);
  check('item slot shows held state', hud.itemHas.includes('has-item'), hud.itemHas);
  console.log(`  (speed readout ${hud.speedText} km/h, nitro fill ${hud.nitroFill})`);

  await ctx.close();
}

/* -------------------------------------------------------------- duo desktop */

{
  const { ctx, page } = await open({ width: 1280, height: 720 });
  console.log('\n== duo desktop ==');
  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setMode('duo');
    window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
  });
  await page.keyboard.down('w');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(1500);
  await shoot(page, '09-race-duo');
  await ctx.close();
}

/* ------------------------------------------------------------------- phone */

{
  const { ctx, page } = await open({ width: 390, height: 844 });
  console.log('\n== phone 390x844 ==');
  await shoot(page, '10-menu-phone');
  const panel = await page.evaluate(() => {
    const el = document.querySelector('#overlay-start .panel');
    const card = document.querySelector('.track-btn');
    const map = document.querySelector('.track-map');
    const r = card.getBoundingClientRect();
    const m = map.getBoundingClientRect();
    return {
      over: el.scrollWidth - el.clientWidth,
      cardH: Math.round(r.height),
      cardW: Math.round(r.width),
      mapW: Math.round(m.width),
      mapInside: m.right <= r.right + 0.5 && m.left >= r.left - 0.5,
      cols: getComputedStyle(document.querySelector('.track-picker')).gridTemplateColumns,
    };
  });
  check('phone panel has no horizontal overflow', panel.over <= 1, `+${panel.over}px`);
  check('phone map fits inside its card', panel.mapInside, `map=${panel.mapW} card=${panel.cardW}`);
  check('phone cards are one per row', !panel.cols.includes(' '), panel.cols);

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
    window.__THREE_GAME_TEST_HOOKS__.grantItem('turbo');
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(1500);
  await shoot(page, '11-race-phone');
  await ctx.close();
}

await browser.close();

console.log('\n=== summary ===');
const failed = results.filter((r) => !r.pass);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  for (const f of failed) console.log(`  FAILED: ${f.name}  ${f.detail}`);
  process.exitCode = 1;
}
