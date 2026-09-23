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

/**
 * Prove a decoration actually paints.
 *
 * `getComputedStyle(el, '::before').maskImage` returning a non-empty string says
 * nothing about whether one pixel reaches the screen. The round-5 tick bezel
 * passed exactly that assertion while its mask annulus sat entirely outside the
 * element box, so the ticks never rendered. An assertion that cannot fail is
 * worse than no assertion, so this paints the region twice — once with the
 * decoration killed — and diffs the pixels.
 *
 * The canvas and the speed-line overlay are hidden for every capture so the ring
 * sits on a flat backdrop and consecutive shots differ only by the decoration.
 * The PNGs are handed back to the page as data URLs and read through a 2D
 * canvas, so no image-decoding dependency is needed.
 */
async function diffShots(page, a, b) {
  return page.evaluate(
    async ([b64a, b64b]) => {
      const load = (b64) =>
        new Promise((res, rej) => {
          const img = new Image();
          img.onload = () => res(img);
          img.onerror = rej;
          img.src = `data:image/png;base64,${b64}`;
        });
      const [ia, ib] = await Promise.all([load(b64a), load(b64b)]);
      const c = document.createElement('canvas');
      c.width = ia.width;
      c.height = ia.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(ia, 0, 0);
      const da = g.getImageData(0, 0, c.width, c.height).data;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(ib, 0, 0);
      const db = g.getImageData(0, 0, c.width, c.height).data;
      let over8 = 0;
      let over32 = 0;
      let sum = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(
          Math.abs(da[i] - db[i]),
          Math.abs(da[i + 1] - db[i + 1]),
          Math.abs(da[i + 2] - db[i + 2]),
        );
        if (d > 8) over8++;
        if (d > 32) over32++;
        sum += d;
      }
      return { px: da.length / 4, over8, over32, mean: +(sum / (da.length / 4)).toFixed(2) };
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

/**
 * Fraction of pixels in `box` that are bright *and* desaturated — the pale
 * glare a blown-out additive/unlit mesh produces, which hides whatever is
 * behind it.
 *
 * This is the measurement that caught the item-box rings. They were #7cf6ff,
 * which scores 0.825 on UnrealBloomPass's Rec.601 luma (0.299/0.587/0.114):
 * just under the old 0.85 threshold, but over the new 0.72, so the 0.06-radius
 * tube ballooned into a fat white band around every item box on the track.
 */
async function glareStats(page, shot, box) {
  return page.evaluate(
    async ([b64, b]) => {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = `data:image/png;base64,${b64}`;
      });
      const c = document.createElement('canvas');
      c.width = b.w;
      c.height = b.h;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, b.x, b.y, b.w, b.h, 0, 0, b.w, b.h);
      const d = g.getImageData(0, 0, b.w, b.h).data;
      let glare = 0;
      const n = b.w * b.h;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i];
        const gg = d[i + 1];
        const bb = d[i + 2];
        const mn = Math.min(r, gg, bb);
        const mx = Math.max(r, gg, bb);
        if (mn > 150 && mx - mn < 70) glare++;
      }
      return glare / n;
    },
    [shot.toString('base64'), box],
  );
}

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
    const chip = document.querySelector('.hud-chip');
    return {
      arcStroke: cs.stroke,
      arcDash: arc.style.strokeDasharray,
      arcFilter: cs.filter,
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
  check('chips keep their hairline', hud.chipHairline);
  check('both speed gradients declared', hud.gradients === 2, `n=${hud.gradients}`);
  check('item slot shows held state', hud.itemHas.includes('has-item'), hud.itemHas);
  console.log(`  (speed readout ${hud.speedText} km/h, nitro fill ${hud.nitroFill})`);

  /*
   * Ring decorations, proved by pixels.
   *
   * Everything in this corner that animates has to be hidden first, or the diff
   * measures the arc growing and the speed number ticking instead of the
   * decoration. That is not hypothetical: the first version of this check hid
   * only the canvas, and reported the bezel delta and the noise floor as the
   * same 231px — it was reading scene churn and would have passed on a bezel
   * that never painted. Each pass below isolates exactly one decoration.
   */
  const HIDE = 'canvas,#speed-lines,.gear-tag{visibility:hidden !important}';
  const ringBox = await page.locator('.speed-ring').first().boundingBox();
  if (!ringBox) throw new Error('.speed-ring has no box — cannot run the paint diff');
  const vp = page.viewportSize();
  const pad = 16;
  const clip = {
    x: Math.max(0, Math.round(ringBox.x - pad)),
    y: Math.max(0, Math.round(ringBox.y - pad)),
  };
  clip.width = Math.min(Math.round(ringBox.width + pad * 2), vp.width - clip.x);
  clip.height = Math.min(Math.round(ringBox.height + pad * 2), vp.height - clip.y);

  // One probe <style> that each pass rewrites, so the previous pass's hides do
  // not leak into the next one.
  const setProbe = (css) =>
    page.evaluate((c) => {
      let el = document.getElementById('__paint_probe__');
      if (!el) {
        el = document.createElement('style');
        el.id = '__paint_probe__';
        document.head.appendChild(el);
      }
      el.textContent = c;
    }, css);

  async function paintPass(label, isolateCss, killCss) {
    await setProbe(HIDE + isolateCss);
    const on = await page.screenshot({ path: `${outDir}/${label}.png`, clip });
    const on2 = await page.screenshot({ clip });
    await setProbe(HIDE + isolateCss + killCss);
    const off = await page.screenshot({ clip });
    return { noise: await diffShots(page, on, on2), delta: await diffShots(page, on, off) };
  }

  // Bezel alone: hide the svg (arc and both tracks) and the readout, and pin
  // --speed-t so the bezel's speed-reactive opacity cannot drift between shots.
  const bezelPass = await paintPass(
    '06b-ring-bezel',
    '.speed-ring > *{visibility:hidden !important}#app{--speed-t:1 !important}',
    '.speed-ring::before{display:none !important}',
  );
  // Inner ring alone: hide the arc and the background track so the only thing
  // left drawing inside the svg is .track-inner.
  const innerPass = await paintPass(
    '06c-ring-inner',
    '.speed-readout,#speed-arc,.track-bg{visibility:hidden !important}',
    '.track-inner{display:none !important}',
  );

  check(
    'ring paint diff has a flat noise floor',
    bezelPass.noise.over8 < 20 && innerPass.noise.over8 < 20,
    `bezel ${bezelPass.noise.over8}px / inner ${innerPass.noise.over8}px differ >8/255`,
  );
  check(
    'tick bezel actually paints',
    bezelPass.delta.over32 > 150,
    `${bezelPass.delta.over32}px differ >32/255 of ${bezelPass.delta.px}px, mean ${bezelPass.delta.mean}`,
  );
  check(
    'inner reference ring actually paints',
    innerPass.delta.over8 > 40,
    `${innerPass.delta.over8}px differ >8/255 of ${innerPass.delta.px}px, mean ${innerPass.delta.mean}`,
  );

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
  const duoShot = await page.screenshot({ path: `${outDir}/09-race-duo.png` });
  console.log(`  ${outDir}/09-race-duo.png`);

  /*
   * At this point in the run the kart is reliably passing through an item box
   * (reproduced at x=-3.667 z=76.129 across runs), so this box frames the box's
   * rings. Measured 9.71% glare with the old #7cf6ff rings and 2.32% after, so
   * 5% sits between them with room on both sides.
   */
  const duoGlare = await glareStats(page, duoShot, { x: 380, y: 270, w: 520, h: 290 });
  check(
    'duo frame is not washed out by the item-box rings',
    duoGlare < 0.05,
    `glare ${(duoGlare * 100).toFixed(2)}% of the kart region`,
  );

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
    const picker = document.querySelector('#track-picker');
    const r = card.getBoundingClientRect();
    const m = map.getBoundingClientRect();
    const pr = picker.getBoundingClientRect();
    const cards = [...document.querySelectorAll('.track-btn')].map((b) =>
      Math.round(b.getBoundingClientRect().width),
    );
    return {
      over: el.scrollWidth - el.clientWidth,
      cardH: Math.round(r.height),
      cardW: Math.round(r.width),
      mapW: Math.round(m.width),
      mapInside: m.right <= r.right + 0.5 && m.left >= r.left - 0.5,
      /*
       * The picker is a sideways-scrolling flex row now, so `gridTemplateColumns`
       * is the wrong thing to read — it held whatever the last grid declaration
       * left behind and kept passing. Assert the mechanics of the carousel
       * instead: the row must overflow (so there is something to scroll), must
       * not overflow vertically (or it would clip the cards), and must leave the
       * next card peeking, which is the only affordance telling a thumb that the
       * row moves.
       */
      display: getComputedStyle(picker).display,
      scrollX: picker.scrollWidth - picker.clientWidth,
      scrollY: picker.scrollHeight - picker.clientHeight,
      pickerH: Math.round(pr.height),
      cards,
      peek: Math.round(picker.clientWidth - cards[0] - 10),
    };
  });
  check('phone panel has no horizontal overflow', panel.over <= 1, `+${panel.over}px`);
  check('phone map fits inside its card', panel.mapInside, `map=${panel.mapW} card=${panel.cardW}`);
  check(
    'phone track row scrolls sideways',
    panel.display === 'flex' && panel.scrollX > 0 && panel.scrollY <= 1,
    `display=${panel.display} scrollX=${panel.scrollX}px scrollY=${panel.scrollY}px`,
  );
  check(
    'phone track row leaves the next card peeking',
    panel.peek > 20 && panel.peek < panel.cards[0],
    `peek=${panel.peek}px of a ${panel.cards[0]}px card (row ${panel.pickerH}px tall)`,
  );

  /*
   * This used to be a budget assertion, because four full-width track cards put
   * 开始比赛 150px below the fold and `ctaFits` would have been permanently red.
   * The cards are a carousel now, the whole menu fits, and the real assertion is
   * finally worth making: if it ever goes red again, something made the panel
   * taller than the screen.
   */
  const phoneCta = await page.evaluate(() => {
    const p = document.querySelector('#overlay-start .panel');
    const btn = document.querySelector('#start-button');
    const pr = p.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      fits: br.bottom <= pr.bottom + 0.5,
      slack: Math.round(pr.bottom - br.bottom),
      panelScroll: p.scrollHeight - p.clientHeight,
    };
  });
  check(
    'phone CTA is above the fold',
    phoneCta.fits,
    `slack=${phoneCta.slack}px panelScroll=${phoneCta.panelScroll}px`,
  );

  /*
   * Duo mode on a touch device hides #touch-controls and P2 has no touch
   * binding, so the split screen is inert for both players. The menu has to say
   * so next to the button that causes it — and on a 360x740 phone the last line
   * of the panel is off screen, which is why this lives under the mode buttons
   * rather than in the footer hint.
   */
  const duoNote = await page.evaluate(() => {
    const note = document.querySelector('#overlay-start .mode-note');
    const solo = note && getComputedStyle(note).display === 'none';
    document.querySelector('#mode-duo').click();
    return {
      hiddenInSolo: !!solo,
      shownInDuo: !!note && getComputedStyle(note).display !== 'none',
      text: note ? note.textContent.trim() : null,
      visible:
        !!note && note.getBoundingClientRect().bottom <=
          document.querySelector('#overlay-start .panel').getBoundingClientRect().bottom + 0.5,
    };
  });
  await shoot(page, '10b-menu-phone-duo');
  check(
    'phone duo mode says a keyboard is required',
    duoNote.hiddenInSolo && duoNote.shownInDuo && duoNote.visible && /键盘/.test(duoNote.text ?? ''),
    `solo=hidden:${duoNote.hiddenInSolo} duo=shown:${duoNote.shownInDuo} visible=${duoNote.visible} "${duoNote.text}"`,
  );
  await page.evaluate(() => document.querySelector('#mode-solo').click());

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
    window.__THREE_GAME_TEST_HOOKS__.grantItem('turbo');
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(1500);
  await shoot(page, '11-race-phone');
  await ctx.close();
}

/* --------------------------------------------------------- phone landscape */

/*
 * hint-layout-probe already asserts this viewport's geometry, but nobody was
 * looking at its pixels. A landscape phone is the shortest viewport the game
 * supports (390px tall), so it is where a vertical budget overrun shows up
 * first — the same failure that pushed the start CTA under the fold on desktop.
 */
{
  const { ctx, page } = await open({ width: 844, height: 390 });
  console.log('\n== phone landscape 844x390 ==');
  await shoot(page, '14-menu-landscape');
  const land = await page.evaluate(() => {
    const panel = document.querySelector('#overlay-start .panel');
    const btn = document.querySelector('#start-button');
    const pr = panel.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    return {
      over: panel.scrollWidth - panel.clientWidth,
      ctaFits: br.bottom <= pr.bottom + 0.5,
      slack: Math.round(pr.bottom - br.bottom),
      panelScroll: panel.scrollHeight - panel.clientHeight,
    };
  });
  check('landscape panel has no horizontal overflow', land.over <= 1, `+${land.over}px`);
  check(
    'landscape CTA is above the fold',
    land.ctaFits,
    `slack=${land.slack}px panelScroll=${land.panelScroll}px`,
  );

  /*
   * The worst case for the landscape budget: a saved race puts 继续上次比赛 back
   * on the menu, which is one more 48px pill competing for the same column. The
   * button ships with an inline `display: none`, so force it on, measure, and
   * take it back off.
   */
  const withSave = await page.evaluate(() => {
    const el = document.createElement('style');
    el.id = '__force_continue__';
    el.textContent = '#overlay-start #continue-button{display:block !important}';
    document.head.appendChild(el);
    const panel = document.querySelector('#overlay-start .panel');
    const btn = document.querySelector('#start-button');
    const pr = panel.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    const res = {
      ctaFits: br.bottom <= pr.bottom + 0.5,
      slack: Math.round(pr.bottom - br.bottom),
      panelScroll: panel.scrollHeight - panel.clientHeight,
    };
    el.remove();
    return res;
  });
  check(
    'landscape CTA survives a saved race',
    withSave.ctaFits,
    `slack=${withSave.slack}px panelScroll=${withSave.panelScroll}px`,
  );

  /*
   * The finish and pause overlays keep layout at opacity 0, so all three panels
   * can be measured in one pass. They are in this block on purpose: the same
   * landscape reflow covers all three, and on a landscape phone being unable to
   * restart after a race is as fatal as being unable to start one.
   */
  const measure = ([sel, ctaSel]) =>
    (() => {
      const p = document.querySelector(`${sel} .panel`);
      const cta = document.querySelector(ctaSel);
      if (!p || !cta) return { missing: true };
      const pr = p.getBoundingClientRect();
      const cr = cta.getBoundingClientRect();
      const stats = p.querySelector('.finish-stats');
      return {
        ctaFits: cr.bottom <= pr.bottom + 0.5,
        slack: Math.round(pr.bottom - cr.bottom),
        over: p.scrollWidth - p.clientWidth,
        scroll: p.scrollHeight - p.clientHeight,
        statCols: stats ? getComputedStyle(stats).gridTemplateColumns.split(' ').length : null,
      };
    })();

  const pause = await page.evaluate(measure, ['#overlay-pause', '#resume-button']);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('complete'));
  await page.waitForTimeout(300);
  const finish = await page.evaluate(measure, ['#overlay-finish', '#restart-button']);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('menu'));
  await page.waitForTimeout(300);

  check(
    'landscape finish CTA is above the fold',
    finish.ctaFits,
    `slack=${finish.slack}px panelScroll=${finish.scroll}px`,
  );
  check(
    'landscape finish stats stay on one row',
    finish.statCols === 3,
    `grid-template-columns has ${finish.statCols} tracks`,
  );
  check(
    'landscape pause CTA is above the fold',
    pause.ctaFits,
    `slack=${pause.slack}px panelScroll=${pause.scroll}px`,
  );

  await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__.setState('active-play');
    window.__THREE_GAME_TEST_HOOKS__.grantItem('turbo');
  });
  await page.keyboard.down('w');
  await page.waitForTimeout(1500);

  /*
   * hint-layout-probe covers the wording at this viewport, but only on a page
   * that has never left the menu. This block walks menu -> complete -> menu ->
   * active-play, and the drift hint is written from a `!== last` guard inside
   * the HUD, so a stale string is exactly the kind of thing that only shows up
   * after a state round-trip. Read it here, where the player would read it.
   */
  const wording = await page.evaluate(() => ({
    hint: document.querySelector('#drift-hint').textContent.trim(),
    padVisible: getComputedStyle(document.querySelector('#touch-controls')).display !== 'none',
    coarse: matchMedia('(pointer: coarse)').matches,
  }));
  check(
    'landscape drift hint matches the touch pad',
    !wording.padVisible || !/Shift|Z\b/.test(wording.hint),
    `hint="${wording.hint}" pad=${wording.padVisible} coarse=${wording.coarse}`,
  );

  await shoot(page, '15-race-landscape');
  /*
   * A full 844x390 frame is not enough to read a 0.72rem label — the drift hint
   * under the nitro bar is ~10px tall there, and eyeballing the wide shot is how
   * a correct touch wording gets misread as the keyboard one. Crop the cluster.
   */
  await closeUp(page, '.nitro-cluster', '16-nitro-landscape');
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
