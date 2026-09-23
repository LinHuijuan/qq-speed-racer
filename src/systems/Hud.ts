export type MinimapDot = {
  x: number;
  z: number;
  color: string;
  isPlayer?: boolean;
};

/**
 * The minimap is a decoration, not a readout — 15fps is indistinguishable from
 * 60fps here and saves a full canvas repaint on every frame.
 */
const MINIMAP_INTERVAL_MS = 66;
const MINIMAP_PAD = 8;

export type HudMode = 'solo' | 'duo';

export type RaceHudState = {
  mode: HudMode;
  rank: number;
  rank2?: number;
  totalRacers: number;
  lap: number;
  lap2?: number;
  totalLaps: number;
  time: number;
  bestLap: number | null;
  speedKmh: number;
  speed2Kmh?: number;
  nitro: number;
  nitro2?: number;
  boosting: boolean;
  boosting2?: boolean;
  drifting: boolean;
  status: string;
  gear: string;
  gear2?: string;
  driftChargeLevel: number;
  driftChargeLevel2?: number;
  driftScore?: number;
  item: string | null;
  item2?: string | null;
  itemLabel: string;
  itemLabel2?: string;
  trackPath?: Array<{ x: number; z: number }>;
  dots?: MinimapDot[];
};

export class Hud {
  private readonly rankValue = this.el('#rank-value');
  private readonly lapValue = this.el('#lap-value');
  private readonly timerValue = this.el('#timer-value');
  private readonly bestValue = this.el('#best-value');
  private readonly speedValue = this.el('#speed-value');
  private readonly speedArc = this.el('#speed-arc') as unknown as SVGCircleElement;
  private readonly gearValue = this.el('#gear-value');
  private readonly nitroFill = this.el('#nitro-fill');
  private readonly nitroPercent = this.el('#nitro-percent');
  private readonly nitroFlash = this.el('#nitro-flash');
  private readonly statusLine = this.el('#status-line');
  private readonly driftHint = this.el('#drift-hint');
  /**
   * Mirrors the stylesheet's touch breakpoint. The drift hint is set from here
   * rather than the markup, so it has to pick its own wording.
   */
  private readonly touchLayout = window.matchMedia('(pointer: coarse), (max-width: 820px)');
  private readonly countdown = this.el('#countdown');
  private readonly overlayStart = this.el('#overlay-start');
  private readonly overlayFinish = this.el('#overlay-finish');
  private readonly minimap = this.el('#minimap') as HTMLCanvasElement;
  private readonly trackName = this.el('#track-name');
  private readonly centerBanner = this.el('#center-banner');
  private readonly comboStack = this.el('#combo-stack');
  private readonly itemSlot = this.el('#item-slot');
  private readonly itemLabel = this.el('#item-label');
  private readonly wrongWay = this.el('#wrong-way');
  private readonly actionToast = this.el('#action-toast');
  private readonly coachHint = this.el('#coach-hint');
  private readonly coachStep = this.el('#coach-step');
  private readonly coachText = this.el('#coach-text');
  private readonly itemIcon = this.el('#item-icon');
  private readonly driftPips = [
    this.el('#drift-pip-1'),
    this.el('#drift-pip-2'),
    this.el('#drift-pip-3'),
  ];
  private readonly driftScore = this.el('#drift-score');
  private readonly duoPanel = this.el('#duo-panel');
  private readonly p2Speed = this.el('#p2-speed');
  private readonly p2Gear = this.el('#p2-gear');
  private readonly p2Nitro = this.el('#p2-nitro-fill');
  private readonly p2NitroPct = this.el('#p2-nitro-percent');
  private readonly p2Item = this.el('#p2-item-icon');
  private readonly p2ItemSlot = this.el('#p2-item-slot');
  private readonly p2Pips = [
    this.el('#p2-drift-pip-1'),
    this.el('#p2-drift-pip-2'),
    this.el('#p2-drift-pip-3'),
  ];
  private readonly rankLabel = this.el('#rank-label');
  private trackBounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
  /** Static track outline, rendered once instead of re-stroking every frame. */
  private minimapBase: HTMLCanvasElement | null = null;
  private lastMinimapAt = 0;
  /**
   * Last value written to each HUD element. `update()` runs on every frame and
   * used to push ~25 DOM writes unconditionally, which kept the style engine
   * busy even when nothing had changed (which is most frames).
   */
  private readonly last = {
    rank: '',
    lap: '',
    timer: '',
    best: '',
    speed: '',
    arc: '',
    hot: false,
    gear: '',
    nitroPct: '',
    nitroFull: false,
    pips: -1,
    driftScore: '',
    itemIcon: '',
    hasItem: false,
    p2Speed: '',
    p2Gear: '',
    p2NitroPct: '',
    p2Pips: -1,
    p2ItemIcon: '',
    p2HasItem: false,
    hint: '',
    hintColor: '',
    status: '',
  };

  /*
   * Alerts are event driven, not per-frame, so they are written directly rather
   * than diffed through `last` like the chips. The only state worth caching is
   * "is it up", because toggling a class off and on again every frame would
   * restart the entrance animation.
   */
  private actionToken = 0;
  private lastActionText = '';
  private lastActionAt = Number.NEGATIVE_INFINITY;
  private wrongWayShown = false;
  /** `step/total|text` — one key, so a repeat frame costs nothing. */
  private coachKey = '';

  setMode(mode: HudMode): void {
    this.duoPanel.style.display = mode === 'duo' ? '' : 'none';
    document.body.classList.toggle('duo-mode', mode === 'duo');
    this.rankLabel.textContent = mode === 'duo' ? 'P1排名' : '排名';
  }

  resetMinimapBounds(): void {
    this.trackBounds = null;
    this.minimapBase = null;
    this.lastMinimapAt = 0;
  }

  setTrackName(name: string): void {
    this.trackName.textContent = name;
  }

  setTrackBest(seconds: number | null): void {
    // Reuse best-value chip on start overlay as historical best when not racing.
    //
    // `null` means "this track has no record yet", and it has to clear the chip.
    // Writing nothing left the previous track's time on screen: race 霓虹环城
    // (best 01:12.34), pick a track you have never finished, and the chip still
    // read 01:12.34 — a record for a different circuit. `update()` would not
    // correct it either, because its own `last.best` cache is already
    // '--:--.--' when no lap has completed, so it skips the write.
    this.bestValue.textContent = seconds == null ? '--:--.--' : formatTime(seconds);
    this.last.best = this.bestValue.textContent;
  }

  showBanner(text: string, kind: 'lap' | 'rank' | 'boost' = 'boost'): void {
    this.centerBanner.textContent = text;
    this.centerBanner.classList.remove('show', 'lap', 'rank');
    if (kind === 'lap') this.centerBanner.classList.add('lap');
    if (kind === 'rank') this.centerBanner.classList.add('rank');
    void this.centerBanner.offsetWidth;
    this.centerBanner.classList.add('show');
  }

  showCombo(label: string, count: number): void {
    const chip = document.createElement('div');
    chip.className = count >= 3 ? 'combo-chip big' : 'combo-chip';
    chip.textContent = count >= 3 ? `${label} ×${count} COMBO!` : `${label} ×${count}`;
    this.comboStack.appendChild(chip);
    window.setTimeout(() => chip.remove(), 1100);
    // Keep stack short
    while (this.comboStack.children.length > 4) {
      this.comboStack.firstElementChild?.remove();
    }
  }

  showStart(): void {
    this.overlayStart.style.display = '';
    this.overlayStart.classList.add('visible');
    this.overlayFinish.classList.remove('visible');
    this.overlayFinish.style.display = 'none';
    this.countdown.textContent = '';
  }

  hideStart(): void {
    this.overlayStart.classList.remove('visible');
    this.overlayStart.style.display = 'none';
  }

  showFinish(summary: {
    title: string;
    eyebrow: string;
    time: number;
    rank: number;
    total: number;
    bestLap: number | null;
    trackBest?: number | null;
    newRecord?: boolean;
    duoSummary?: string;
    /** Replaces the record line when there is a suggestion worth more than it. */
    tip?: string;
  }): void {
    this.overlayStart.classList.remove('visible');
    this.overlayStart.style.display = 'none';
    this.overlayFinish.style.display = '';
    this.overlayFinish.classList.add('visible');
    this.el('#finish-eyebrow').textContent = summary.eyebrow;
    this.el('#finish-title').textContent = summary.title;
    this.el('#finish-summary').textContent =
      summary.duoSummary ??
      (summary.rank === 1 ? '冠军冲线！霓虹赛道被你点亮。' : `最终名次 ${summary.rank}/${summary.total}`);
    this.el('#finish-time').textContent = formatTime(summary.time);
    this.el('#finish-rank').textContent = `${summary.rank} / ${summary.total}`;
    this.el('#finish-lap').textContent = summary.bestLap == null ? '--:--.--' : formatTime(summary.bestLap);
    const rec = this.el('#finish-record');
    if (summary.newRecord) {
      rec.style.display = '';
      rec.textContent = '★ 本赛道新纪录！';
    } else if (summary.tip) {
      // A player who just finished last gets the actionable line here instead of
      // their best time: the time is already on the stats row above, and this
      // element already has a grid area in the landscape layout — a new element
      // would have been auto-placed into a fresh row and pushed the CTA down.
      rec.style.display = '';
      rec.textContent = summary.tip;
    } else if (summary.trackBest != null) {
      rec.style.display = '';
      rec.textContent = `本赛道最佳 ${formatTime(summary.trackBest)}`;
    } else {
      rec.style.display = 'none';
    }
  }

  hideFinish(): void {
    this.overlayFinish.classList.remove('visible');
    this.overlayFinish.style.display = 'none';
  }

  showCountdown(text: string): void {
    this.countdown.textContent = text;
    this.countdown.classList.remove('show');
    void this.countdown.offsetWidth;
    this.countdown.classList.add('show');
    if (text === 'GO!') {
      window.setTimeout(() => {
        if (this.countdown.textContent === 'GO!') this.countdown.textContent = '';
      }, 700);
    }
  }

  flashNitro(): void {
    this.nitroFlash.classList.remove('active');
    void this.nitroFlash.offsetWidth;
    this.nitroFlash.classList.add('active');
    this.statusLine.classList.add('pulse');
    window.setTimeout(() => this.statusLine.classList.remove('pulse'), 400);
  }

  /**
   * The one channel for "the game heard you, and here is why nothing happened".
   *
   * Repeats of the same wording inside 1.6s are swallowed. Every caller is
   * edge-triggered on a key press, but a player mashing 氮气 on an empty tank
   * would otherwise restart the pill several times a second and never read it.
   * A *different* wording always gets through — it is new information.
   */
  showAction(text: string, kind: 'warn' | 'good' = 'warn', holdSeconds = 3): void {
    if (!text) return;
    const now = performance.now();
    if (text === this.lastActionText && now - this.lastActionAt < 1600) return;
    this.lastActionText = text;
    this.lastActionAt = now;
    this.actionToast.textContent = text;
    this.actionToast.classList.toggle('good', kind === 'good');
    this.actionToast.classList.add('visible');
    this.actionToken += 1;
    const token = this.actionToken;
    window.setTimeout(() => {
      // A newer toast owns the element by now; its own timer retires it.
      if (token !== this.actionToken) return;
      this.actionToast.classList.remove('visible');
    }, holdSeconds * 1000);
  }

  hideAction(): void {
    this.actionToken += 1;
    this.actionToast.classList.remove('visible');
  }

  setWrongWay(visible: boolean): void {
    if (visible === this.wrongWayShown) return;
    this.wrongWayShown = visible;
    this.wrongWay.classList.toggle('visible', visible);
  }

  /**
   * `null` retires the coaching line; the step badge reads `step/total`.
   *
   * Driven from the render loop, so it caches on the rendered content rather
   * than on visibility alone — the caller pushes every frame and only the four
   * step changes are worth a DOM write.
   */
  setCoach(text: string | null, step = 1, total = 4): void {
    const visible = text != null && text !== '';
    const key = visible ? `${step}/${total}|${text}` : '';
    if (key === this.coachKey) return;
    this.coachKey = key;
    this.coachHint.classList.toggle('visible', visible);
    if (!visible) return;
    this.coachText.textContent = text as string;
    this.coachStep.textContent = `${step}/${total}`;
  }

  /**
   * True when the on-screen pad is the control surface. Mirrors the stylesheet's
   * `(pointer: coarse), (max-width: 820px)` breakpoint, which is what decides
   * whether the markup shows `.hint-keyboard` or `.hint-touch` — the coaching
   * copy is set from TypeScript, so it has to make the same choice itself.
   */
  get isTouchLayout(): boolean {
    return this.touchLayout.matches;
  }

  update(state: RaceHudState): void {
    const last = this.last;

    const rankText = String(state.rank);
    if (rankText !== last.rank) {
      last.rank = rankText;
      this.rankValue.textContent = rankText;
    }

    const lapText = String(Math.min(state.lap, state.totalLaps));
    if (lapText !== last.lap) {
      last.lap = lapText;
      this.lapValue.textContent = lapText;
    }

    const timeText = formatTime(state.time);
    if (timeText !== last.timer) {
      last.timer = timeText;
      this.timerValue.textContent = timeText;
    }

    /*
     * Only write the race's own best lap once there is one.
     *
     * This chip does double duty: `setTrackBest()` fills it from the menu with
     * the track's stored record, and this writes the current race's best lap
     * once the first lap lands. Writing '--:--.--' on every pre-lap frame would
     * erase the record the moment it was shown — and would do it even more
     * thoroughly once `setTrackBest` keeps `last.best` in sync, because then the
     * cache no longer happens to suppress the write.
     */
    if (state.bestLap != null) {
      const bestText = formatTime(state.bestLap);
      if (bestText !== last.best) {
        last.best = bestText;
        this.bestValue.textContent = bestText;
      }
    }

    const speedText = String(Math.round(state.speedKmh));
    if (speedText !== last.speed) {
      last.speed = speedText;
      this.speedValue.textContent = speedText;
    }

    const circumference = 2 * Math.PI * 52;
    const arcLength = 220;
    const ratio = THREE_CLAMP(state.speedKmh / 280, 0, 1);
    const dash = arcLength * ratio;
    const arcText = `${dash} ${circumference - dash}`;
    if (arcText !== last.arc) {
      last.arc = arcText;
      this.speedArc.style.strokeDasharray = arcText;
    }
    if (state.boosting !== last.hot) {
      last.hot = state.boosting;
      this.speedArc.classList.toggle('hot', state.boosting);
    }

    if (state.gear !== last.gear) {
      last.gear = state.gear;
      this.gearValue.textContent = state.gear;
    }

    const nitroPct = `${Math.round(state.nitro * 100)}%`;
    if (nitroPct !== last.nitroPct) {
      last.nitroPct = nitroPct;
      this.nitroFill.style.width = nitroPct;
      this.nitroPercent.textContent = nitroPct;
    }
    const nitroFull = state.nitro >= 0.98;
    if (nitroFull !== last.nitroFull) {
      last.nitroFull = nitroFull;
      this.nitroFill.classList.toggle('full', nitroFull);
    }

    if (state.driftChargeLevel !== last.pips) {
      last.pips = state.driftChargeLevel;
      for (let i = 0; i < 3; i += 1) {
        this.driftPips[i]?.classList.toggle('on', state.driftChargeLevel > i);
      }
    }
    if (state.driftScore != null) {
      const scoreText = `漂移分 ${state.driftScore}`;
      if (scoreText !== last.driftScore) {
        last.driftScore = scoreText;
        this.driftScore.textContent = scoreText;
      }
    }

    const itemIcon = state.item ? state.itemLabel : '—';
    if (itemIcon !== last.itemIcon) {
      last.itemIcon = itemIcon;
      this.itemIcon.textContent = itemIcon;
    }
    const hasItem = !!state.item;
    if (hasItem !== last.hasItem) {
      last.hasItem = hasItem;
      this.itemSlot.classList.toggle('has-item', hasItem);
      // The label swaps wording with it: "按 E 使用" is wrong while empty.
      this.itemLabel.classList.toggle('has-item', hasItem);
    }

    if (state.mode === 'duo') {
      const p2Speed = String(Math.round(state.speed2Kmh ?? 0));
      if (p2Speed !== last.p2Speed) {
        last.p2Speed = p2Speed;
        this.p2Speed.textContent = p2Speed;
      }
      const p2Gear = state.gear2 ?? 'N';
      if (p2Gear !== last.p2Gear) {
        last.p2Gear = p2Gear;
        this.p2Gear.textContent = p2Gear;
      }
      const p2Nitro = `${Math.round((state.nitro2 ?? 0) * 100)}%`;
      if (p2Nitro !== last.p2NitroPct) {
        last.p2NitroPct = p2Nitro;
        this.p2Nitro.style.width = p2Nitro;
        this.p2NitroPct.textContent = p2Nitro;
      }
      const p2Level = state.driftChargeLevel2 ?? 0;
      if (p2Level !== last.p2Pips) {
        last.p2Pips = p2Level;
        for (let i = 0; i < 3; i += 1) {
          this.p2Pips[i]?.classList.toggle('on', p2Level > i);
        }
      }
      const p2Icon = state.item2 ? (state.itemLabel2 ?? '—') : '—';
      if (p2Icon !== last.p2ItemIcon) {
        last.p2ItemIcon = p2Icon;
        this.p2Item.textContent = p2Icon;
      }
      const p2HasItem = !!state.item2;
      if (p2HasItem !== last.p2HasItem) {
        last.p2HasItem = p2HasItem;
        this.p2ItemSlot.classList.toggle('has-item', p2HasItem);
      }
    }

    let hint: string;
    let hintColor: string;
    if (state.drifting) {
      hint = '漂移充能中…';
      hintColor = '#ff9ad5';
    } else if (state.boosting) {
      hint = '氮气加速中！';
      hintColor = '#2de2ff';
    } else {
      hint = this.touchLayout.matches ? '按住 漂移 键蓄能' : '按住 Shift / Z 漂移蓄能';
      hintColor = '';
    }
    if (hint !== last.hint) {
      last.hint = hint;
      this.driftHint.textContent = hint;
    }
    if (hintColor !== last.hintColor) {
      last.hintColor = hintColor;
      this.driftHint.style.color = hintColor;
    }

    if (state.status !== last.status) {
      last.status = state.status;
      this.statusLine.textContent = state.status;
    }

    if (state.trackPath && state.dots) {
      this.drawMinimap(state.trackPath, state.dots);
    }
  }

  private drawMinimap(path: Array<{ x: number; z: number }>, dots: MinimapDot[]): void {
    if (path.length < 2) return;
    const now = performance.now();
    if (now - this.lastMinimapAt < MINIMAP_INTERVAL_MS) return;
    this.lastMinimapAt = now;

    const ctx = this.minimap.getContext('2d');
    if (!ctx) return;

    if (!this.trackBounds) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const p of path) {
        minX = Math.min(minX, p.x);
        maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z);
        maxZ = Math.max(maxZ, p.z);
      }
      this.trackBounds = {
        minX: minX - MINIMAP_PAD,
        maxX: maxX + MINIMAP_PAD,
        minZ: minZ - MINIMAP_PAD,
        maxZ: maxZ + MINIMAP_PAD,
      };
    }

    const { minX, maxX, minZ, maxZ } = this.trackBounds;
    const w = this.minimap.width;
    const h = this.minimap.height;
    const sx = (x: number) => ((x - minX) / (maxX - minX)) * w;
    const sy = (z: number) => ((z - minZ) / (maxZ - minZ)) * h;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(this.minimapBaseCanvas(path, sx, sy), 0, 0);

    for (const dot of dots) {
      ctx.beginPath();
      ctx.arc(sx(dot.x), sy(dot.z), dot.isPlayer ? 4.5 : 3.2, 0, Math.PI * 2);
      ctx.fillStyle = dot.color;
      ctx.fill();
      if (dot.isPlayer) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  /**
   * The track outline never changes, so it is stroked once into an offscreen
   * canvas and blitted afterwards instead of being re-pathed on every repaint.
   */
  private minimapBaseCanvas(
    path: Array<{ x: number; z: number }>,
    sx: (x: number) => number,
    sy: (z: number) => number,
  ): HTMLCanvasElement {
    if (this.minimapBase) return this.minimapBase;
    const w = this.minimap.width;
    const h = this.minimap.height;
    const base = document.createElement('canvas');
    base.width = w;
    base.height = h;
    const ctx = base.getContext('2d');
    if (!ctx) return base;

    ctx.fillStyle = 'rgba(4, 8, 18, 0.35)';
    ctx.fillRect(0, 0, w, h);

    ctx.beginPath();
    ctx.moveTo(sx(path[0].x), sy(path[0].z));
    for (let i = 1; i < path.length; i += 1) {
      ctx.lineTo(sx(path[i].x), sy(path[i].z));
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(45, 226, 255, 0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.stroke();

    this.minimapBase = base;
    return base;
  }

  private el(selector: string): HTMLElement {
    const node = document.querySelector<HTMLElement>(selector);
    if (!node) throw new Error(`Missing HUD element: ${selector}`);
    return node;
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  const cs = Math.floor((seconds % 1) * 100)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}.${cs}`;
}

function THREE_CLAMP(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
