/**
 * Newbie-onboarding checks.
 *
 * Everything here covers the "a first-time player does not know what just
 * happened" surface:
 *
 *   1. Silent failures. Pressing 氮气 on an empty tank, holding 漂移 below 12 m/s
 *      or without steering, and pressing 道具 with no item are all no-ops in the
 *      physics. Each now answers.
 *   2. Wrong way. A spin-out is unrecoverable when nothing says which way the
 *      road goes.
 *   3. First-race coaching. Four steps, driven by the player's own actions, then
 *      retired for good and written to settings.
 *   4. The 「怎么玩？」 sheet, both of its entry points, and its wording per
 *      layout.
 *   5. The empty item slot not claiming "press E", and a last-place finish
 *      saying something useful.
 *   6. The three ways a new player ends up motionless or absent — a stopped car
 *      on the track, the final lap, and a tab switch — and the fact that the
 *      race stops when they stop watching it.
 *
 *   node scripts/newbie-check.mjs [url]
 *
 * Env:
 *   PART=1   only the desktop scenario block
 *   PART=2   only the per-viewport block
 *   (unset)  everything
 *
 * `PART` exists for mutation testing. Proving that an assertion can go red means
 * running the suite with a deliberately broken build, and the full suite is six
 * minutes of SwiftShader. Every mutation in this file lands in Part 1, so
 * `PART=1` turns a mutation run into about a minute.
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const part = Number(process.env.PART ?? 0);
const url = process.argv[2] ?? 'http://127.0.0.1:5190';
const exe =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe';

await mkdir('artifacts/newbie-check', { recursive: true });

const checks = [];
const ok = (name, cond, extra) => {
  checks.push({ name, pass: !!cond, extra });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? `   ${extra}` : ''}`);
  return !!cond;
};

const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});

const errors = [];
/**
 * Renderer crashes and post-boot navigations. Kept out of `errors` on purpose:
 * `errors` fails the suite, and a SwiftShader context loss is not a defect in
 * the game. It is still printed every run, so it cannot quietly become normal.
 */
const crashes = [];

/**
 * Contexts opened by `openPage` and not yet released. `scenario` drains this on
 * a failed attempt, because a leaked context is what made a retry time out.
 */
const liveContexts = new Set();

async function openPage(viewport, touch = false) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
  liveContexts.add(ctx);
  const page = await ctx.newPage();
  const tag = `${viewport.width}x${viewport.height}`;
  let booted = false;
  page.on('pageerror', (e) => errors.push(`PAGE ${tag}: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`CON ${tag}: ${m.text()}`);
  });
  // A dead renderer shows up as `Execution context was destroyed` somewhere far
  // from the cause. Name it where it happens instead. (Nothing in the game
  // navigates, so a post-boot navigation is itself a finding.)
  page.on('crash', () => crashes.push(`CRASH ${tag}: the renderer process died`));
  page.on('framenavigated', (f) => {
    if (booted && f === page.mainFrame()) crashes.push(`NAV ${tag}: ${f.url()}`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 3, null, {
    timeout: 40000,
  });
  booted = true;
  return { ctx, page };
}

/** Advances by N rendered frames — the only clock that moves in this environment. */
let lastWaitMs = 0;
async function waitFrames(page, n = 2, timeout = 40000) {
  const t0 = Date.now();
  const start = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);
  const target = start + n;
  while (Date.now() - t0 < timeout) {
    const f = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0);
    if (f >= target) {
      lastWaitMs = Date.now() - t0;
      return true;
    }
    await page.waitForTimeout(60);
  }
  lastWaitMs = Date.now() - t0;
  return false;
}

/**
 * Text of the visible descendants only.
 *
 * Walks the tree and collects *text nodes*, skipping any subtree whose element
 * is `display: none`. The obvious implementation — filter `querySelectorAll('*')`
 * by computed display and join `textContent` — is wrong in a way that took a run
 * to notice: a `<li>` is visible, so it is included, and `li.textContent`
 * contains the hidden wording inside it. Every wording-swap assertion built that
 * way passes on both layouts and proves nothing.
 */
const visibleTextOf = (page, selector) =>
  page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const out = [];
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          const t = child.textContent.trim().replace(/\s+/g, ' ');
          if (t) out.push(t);
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (getComputedStyle(child).display === 'none') continue;
        walk(child);
      }
    };
    walk(root);
    return out.join(' ');
  }, selector);

/**
 * Records every state `#action-toast` passes through, so the assertion can be
 * made against what happened rather than against what is on screen right now.
 *
 * Reading the toast after the fact is a race that lost twice in a row, in two
 * different ways:
 *
 *   - once the keydown edge was never sampled, so `textContent` was `""`
 *   - once the wording was right but `.visible` was already gone
 *
 * Both are harness artefacts. `showAction` retires the pill with a 3-second
 * *wall-clock* `setTimeout`, and this suite runs at 0.2–1 fps — a single
 * `waitFrames(page, 2)` measured in the logs at 3–8 seconds. The game answered
 * both times; the read was simply too late (or too early).
 *
 * The claim under test is "the game answered instead of doing nothing", so
 * observe the element and assert on the observation.
 */
const armToastLog = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#action-toast');
    window.__TOAST_OBS__?.disconnect();
    window.__TOAST_LOG__ = [];
    if (!el) return;
    const snap = (initial) =>
      window.__TOAST_LOG__.push({
        text: el.textContent.trim(),
        visible: el.classList.contains('visible'),
        initial: initial === true,
      });
    const obs = new MutationObserver(() => snap(false));
    obs.observe(el, {
      attributes: true,
      attributeFilter: ['class'],
      childList: true,
      subtree: true,
    });
    window.__TOAST_OBS__ = obs;
    // The pre-existing state is recorded but flagged. A toast from the previous
    // section is still on screen for its full 3-second hold, and an un-flagged
    // snapshot of it made the 氮气 assertion fail on the 道具 wording it was
    // explicitly asserting the absence of.
    snap(true);
  });

const toastLog = (page) => page.evaluate(() => window.__TOAST_LOG__ ?? []);

/**
 * Did the game ever show a toast matching every one of these patterns?
 *
 * `initial` entries are ignored: they are the state at arm time, not an answer
 * to the input under test.
 */
function sawToast(log, ...res) {
  return log.some((e) => !e.initial && e.visible && res.every((re) => re.test(e.text)));
}

/** One-line rendering of a toast log for the assertion message. */
const describeToastLog = (log) =>
  JSON.stringify(log.map((e) => `${e.initial ? 'was' : e.visible ? 'on' : 'off'}:${e.text}`));

/**
 * Records every text `#center-banner` shows, for the same reason `armToastLog`
 * exists: it is one reused element, so reading it afterwards reports whichever
 * message landed last.
 *
 * The lap banner is the worst case for that. The very next `update` compares
 * ranks and may overwrite it with "↑ 升至第 N" — and completing a lap is exactly
 * what makes the rank change. A `textContent` read after a `completeLap` is
 * therefore a race, and it is a race the assertion loses silently, by reporting
 * a rank flash that looks like a plausible lap message.
 */
const armBannerLog = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#center-banner');
    window.__BANNER_OBS__?.disconnect();
    window.__BANNER_LOG__ = [];
    if (!el) return;
    const snap = () => {
      const text = el.textContent.trim();
      const log = window.__BANNER_LOG__;
      if (text && log[log.length - 1] !== text) log.push(text);
    };
    const obs = new MutationObserver(snap);
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    window.__BANNER_OBS__ = obs;
    snap();
  });

const bannerLog = (page) => page.evaluate(() => window.__BANNER_LOG__ ?? []);

const hasClass = (page, selector, cls) =>
  page.evaluate(
    ([sel, c]) => document.querySelector(sel)?.classList.contains(c) === true,
    [selector, cls],
  );

/**
 * Runs a scenario block, turning a thrown error into a recorded failure — and
 * giving the block one clean retry first.
 *
 * The retry exists because SwiftShader loses the renderer context every few
 * runs. It has happened three times, always at a `setState(...)` followed by
 * `waitFrames`, and always reported as `Execution context was destroyed, most
 * likely because of a navigation` — but nothing in the game navigates
 * (`grep -r "location.reload\|location.href\s*=" src/` is empty), and the crash
 * moves around between runs. A software rasteriser driving a full post chain,
 * shadows and bloom at 0.2–1 fps runs out of renderer, not out of patience.
 *
 * Three things were wrong with how that surfaced, and all three were the harness:
 *
 *   - An uncaught throw skipped the summary block entirely, so a log ended at
 *     "45 PASS / 2 FAIL" with no total — a flake and a suite that never
 *     finished looked identical.
 *   - A crash is not a product failure, so it must not be reported as one. But
 *     it must not vanish either: it is printed, and it is counted separately in
 *     the summary.
 *   - Rolling back a discarded attempt also rolled back the *failure*, so a run
 *     where the retry could not even boot printed `0/0 passed` and `pass: true`.
 *     A green light from a suite that asserted nothing is the worst possible
 *     outcome, so an exhausted scenario now always leaves a failed check behind.
 *
 * The partial results of a discarded attempt are rolled back, so the assertions
 * are reported exactly once whatever happens.
 */
async function scenario(name, fn) {
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const checksMark = checks.length;
    const errorsMark = errors.length;
    const crashesMark = crashes.length;
    try {
      await fn();
      if (attempt > 1) console.log(`NOTE  ${name}: passed on attempt ${attempt}`);
      return;
    } catch (err) {
      const msg = String(err?.message ?? err).split('\n')[0].slice(0, 160);
      checks.length = checksMark;
      errors.length = errorsMark;
      crashes.length = crashesMark;
      /*
       * Release every context this attempt opened before trying again. On a
       * throw the body's own `ctx.close()` never runs, and the leaked WebGL
       * context keeps the software rasteriser busy enough that the retry's
       * `waitForFunction` timed out at 40s on a page that normally boots in
       * three. The retry has to start from a clean GPU.
       */
      for (const ctx of [...liveContexts]) {
        await ctx.close().catch(() => {});
        liveContexts.delete(ctx);
      }
      if (attempt < attempts) {
        console.log(`RETRY ${name}: ${msg} — reopening with a fresh context`);
        continue;
      }
      crashes.push(`${name}: ${msg}`);
      checks.push({ name, pass: false, extra: msg });
      console.log(`FAIL  ${name}   ${msg}   (after ${attempts} attempts)`);
    }
  }
}

/* ====================================================================== *
 * Part 1 — desktop: silent failures, wrong way, coaching, help, item slot
 * ====================================================================== */

if (part === 0 || part === 1)
await scenario('part 1: the desktop scenario block', async () => {
  const { ctx, page } = await openPage({ width: 1280, height: 720 });
  // Move focus off the menu button: Space activates a focused <button>.
  await page.evaluate(() => document.activeElement?.blur());

  const forceRace = async () => {
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.forceRace?.());
    await waitFrames(page, 2);
    await page.evaluate(() => document.activeElement?.blur());
  };

  /* --- 1. an empty item slot answers ---------------------------------- */
  await forceRace();
  const nitroAtStart = await page.evaluate(
    () => window.__THREE_GAME_DIAGNOSTICS__?.player?.nitro,
  );
  ok(
    'setup: forceRace leaves the slot empty and the tank dry',
    (await hasClass(page, '#item-slot', 'has-item')) === false &&
      nitroAtStart != null &&
      nitroAtStart <= 0.05,
    `nitro=${nitroAtStart}`,
  );

  // Held across frames, not `press()`: `press` is down+up inside ~10ms, and at
  // SwiftShader's ~1fps both land between two `readPlayer1` calls, so the edge
  // never happens. That is a harness artefact, not an input bug — a real tap is
  // ~80ms against a 16ms frame.
  await armToastLog(page);
  await page.keyboard.down('KeyE');
  await waitFrames(page, 2);
  await page.keyboard.up('KeyE');
  const itemLog = await toastLog(page);
  ok(
    'pressing 道具 with nothing held says where items come from',
    sawToast(itemLog, /道具/, /箱/),
    `${describeToastLog(itemLog)} waited=${lastWaitMs}ms`,
  );

  /* --- 2. an empty nitro tank answers --------------------------------- */
  await armToastLog(page);
  await page.keyboard.down('Space');
  await waitFrames(page, 2);
  await page.keyboard.up('Space');
  const nitroLog = await toastLog(page);
  ok(
    'pressing 氮气 with an empty tank answers instead of doing nothing',
    sawToast(nitroLog, /氮气/) && !sawToast(nitroLog, /道具/),
    `${describeToastLog(nitroLog)} waited=${lastWaitMs}ms`,
  );

  /* --- 3. drift with no steering -------------------------------------- */
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await waitFrames(page, 2);
  await page.evaluate(() => document.activeElement?.blur());
  const speedForDrift = await page.evaluate(
    () => window.__THREE_GAME_DIAGNOSTICS__?.player?.speed ?? 0,
  );
  await armToastLog(page);
  await page.keyboard.down('ShiftLeft');
  await waitFrames(page, 2);
  await page.keyboard.up('ShiftLeft');
  const driftLog = await toastLog(page);
  ok(
    'holding 漂移 without steering says what is missing',
    speedForDrift > 12 && sawToast(driftLog, /转向/),
    `speed=${Number(speedForDrift).toFixed(1)} ${describeToastLog(driftLog)} waited=${lastWaitMs}ms`,
  );

  /* --- 4. drift below the speed gate ---------------------------------- */
  await forceRace();
  // Brake down through the gate with the real brake input rather than a hook:
  // this is the path a player actually takes after bouncing off a wall.
  await page.keyboard.down('KeyS');
  let braked = 99;
  for (let i = 0; i < 40; i += 1) {
    await waitFrames(page, 1);
    braked = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.player?.speed ?? 0);
    if (braked <= 12) break;
  }
  await page.keyboard.up('KeyS');
  await armToastLog(page);
  await page.keyboard.down('KeyA');
  await page.keyboard.down('ShiftLeft');
  await waitFrames(page, 2);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyA');
  const slowLog = await toastLog(page);
  ok(
    'drift below the speed gate names the threshold',
    braked <= 12 && sawToast(slowLog, /加速到/),
    `speed=${Number(braked).toFixed(1)} ${describeToastLog(slowLog)} waited=${lastWaitMs}ms`,
  );

  /* --- 5. wrong way --------------------------------------------------- */
  await forceRace();
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.faceBackwards?.());
  const wrongWaySeen = await page
    .waitForFunction(
      () => document.querySelector('#wrong-way')?.classList.contains('visible') === true,
      null,
      { timeout: 40000 },
    )
    .then(() => true)
    .catch(() => false);
  ok('facing backwards raises the wrong-way warning', wrongWaySeen);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await waitFrames(page, 3);
  ok(
    'the wrong-way warning clears once the kart faces the road again',
    (await hasClass(page, '#wrong-way', 'visible')) === false,
  );

  /* --- 6. the item slot stops lying ---------------------------------- */
  await forceRace();
  const emptyLabel = await visibleTextOf(page, '.item-label');
  ok(
    'an empty item slot does not say "press E"',
    !/按\s*E/.test(emptyLabel ?? '') && /箱/.test(emptyLabel ?? ''),
    JSON.stringify(emptyLabel),
  );
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.grantItem?.('turbo'));
  await waitFrames(page, 2);
  const filledLabel = await visibleTextOf(page, '.item-label');
  ok(
    'a filled item slot says how to use it',
    /按\s*E/.test(filledLabel ?? ''),
    JSON.stringify(filledLabel),
  );

  /* --- 7. last place gets a useful line ------------------------------ */
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('complete'));
  await waitFrames(page, 2);
  const lastRank = await page.evaluate(() =>
    window.__THREE_GAME_TEST_HOOKS__?.finishLast?.(),
  );
  await waitFrames(page, 2);
  const tip = await page.evaluate(() => {
    const el = document.querySelector('#finish-record');
    return { text: el?.textContent?.trim() ?? '', shown: el?.style?.display !== 'none' };
  });
  ok(
    'finishing last suggests something actionable',
    lastRank?.rank === 4 && tip.shown && /难度|怎么玩/.test(tip.text),
    `rank=${lastRank?.rank} text=${JSON.stringify(tip.text)}`,
  );

  /* --- 8. help sheet, opened from the menu --------------------------- */
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('menu'));
  await waitFrames(page, 2);
  ok(
    'the menu carries a 怎么玩 entry point',
    await page.evaluate(() => {
      const btn = document.querySelector('#help-button');
      const panel = document.querySelector('#overlay-start .panel');
      if (!btn || !panel || !panel.contains(btn)) return false;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }),
  );
  await page.locator('#help-button').click();
  await waitFrames(page, 2);
  ok(
    'the help sheet opens from the menu and takes input',
    (await hasClass(page, '#overlay-help', 'visible')) &&
      (await page.evaluate(
        () => getComputedStyle(document.querySelector('#overlay-help')).pointerEvents,
      )) === 'auto',
  );
  const helpSteps = await visibleTextOf(page, '.help-steps');
  const helpNote = await visibleTextOf(page, '.help-note');
  ok(
    'desktop help copy teaches the keyboard controls',
    /Shift/.test(helpSteps ?? '') && /空格/.test(helpSteps ?? '') && /按\s*R/.test(helpNote ?? ''),
    JSON.stringify(helpSteps),
  );
  await page.locator('#help-close-button').click();
  await waitFrames(page, 2);
  ok(
    'the help sheet closes from its own button',
    (await hasClass(page, '#overlay-help', 'visible')) === false,
  );

  await page.locator('#help-button').click();
  await waitFrames(page, 1);
  await page.keyboard.press('Escape');
  await waitFrames(page, 1);
  ok(
    'Escape closes the help sheet without resuming anything',
    (await hasClass(page, '#overlay-help', 'visible')) === false &&
      (await hasClass(page, '#overlay-start', 'visible')),
  );

  /* --- 9. help sheet from the pause panel ---------------------------- */
  await forceRace();
  await page.keyboard.press('Escape');
  await waitFrames(page, 2);
  const pausedFirst = await hasClass(page, '#overlay-pause', 'visible');
  await page.locator('#pause-help-button').click();
  await waitFrames(page, 2);
  ok(
    'the pause panel can open the help sheet, and yields to it',
    pausedFirst &&
      (await hasClass(page, '#overlay-help', 'visible')) &&
      (await hasClass(page, '#overlay-pause', 'visible')) === false,
  );
  await page.keyboard.press('Escape');
  await waitFrames(page, 2);
  ok(
    'closing it returns to the pause panel, not to a live car',
    (await hasClass(page, '#overlay-help', 'visible')) === false &&
      (await hasClass(page, '#overlay-pause', 'visible')),
  );

  /* --- 10. coaching: armed on a first race, not on a later one -------- */
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('menu'));
  await waitFrames(page, 1);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setCoachDone?.(false));
  await page.locator('#start-button').click();
  await waitFrames(page, 2);
  const armed = await page.evaluate(() => ({
    phase: window.__THREE_GAME_DIAGNOSTICS__?.phase,
    step: window.__THREE_GAME_DIAGNOSTICS__?.coach?.step,
    visible: document.querySelector('#coach-hint')?.classList.contains('visible'),
    badge: document.querySelector('#coach-step')?.textContent,
    text: document.querySelector('#coach-text')?.textContent,
  }));
  ok(
    'a first race coaches before the lights change',
    armed.phase === 'countdown' && armed.step === 1 && armed.visible === true,
    JSON.stringify(armed),
  );
  ok(
    'coaching step 1 names the throttle on desktop',
    armed.badge === '1/4' && /W/.test(armed.text ?? '') && !/摇杆/.test(armed.text ?? ''),
    JSON.stringify(armed.text),
  );

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('menu'));
  await waitFrames(page, 1);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setCoachDone?.(true));
  await page.locator('#start-button').click();
  await waitFrames(page, 2);
  const laterRace = await page.evaluate(() => ({
    step: window.__THREE_GAME_DIAGNOSTICS__?.coach?.step,
    visible: document.querySelector('#coach-hint')?.classList.contains('visible'),
  }));
  ok(
    'a later race does not coach again',
    laterRace.step === 0 && laterRace.visible === false,
    JSON.stringify(laterRace),
  );

  /* --- 11. coaching advances on the action, then retires for good ----- */
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('active-play'));
  await waitFrames(page, 1);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.armCoach?.());
  await waitFrames(page, 3);
  const advanced = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.coach?.step);
  ok('coaching step 1 retires once the kart is moving', advanced === 2, `step=${advanced}`);

  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setCoachStep?.(0));
  await waitFrames(page, 2);
  const retired = await page.evaluate(() => ({
    step: window.__THREE_GAME_DIAGNOSTICS__?.coach?.step,
    done: window.__THREE_GAME_DIAGNOSTICS__?.coach?.done,
    visible: document.querySelector('#coach-hint')?.classList.contains('visible'),
    stored: JSON.parse(localStorage.getItem('neon-rush-settings') ?? '{}').coachDone,
  }));
  ok(
    'finishing the coaching is written to settings',
    retired.step === 0 && retired.visible === false && retired.done === true && retired.stored === true,
    JSON.stringify(retired),
  );

  /* --- 12. the final lap is named, not numbered ---------------------- */
  /*
   * "第 3 圈" is accurate and tells a first-time player nothing: they have no
   * idea the race is three laps long, so the one lap where the remaining
   * distance matters most was the one lap that did not say it.
   *
   * Both laps are completed without a rendered frame between them — a frame here
   * is up to 5 seconds, and `update` drives the same lap callout from the kart's
   * own progress. But they cannot be completed in the same *task* either:
   * `showBanner` writes `textContent` on one shared element, and a
   * MutationObserver callback reads the element rather than the record, so two
   * writes in one task collapse into one observation and "第 2 圈" is never
   * logged. The first run of this assertion failed on exactly that, reporting a
   * rank flash and the final lap with the middle one missing. `setTimeout(0)` is
   * the task boundary that flushes the observer without giving the renderer a
   * frame to advance the simulation.
   */
  await forceRace();
  await armBannerLog(page);
  await page.evaluate(async () => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.completeLap?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    hooks?.completeLap?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await waitFrames(page, 1);
  const banners = await bannerLog(page);
  ok(
    'the lap before the last is still announced by number',
    banners.some((t) => /第\s*2\s*圈/.test(t)),
    JSON.stringify(banners),
  );
  ok(
    'the final lap is called out as the final lap',
    banners.some((t) => /最后一圈/.test(t)),
    JSON.stringify(banners),
  );

  /* --- 13. the race stops when the player stops watching it ---------- */
  /*
   * The claim is not "an overlay appears" — it is "the simulation is not still
   * running". `update` returns early while paused, so `raceTime` is the honest
   * probe, and `stepSim` is what makes it readable: 60 synthetic steps is one
   * simulated second, which is a number this environment can produce in
   * milliseconds and could not produce in a minute of real frames.
   *
   * The unpaused run is measured first. Without it, "raceTime did not move" is
   * also what a broken `stepSim` reports, and the assertion would pass on a game
   * that never paused.
   */
  await forceRace();
  const clock = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.raceTime ?? 0);
  await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.stepSim?.(60));
  const clockAfter = await page.evaluate(() => window.__THREE_GAME_DIAGNOSTICS__?.raceTime ?? 0);
  ok(
    'setup: 60 simulated steps advance the race clock by one second',
    Math.abs(clockAfter - clock - 1) < 0.05,
    `${clock.toFixed(2)} -> ${clockAfter.toFixed(2)}`,
  );

  await forceRace();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const blurred = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    const before = window.__THREE_GAME_DIAGNOSTICS__?.raceTime ?? 0;
    hooks?.stepSim?.(60);
    return {
      paused: document.querySelector('#overlay-pause')?.classList.contains('visible') === true,
      advanced: (window.__THREE_GAME_DIAGNOSTICS__?.raceTime ?? 0) - before,
    };
  });
  ok(
    'losing window focus pauses the race instead of letting it run on',
    blurred.paused && Math.abs(blurred.advanced) < 0.001,
    JSON.stringify(blurred),
  );

  await forceRace();
  const hidden = await page.evaluate(() => {
    /*
     * `document.hidden` is a getter on Document.prototype and is read-only in a
     * real tab, so a dispatched event alone would take the `!document.hidden`
     * branch and assert nothing. Overriding it on the instance is the only way
     * to reach the tab-switch path from inside the page; it is restored below.
     */
    const proto = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const paused = document.querySelector('#overlay-pause')?.classList.contains('visible') === true;
    const before = window.__THREE_GAME_DIAGNOSTICS__?.raceTime ?? 0;
    window.__THREE_GAME_TEST_HOOKS__?.stepSim?.(60);
    const advanced = (window.__THREE_GAME_DIAGNOSTICS__?.raceTime ?? 0) - before;
    // Coming back must not resume: there is no countdown on the way in, so an
    // automatic resume drops the player straight into a live car mid-corner.
    window.dispatchEvent(new Event('focus'));
    const stillPaused =
      document.querySelector('#overlay-pause')?.classList.contains('visible') === true;
    if (proto) Object.defineProperty(document, 'hidden', proto);
    return { paused, advanced, stillPaused };
  });
  ok(
    'hiding the tab pauses the race, and coming back does not resume it',
    hidden.paused && Math.abs(hidden.advanced) < 0.001 && hidden.stillPaused,
    JSON.stringify(hidden),
  );

  /* --- 14. a car that has stopped is told how to go again ------------ */
  /*
   * The third way a new player ends up motionless. `#offtrack-help` covers
   * leaving the road and the wrong-way warning covers facing backwards, but the
   * ordinary wall bounce leaves the kart *on* the road and side-on to it, where
   * neither fires and the throttle does nothing they can see.
   *
   * The threshold is 2.5 s of race time, which is 50 rendered frames at the
   * clamped 0.05 delta — one to four minutes here. `stepSim` drives the real
   * `update` instead, so the accumulation, the off-track gate and the coaching
   * gate are all the shipped ones and only the clock is synthetic.
   */
  const stalledEarly = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.forceRace?.();
    hooks?.stallKart?.();
    hooks?.stepSim?.(60); // 1.0 s — a hard brake into a hairpin
    return {
      visible: document.querySelector('#stall-hint')?.classList.contains('visible') === true,
      speed: window.__THREE_GAME_DIAGNOSTICS__?.player?.speed ?? -1,
    };
  });
  ok(
    'a car that has just stopped is not nagged',
    stalledEarly.visible === false && stalledEarly.speed <= 1.5,
    JSON.stringify(stalledEarly),
  );

  const stalledLate = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.stepSim?.(120); // +2.0 s = 3.0 s stopped
    return {
      visible: document.querySelector('#stall-hint')?.classList.contains('visible') === true,
      speed: window.__THREE_GAME_DIAGNOSTICS__?.player?.speed ?? -1,
    };
  });
  ok(
    'a car that has been stopped for three seconds says how to restart it',
    stalledLate.visible === true,
    JSON.stringify(stalledLate),
  );

  /*
   * The throttle is held for real rather than simulated through a hook, because
   * `stepSim` calls the same `update` the render loop does and `update` reads the
   * same input state — so `keyboard.down` plus `stepSim` is the actual driving
   * path, not an approximation of it.
   */
  await page.keyboard.down('KeyW');
  const restarted = await page.evaluate(() => {
    window.__THREE_GAME_TEST_HOOKS__?.stepSim?.(30);
    return {
      visible: document.querySelector('#stall-hint')?.classList.contains('visible') === true,
      speed: window.__THREE_GAME_DIAGNOSTICS__?.player?.speed ?? -1,
    };
  });
  await page.keyboard.up('KeyW');
  ok(
    'the stall hint clears as soon as the car is moving again',
    restarted.visible === false && restarted.speed > 1.5,
    JSON.stringify(restarted),
  );

  /*
   * Two boxes saying the same thing is worse than one. Coaching step 1 is
   * already telling the player to hold the throttle, which is the exact
   * instruction the stall hint carries — and a player who is reading step 1 is
   * by definition a player who has not driven yet, so this is not a rare overlap.
   */
  const coached = await page.evaluate(() => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    hooks?.forceRace?.();
    hooks?.setCoachStep?.(1);
    hooks?.stallKart?.();
    hooks?.stepSim?.(180); // 3.0 s, well past the stall threshold
    return {
      stall: document.querySelector('#stall-hint')?.classList.contains('visible') === true,
      coach: document.querySelector('#coach-hint')?.classList.contains('visible') === true,
      step: window.__THREE_GAME_DIAGNOSTICS__?.coach?.step,
    };
  });
  ok(
    'the stall hint stays out of the way while coaching is asking for the throttle',
    coached.step === 1 && coached.coach === true && coached.stall === false,
    JSON.stringify(coached),
  );

  await ctx.close();
});

/* ====================================================================== *
 * Part 2 — per viewport: wording, and the help sheet's CTA staying reachable
 * ====================================================================== */

const viewports = [
  { name: 'desktop-1280x720', w: 1280, h: 720, touch: false },
  { name: 'laptop-1366x640', w: 1366, h: 640, touch: false },
  { name: 'narrow-700x800', w: 700, h: 800, touch: false },
  { name: 'phone-390x844', w: 390, h: 844, touch: true },
  { name: 'landscape-844x390', w: 844, h: 390, touch: true },
];

if (part === 0 || part === 2)
for (const vp of viewports) {
  // Each viewport is isolated: one dead renderer context must not take the
  // remaining viewports' assertions down with it.
  await scenario(`${vp.name}: the viewport block`, async () => {
    const { ctx, page } = await openPage({ width: vp.w, height: vp.h }, vp.touch);

    /*
     * The wording invariant is not "keyboard device vs touch device" — it is "does
     * the on-screen pad exist". `(pointer: coarse), (max-width: 820px)` is the
     * union of a touch device and a narrow *desktop* window, and a 700x800 window
     * with a mouse gets the pad too (the `and (pointer: fine)` block only restores
     * the picker columns). So the expected wording is read from the same thing the
     * player sees: whether #touch-controls is on screen. The two sides come from
     * different systems — CSS here, TypeScript in `Hud.isTouchLayout` — so a
     * mismatch still fails.
     */
    const padShown = await page.evaluate(
      () => getComputedStyle(document.querySelector('#touch-controls')).display !== 'none',
    );

    // All four coaching steps, pinned so the state machine cannot move on before
    // the text has been read.
    const coachTexts = [];
    for (let step = 1; step <= 4; step += 1) {
      await page.evaluate((n) => window.__THREE_GAME_TEST_HOOKS__?.setCoachStep?.(n), step);
      await waitFrames(page, 1);
      coachTexts.push(
        await page.evaluate(() => document.querySelector('#coach-text')?.textContent ?? ''),
      );
    }
    const coachCopy = coachTexts.join(' | ');
    ok(
      `${vp.name}_coachCopyMatchesLayout`,
      padShown
        ? !/Shift|空格/.test(coachCopy) && /摇杆|「漂移」|「氮气」/.test(coachCopy)
        : !/摇杆/.test(coachCopy) && /Shift|空格|W/.test(coachCopy),
      `pad=${padShown} ${JSON.stringify(coachCopy)}`,
    );

    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.setState('menu'));
    await waitFrames(page, 1);
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.openHelp?.());
    await waitFrames(page, 2);

    const helpCopy = await visibleTextOf(page, '.help-steps');
    ok(
      `${vp.name}_helpCopyMatchesLayout`,
      padShown ? !/Shift|空格/.test(helpCopy ?? '') : /Shift/.test(helpCopy ?? ''),
      `pad=${padShown} ${JSON.stringify(helpCopy)}`,
    );

    /*
     * The stall hint is the fifth place wording is swapped, and the only one
     * whose whole job is to name the control to use — it is the message a player
     * reads while already stuck, so pointing at a key they do not have is worse
     * than saying nothing. Read the visible child rather than the container:
     * both wordings live inside #stall-hint and the container's textContent
     * carries both, which is how a wording assertion passes on every layout.
     */
    const stallCopy = await page.evaluate(() => {
      const el = document.querySelector('#stall-hint');
      if (!el) return null;
      return Array.from(el.children)
        .filter((c) => getComputedStyle(c).display !== 'none')
        .map((c) => c.textContent.trim().replace(/\s+/g, ' '))
        .join(' ');
    });
    ok(
      `${vp.name}_stallCopyMatchesLayout`,
      padShown
        ? /摇杆/.test(stallCopy ?? '') && !/[WR]/.test(stallCopy ?? '')
        : /W/.test(stallCopy ?? '') && /R/.test(stallCopy ?? '') && !/摇杆/.test(stallCopy ?? ''),
      `pad=${padShown} ${JSON.stringify(stallCopy)}`,
    );

    const geom = await page.evaluate(() => {
      const panel = document.querySelector('#overlay-help .panel');
      const cta = document.querySelector('#help-close-button');
      const steps = document.querySelector('.help-steps');
      if (!panel || !cta) return null;
      const p = panel.getBoundingClientRect();
      const c = cta.getBoundingClientRect();
      return {
        // The panel scrolls, so "fits" means the button is inside the panel's own
        // visible box — not merely inside the viewport.
        ctaSlack: Math.round(p.bottom - c.bottom),
        ctaInViewport: c.bottom <= innerHeight + 0.5 && c.top >= -0.5,
        panelScroll: Math.round(panel.scrollHeight - panel.clientHeight),
        stepsOverflow: steps ? Math.round(steps.scrollWidth - steps.clientWidth) : 0,
        vh: innerHeight,
      };
    });
    ok(
      `${vp.name}_helpCtaIsAboveTheFold`,
      !!geom && geom.ctaSlack >= 0 && geom.ctaInViewport,
      JSON.stringify(geom),
    );
    ok(
      `${vp.name}_helpStepsDoNotOverflowSideways`,
      !!geom && geom.stepsOverflow <= 1,
      JSON.stringify(geom),
    );

    // The new entry point must not have cost the menu's own CTA its clearance.
    await page.evaluate(() => window.__THREE_GAME_TEST_HOOKS__?.closeHelp?.());
    await waitFrames(page, 2);
    const menu = await page.evaluate(() => {
      const panel = document.querySelector('#overlay-start .panel');
      const cta = document.querySelector('#start-button');
      const btn = document.querySelector('#help-button');
      if (!panel || !cta || !btn) return null;
      const p = panel.getBoundingClientRect();
      const c = cta.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return {
        slack: Math.round(p.bottom - c.bottom),
        helpBtn: { w: Math.round(b.width), h: Math.round(b.height) },
        ctaInViewport: c.bottom <= innerHeight + 0.5,
      };
    });
    ok(
      `${vp.name}_menuCtaStillReachable`,
      !!menu && menu.slack >= 0 && menu.ctaInViewport,
      JSON.stringify(menu),
    );
    ok(
      `${vp.name}_helpButtonIsTappable`,
      !!menu && menu.helpBtn.w >= 56 && menu.helpBtn.h >= 24,
      JSON.stringify(menu?.helpBtn),
    );

    await ctx.close();
  });
}

await browser.close();

console.log('\n=== summary ===');
const failed = checks.filter((c) => !c.pass);
console.log(`${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) console.log('failed:', failed.map((f) => f.name).join(', '));
if (errors.length) console.log('console errors:', errors.slice(0, 6));
// Printed unconditionally, including on a green run: a context loss that gets
// retried into a pass is still worth knowing about before it becomes a real
// failure on a slower machine.
console.log('renderer crashes:', crashes.length ? crashes.join(' | ') : 'none');
// A suite that asserted nothing is not a passing suite. Guarding this explicitly
// because the rollback path once produced exactly that.
if (checks.length === 0) console.log('failed: no assertions ran');
const pass = failed.length === 0 && errors.length === 0 && checks.length > 0;
console.log('pass:', pass);
if (!pass) process.exitCode = 1;
