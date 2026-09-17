export type MinimapDot = {
  x: number;
  z: number;
  color: string;
  isPlayer?: boolean;
};

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
  private readonly countdown = this.el('#countdown');
  private readonly overlayStart = this.el('#overlay-start');
  private readonly overlayFinish = this.el('#overlay-finish');
  private readonly minimap = this.el('#minimap') as HTMLCanvasElement;
  private readonly trackName = this.el('#track-name');
  private readonly centerBanner = this.el('#center-banner');
  private readonly comboStack = this.el('#combo-stack');
  private readonly itemSlot = this.el('#item-slot');
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

  setMode(mode: HudMode): void {
    this.duoPanel.style.display = mode === 'duo' ? '' : 'none';
    document.body.classList.toggle('duo-mode', mode === 'duo');
    this.rankLabel.textContent = mode === 'duo' ? 'P1排名' : '排名';
  }

  resetMinimapBounds(): void {
    this.trackBounds = null;
  }

  setTrackName(name: string): void {
    this.trackName.textContent = name;
  }

  setTrackBest(seconds: number | null): void {
    // Reuse best-value chip on start overlay as historical best when not racing
    if (seconds != null) this.bestValue.textContent = formatTime(seconds);
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

  update(state: RaceHudState): void {
    this.rankValue.textContent = String(state.rank);
    this.lapValue.textContent = String(Math.min(state.lap, state.totalLaps));
    this.timerValue.textContent = formatTime(state.time);
    this.bestValue.textContent = state.bestLap == null ? '--:--.--' : formatTime(state.bestLap);
    this.speedValue.textContent = String(Math.round(state.speedKmh));

    const circumference = 2 * Math.PI * 52;
    const arcLength = 220;
    const ratio = THREE_CLAMP(state.speedKmh / 280, 0, 1);
    const dash = arcLength * ratio;
    this.speedArc.style.strokeDasharray = `${dash} ${circumference - dash}`;
    this.speedArc.classList.toggle('hot', state.boosting);

    this.gearValue.textContent = state.gear;
    this.nitroFill.style.width = `${Math.round(state.nitro * 100)}%`;
    this.nitroFill.classList.toggle('full', state.nitro >= 0.98);
    this.nitroPercent.textContent = `${Math.round(state.nitro * 100)}%`;

    for (let i = 0; i < 3; i += 1) {
      this.driftPips[i]?.classList.toggle('on', state.driftChargeLevel > i);
    }
    if (state.driftScore != null) {
      this.driftScore.textContent = `漂移分 ${state.driftScore}`;
    }

    if (state.item) {
      this.itemSlot.classList.add('has-item');
      this.itemIcon.textContent = state.itemLabel;
    } else {
      this.itemSlot.classList.remove('has-item');
      this.itemIcon.textContent = '—';
    }

    if (state.mode === 'duo') {
      this.p2Speed.textContent = String(Math.round(state.speed2Kmh ?? 0));
      this.p2Gear.textContent = state.gear2 ?? 'N';
      const n2 = state.nitro2 ?? 0;
      this.p2Nitro.style.width = `${Math.round(n2 * 100)}%`;
      this.p2NitroPct.textContent = `${Math.round(n2 * 100)}%`;
      for (let i = 0; i < 3; i += 1) {
        this.p2Pips[i]?.classList.toggle('on', (state.driftChargeLevel2 ?? 0) > i);
      }
      if (state.item2) {
        this.p2ItemSlot.classList.add('has-item');
        this.p2Item.textContent = state.itemLabel2 ?? '—';
      } else {
        this.p2ItemSlot.classList.remove('has-item');
        this.p2Item.textContent = '—';
      }
    }

    if (state.drifting) {
      this.driftHint.textContent = '漂移充能中…';
      this.driftHint.style.color = '#ff9ad5';
    } else if (state.boosting) {
      this.driftHint.textContent = '氮气加速中！';
      this.driftHint.style.color = '#2de2ff';
    } else {
      this.driftHint.textContent = '按住 Shift / Z 漂移蓄能';
      this.driftHint.style.color = '';
    }

    this.statusLine.textContent = state.status;

    if (state.trackPath && state.dots) {
      this.drawMinimap(state.trackPath, state.dots);
    }
  }

  private drawMinimap(path: Array<{ x: number; z: number }>, dots: MinimapDot[]): void {
    const ctx = this.minimap.getContext('2d');
    if (!ctx || path.length < 2) return;

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
      const pad = 8;
      this.trackBounds = {
        minX: minX - pad,
        maxX: maxX + pad,
        minZ: minZ - pad,
        maxZ: maxZ + pad,
      };
    }

    const { minX, maxX, minZ, maxZ } = this.trackBounds;
    const w = this.minimap.width;
    const h = this.minimap.height;
    const sx = (x: number) => ((x - minX) / (maxX - minX)) * w;
    const sy = (z: number) => ((z - minZ) / (maxZ - minZ)) * h;

    ctx.clearRect(0, 0, w, h);
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
    ctx.stroke();

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
