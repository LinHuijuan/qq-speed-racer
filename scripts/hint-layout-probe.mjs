/**
 * Layout probe for the in-race hint strip.
 *
 * Functional assertions cannot see this class of defect: the element exists,
 * the state is correct, nothing throws — but on a phone the text is overlapped
 * by the nitro cluster and still tells the player to press Shift.
 */
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

const VIEWPORTS = [
  { name: 'phone-small', width: 360, height: 740, hasTouch: true, isMobile: true },
  { name: 'mobile', width: 390, height: 844, hasTouch: true, isMobile: true },
  { name: 'phone-landscape', width: 844, height: 390, hasTouch: true, isMobile: true },
  { name: 'tablet', width: 820, height: 1180, hasTouch: true, isMobile: true },
  { name: 'desktop', width: 1280, height: 720 },
];

const results = [];

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    hasTouch: !!vp.hasTouch,
    isMobile: !!vp.isMobile,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10, null, {
    timeout: 60000,
  });

  /*
   * `.panel` scrolls vertically but never horizontally, so a panel whose
   * scrollWidth exceeds its clientWidth is silently clipping a control. That is
   * how the fourth car card and the third difficulty pill were being cut off:
   * they inherited `min-width: 200px` from `.panel button`.
   * Measured on the menu, where the start overlay still has layout; the pause
   * overlay keeps its layout at opacity 0 so it can be measured at any time.
   */
  const menuChrome = await page.evaluate(() => {
    const shown = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    };
    const panelOverflow = ['#overlay-start .panel', '#overlay-pause .panel']
      .map((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const over = el.scrollWidth - el.clientWidth;
        return over > 1 ? `${sel} +${over}px` : null;
      })
      .filter(Boolean);
    return {
      panelOverflow,
      startOverlayUp: document.querySelector('#overlay-start').classList.contains('visible'),
      // In-race chrome must not float above an overlay. #pip-toggle sits at
      // z-index 9, above the overlays at z-index 8, so it used to be clickable
      // on top of the start panel.
      pipToggleShown: shown('#pip-toggle'),
      pauseFabShown: shown('#pause-fab'),
    };
  });
  const panelOverflow = menuChrome.panelOverflow;

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
  await page.waitForTimeout(1500);

  const out = await page.evaluate((forceAlerts) => {
    /*
     * Measure the alert column at its worst case rather than at whatever happens
     * to be up. All four alerts share one column anchored to the top of
     * .hud-bottom and grow *upward*, so each row that appears pushes the ones
     * above it closer to the fixed-height top strip. Measuring only the rows that
     * are visible on a quiet frame measures the easy case; the stall hint is the
     * second of four and only ever appears mid-race, when the wrong-way warning
     * and the coaching line are the ones most likely to be up with it.
     *
     * `ALERTS=natural` skips the forcing, to tell a defect that is always there
     * from one that only the full column produces.
     */
    if (forceAlerts)
      for (const sel of ['#wrong-way', '#stall-hint', '#action-toast', '#coach-hint']) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (sel === '#action-toast') el.textContent = '氮气还没充满';
        if (sel === '#coach-hint') {
          const badge = el.querySelector('#coach-step');
          const text = el.querySelector('#coach-text');
          if (badge) badge.textContent = '1/4';
          if (text) text.textContent = '按住 W（或 ↑）把车跑起来';
        }
        el.classList.add('visible');
      }
    const SELECTORS = [
      '#drift-hint',
      '.nitro-cluster',
      '.item-cluster',
      '.item-label',
      '#item-slot',
      '#touch-controls',
      '#touch-stick',
      '.touch-actions',
      '#drift-button',
      '#reset-button',
      '#hud-bottom',
      '.hud-bottom-right',
      '.speed-cluster',
      // The off-track toast is transient, but when it does appear it must not
      // cover the pad / bottom clusters — that is exactly when the player needs
      // them. It is opacity-animated, so it is measured unconditionally.
      '#offtrack-help',
      // The stall hint shares #hud-alerts with the wrong-way warning and the
      // coaching line, so it is measured for the same reason: the column must
      // stay clear of the clusters below it even when several are up at once.
      '#stall-hint',
      // ...and the column as a whole, because it grows upward from .hud-bottom
      // and the way it fails on a 390px-tall landscape viewport is by reaching
      // the top of the screen. Container, so it is not a collision surface.
      '#hud-alerts',
      '#status-line',
    ];
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40),
        display: cs.display,
        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
      };
    };
    const info = {};
    for (const sel of SELECTORS) info[sel] = rect(sel);

    const overlap = (a, b) =>
      !!a && !!b && a.visible && b.visible &&
      Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

    // Real collisions only: a panel overlapping its own descendants is expected,
    // so ask the DOM whether one contains the other instead of hardcoding pairs.
    const collisions = [];
    /*
     * ...and a box that paints nothing is not a surface to collide with.
     *
     * `#touch-controls` is a transparent full-width flex row — `pointer-events:
     * none`, no background, no border — whose whole job is to push the stick and
     * the action buttons to the two ends of the screen. Its bounding box
     * therefore includes the empty middle, and the alert column is centred, so
     * the two always overlap on paper while nothing is anywhere near anything.
     * With three possible alerts the column stopped short of the pad's band and
     * this never showed; the stall hint is a fourth row, and the column grew into
     * it.
     *
     * It is kept in SELECTORS because `touchControlsVisible` is read from it —
     * that is what the wording assertions key off — but it is not measured as a
     * control. Every control inside it (the stick, the actions cluster, the two
     * buttons) is listed separately and still collides if a pill reaches it.
     */
    const CONTAINERS = new Set(['#touch-controls', '#hud-alerts']);
    const visibleKeys = SELECTORS.filter((s) => !CONTAINERS.has(s) && info[s]?.visible);
    for (let i = 0; i < visibleKeys.length; i += 1) {
      for (let j = i + 1; j < visibleKeys.length; j += 1) {
        const a = visibleKeys[i];
        const b = visibleKeys[j];
        if (!overlap(info[a], info[b])) continue;
        const ea = document.querySelector(a);
        const eb = document.querySelector(b);
        if (ea && eb && (ea.contains(eb) || eb.contains(ea))) continue;
        collisions.push(`${a} x ${b}`);
      }
    }

    const hint = info['#drift-hint'];

    // The item label carries one wording per layout; only the rendered one counts,
    // so read the visible child rather than the container's textContent.
    const visibleChildText = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const parts = Array.from(el.children)
        .filter((c) => getComputedStyle(c).display !== 'none')
        .map((c) => c.textContent.trim());
      return parts.length ? parts.join(' ') : el.textContent.trim();
    };
    const itemLabelVisibleText = visibleChildText('.item-label');
    const offtrackVisibleText = visibleChildText('#offtrack-help');
    // The stall hint is the third place a new player gets told what to do, and it
    // is the only one that has to name a control they may not know exists.
    const stallVisibleText = visibleChildText('#stall-hint');
    /*
     * The menu's controls list is the fourth place wording is swapped, and the
     * largest: it is two full lines of key names. It is a <ul> of <li>s rather
     * than a container of spans, so `visibleChildText` would fall back to the
     * container's textContent when every child is hidden — i.e. it would report
     * the hidden keyboard wording as if it were on screen. Read the list items
     * directly, and treat "nothing visible" as empty rather than as a fallback.
     */
    const visibleListText = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      return Array.from(el.querySelectorAll('li'))
        .filter((c) => getComputedStyle(c).display !== 'none')
        .map((c) => c.textContent.trim().replace(/\s+/g, ' '))
        .join(' | ');
    };
    const controlsVisibleText = visibleListText('.controls-list');
    // The pause hint tells you how to *resume*; on a touch layout the button
    // that does it is on screen, so an Esc reminder is worse than nothing.
    const pauseHintVisibleText = visibleChildText('#overlay-pause .hint');

    return {
      info,
      touchControlsVisible: info['#touch-controls']?.visible ?? false,
      hintText: hint?.text ?? null,
      hintMentionsKeyboard: hint ? /Shift|Z\b|空格|Space|WASD|按 E/i.test(hint.text) : null,
      itemLabelText: itemLabelVisibleText,
      itemLabelVisible: info['.item-label']?.visible ?? false,
      offtrackText: offtrackVisibleText,
      stallText: stallVisibleText,
      controlsText: controlsVisibleText,
      pauseHintText: pauseHintVisibleText,
      overlaps: collisions,
      // Anything visible that pokes outside the viewport is unusable.
      offscreen: SELECTORS.filter((sel) => {
        const r = info[sel];
        if (!r?.visible) return false;
        return r.left < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 || r.top < -0.5;
      }),
      viewport: { w: innerWidth, h: innerHeight },
    };
  }, process.env.ALERTS !== 'natural');

  const collisions = out.overlaps;
  const touch = out.touchControlsVisible;

  console.log(`\n===== ${vp.name} ${vp.width}x${vp.height} =====`);
  console.log(`  touch pad visible : ${touch}`);
  console.log(`  drift hint        : ${JSON.stringify(out.hintText)}`);
  console.log(`  item label        : ${JSON.stringify(out.itemLabelText)}`);
  console.log(`  off-track help    : ${JSON.stringify(out.offtrackText)}`);
  console.log(`  stall hint        : ${JSON.stringify(out.stallText)}`);
  console.log(`  menu controls     : ${JSON.stringify(out.controlsText)}`);
  console.log(`  pause hint        : ${JSON.stringify(out.pauseHintText)}`);
  console.log(`  collisions        : ${collisions.length ? collisions.join('  |  ') : '(none)'}`);
  console.log(`  offscreen         : ${out.offscreen.length ? out.offscreen.join('  |  ') : '(none)'}`);
  console.log(
    `  panel overflow    : ${panelOverflow.length ? panelOverflow.join('  |  ') : '(none)'}`,
  );
  console.log('  rects:');
  for (const [sel, r] of Object.entries(out.info)) {
    if (!r?.visible) continue;
    const off = r.right > out.viewport.w + 0.5 || r.left < -0.5 ? '  <== OFFSCREEN' : '';
    // Vertical bounds matter as much as horizontal ones: the alert column grows
    // *upward* from .hud-bottom, so the way it fails is by reaching the fixed
    // top strip, and the way the pad collides with it is by sharing its y band.
    console.log(
      `    ${sel.padEnd(20)} x ${String(r.left).padStart(4)}..${String(r.right).padStart(4)}  y ${String(r.top).padStart(4)}..${String(r.bottom).padStart(4)}  w=${String(r.right - r.left).padStart(3)}  h=${String(r.bottom - r.top).padStart(3)}${off}`,
    );
  }

  results.push({
    viewport: vp.name,
    touch,
    collisions,
    offscreen: out.offscreen,
    panelOverflow,
    menuChrome,
    // Wording checks only apply where the touch pad is actually on screen.
    keyboardWordingOnTouch: touch ? out.hintMentionsKeyboard : false,
    itemLabelKeyboardOnTouch: touch
      ? /按\s*E|Shift/i.test(out.itemLabelText ?? '')
      : false,
    offtrackKeyboardOnTouch: touch ? /按\s*R|Shift|Esc/i.test(out.offtrackText ?? '') : false,
    // The stall hint names the throttle *and* the way back to the track. On a
    // touch layout both of those are on-screen buttons, so naming W and R is
    // worse than useless: it is the one message whose whole job is to say which
    // control to use, and it would be pointing at controls that do not exist.
    stallKeyboardOnTouch: touch ? /[WR]|Shift/i.test(out.stallText ?? '') : false,
    controlsKeyboardOnTouch: touch
      ? /Shift|WASD|空格|Space|按\s*E/i.test(out.controlsText ?? '')
      : false,
    pauseHintKeyboardOnTouch: touch ? /Esc|Shift/i.test(out.pauseHintText ?? '') : false,
  });
  await ctx.close();
}

await browser.close();

console.log('\n=== summary ===');
const checks = {};
for (const r of results) {
  checks[`${r.viewport}_noCollisions`] = r.collisions.length === 0;
  checks[`${r.viewport}_wordingMatchesLayout`] =
    !r.keyboardWordingOnTouch &&
    !r.itemLabelKeyboardOnTouch &&
    !r.offtrackKeyboardOnTouch &&
    !r.stallKeyboardOnTouch &&
    !r.controlsKeyboardOnTouch &&
    !r.pauseHintKeyboardOnTouch;
  checks[`${r.viewport}_nothingOffscreen`] = r.offscreen.length === 0;
  checks[`${r.viewport}_panelsDontClipControls`] = r.panelOverflow.length === 0;
  checks[`${r.viewport}_menuHidesRaceChrome`] =
    r.menuChrome.startOverlayUp &&
    !r.menuChrome.pipToggleShown &&
    !r.menuChrome.pauseFabShown;
}
console.log(JSON.stringify(checks, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log('pass:', pass);
if (!pass) process.exitCode = 1;
