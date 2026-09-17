import { expect, test } from '@playwright/test';

// Copy this file to tests/bot-playtest.spec.ts to enable automated playtests.
// The bot drives the racing game through scripted real input and measures
// whether progress/lap/speed actually change.

type BotSnapshot = {
  frame: number;
  speed: number;
  totalProgress: number;
  complete: boolean;
  x: number;
  z: number;
};

// Keyboard sweep for the circuit: throttle, steers, a short drift, then boost.
const INPUT_SCRIPT: Array<{ keys: string[]; ms: number }> = [
  { keys: ['KeyW'], ms: 1200 },
  { keys: ['KeyW', 'KeyA'], ms: 900 },
  { keys: ['KeyW', 'KeyD'], ms: 900 },
  { keys: ['KeyW', 'ShiftLeft', 'KeyA'], ms: 700 },
  { keys: ['KeyW', 'Space'], ms: 800 },
  { keys: ['KeyW'], ms: 1200 },
  { keys: ['KeyW', 'KeyD'], ms: 900 },
  { keys: ['KeyW', 'KeyA'], ms: 900 },
];

test('bot playtest: scripted input drives race progress without errors', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name !== 'desktop-chrome',
    'The bot uses keyboard input; mobile touch input is exercised by visual.spec.ts.',
  );
  test.setTimeout(90_000);

  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/');
  await page.waitForFunction(() => (window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0) > 10);
  const acknowledgement = await page.evaluate(async () => {
    const hooks = window.__THREE_GAME_TEST_HOOKS__;
    if (!hooks || typeof hooks.seed !== 'function' || typeof hooks.setState !== 'function') {
      throw new Error('Bot playtests require seed and setState test hooks');
    }
    hooks.seed(12345);
    const applied = hooks.setState('active-play');
    if (!applied || applied.state !== 'active-play') throw new Error('setState must acknowledge active-play');
    return applied;
  });
  expect(acknowledgement.state, 'bot must start in the requested state').toBe('active-play');

  const sample = (): Promise<BotSnapshot | null> =>
    page.evaluate(() => {
      const d = window.__THREE_GAME_DIAGNOSTICS__;
      const player = d?.player;
      if (!d || !player) return null;
      return {
        frame: d.frame,
        speed: player.speed,
        totalProgress: player.totalProgress ?? 0,
        complete: d.complete ?? false,
        x: player.position.x,
        z: player.position.z,
      };
    });

  const before = await sample();
  expect(before, 'diagnostics must be published before the bot can play').not.toBeNull();

  const snapshots: BotSnapshot[] = [before as BotSnapshot];
  let softlockWindows = 0;
  let distance = 0;
  let stepOfFirstProgress = -1;

  for (const [index, step] of INPUT_SCRIPT.entries()) {
    for (const key of step.keys) await page.keyboard.down(key);
    await page.waitForTimeout(step.ms);
    for (const key of step.keys) await page.keyboard.up(key);

    const snap = await sample();
    const prev = snapshots[snapshots.length - 1];
    if (snap) {
      const moved = Math.hypot(snap.x - prev.x, snap.z - prev.z);
      distance += moved;
      const progressed =
        snap.totalProgress > prev.totalProgress + 0.01 ||
        snap.speed > prev.speed + 1 ||
        (snap.complete && !prev.complete);
      if (progressed && stepOfFirstProgress === -1) stepOfFirstProgress = index;
      if (snap.frame > prev.frame && moved < 0.2 && !progressed) softlockWindows += 1;
      snapshots.push(snap);
    }
  }

  const after = snapshots[snapshots.length - 1];
  const report = {
    steps: INPUT_SCRIPT.length,
    framesAdvanced: after.frame - (before as BotSnapshot).frame,
    speedBefore: (before as BotSnapshot).speed,
    speedAfter: after.speed,
    progressBefore: (before as BotSnapshot).totalProgress,
    progressAfter: after.totalProgress,
    complete: after.complete,
    distanceTravelled: Number(distance.toFixed(2)),
    stepOfFirstProgress,
    softlockWindows,
    consoleErrors,
    pageErrors,
  };
  await testInfo.attach('bot-playtest-report', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  console.log(`bot playtest: ${JSON.stringify(report)}`);

  expect(pageErrors, 'page errors during bot play').toEqual([]);
  expect(consoleErrors, 'console errors during bot play').toEqual([]);
  expect(report.framesAdvanced, 'game loop must keep running').toBeGreaterThan(100);
  expect(report.distanceTravelled, 'player must respond to scripted input').toBeGreaterThan(5);
  expect(report.speedAfter, 'throttle should raise speed').toBeGreaterThan(report.speedBefore);
  expect(report.softlockWindows, 'held input repeatedly produced no motion or progress').toBeLessThanOrEqual(2);
});
