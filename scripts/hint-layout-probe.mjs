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
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__.setState('active-play'));
  await page.waitForTimeout(1500);

  const out = await page.evaluate(() => {
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
    const visibleKeys = SELECTORS.filter((s) => info[s]?.visible);
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
    const itemLabelEl = document.querySelector('.item-label');
    const itemLabelVisibleText = itemLabelEl
      ? Array.from(itemLabelEl.children)
          .filter((c) => getComputedStyle(c).display !== 'none')
          .map((c) => c.textContent.trim())
          .join(' ') || itemLabelEl.textContent.trim()
      : null;

    return {
      info,
      touchControlsVisible: info['#touch-controls']?.visible ?? false,
      hintText: hint?.text ?? null,
      hintMentionsKeyboard: hint ? /Shift|Z\b|空格|Space|WASD|按 E/i.test(hint.text) : null,
      itemLabelText: itemLabelVisibleText,
      itemLabelVisible: info['.item-label']?.visible ?? false,
      overlaps: collisions,
      // Anything visible that pokes outside the viewport is unusable.
      offscreen: SELECTORS.filter((sel) => {
        const r = info[sel];
        if (!r?.visible) return false;
        return r.left < -0.5 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5 || r.top < -0.5;
      }),
      viewport: { w: innerWidth, h: innerHeight },
    };
  });

  const collisions = out.overlaps;
  const touch = out.touchControlsVisible;

  console.log(`\n===== ${vp.name} ${vp.width}x${vp.height} =====`);
  console.log(`  touch pad visible : ${touch}`);
  console.log(`  drift hint        : ${JSON.stringify(out.hintText)}`);
  console.log(`  item label        : ${JSON.stringify(out.itemLabelText)}`);
  console.log(`  collisions        : ${collisions.length ? collisions.join('  |  ') : '(none)'}`);
  console.log(`  offscreen         : ${out.offscreen.length ? out.offscreen.join('  |  ') : '(none)'}`);
  console.log('  rects:');
  for (const [sel, r] of Object.entries(out.info)) {
    if (!r?.visible) continue;
    const off = r.right > out.viewport.w + 0.5 || r.left < -0.5 ? '  <== OFFSCREEN' : '';
    console.log(
      `    ${sel.padEnd(20)} x ${String(r.left).padStart(4)}..${String(r.right).padStart(4)}  w=${String(r.right - r.left).padStart(3)}  h=${String(r.bottom - r.top).padStart(3)}${off}`,
    );
  }

  results.push({
    viewport: vp.name,
    touch,
    collisions,
    offscreen: out.offscreen,
    // Wording checks only apply where the touch pad is actually on screen.
    keyboardWordingOnTouch: touch ? out.hintMentionsKeyboard : false,
    itemLabelKeyboardOnTouch: touch
      ? /按\s*E|Shift/i.test(out.itemLabelText ?? '')
      : false,
  });
  await ctx.close();
}

await browser.close();

console.log('\n=== summary ===');
const checks = {};
for (const r of results) {
  checks[`${r.viewport}_noCollisions`] = r.collisions.length === 0;
  checks[`${r.viewport}_wordingMatchesLayout`] =
    !r.keyboardWordingOnTouch && !r.itemLabelKeyboardOnTouch;
  checks[`${r.viewport}_nothingOffscreen`] = r.offscreen.length === 0;
}
console.log(JSON.stringify(checks, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log('pass:', pass);
if (!pass) process.exitCode = 1;
