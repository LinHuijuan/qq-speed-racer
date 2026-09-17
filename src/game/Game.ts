import * as THREE from 'three';
import {
  DualMode,
  InputController,
  type RaceInputFrame,
} from '../core/InputController';
import { Loop } from '../core/Loop';
import {
  createPostPipeline,
  createRenderer,
  resizeRenderer,
  type PostPipeline,
} from '../core/Renderer';
import { AIRacer } from '../entities/AIRacer';
import { PlayerRacer } from '../entities/PlayerRacer';
import { AudioSystem } from '../systems/AudioSystem';
import { CameraRig } from '../systems/CameraRig';
import { Hud, type MinimapDot } from '../systems/Hud';
import { Vfx } from '../systems/Vfx';
import { ItemSystem, type ItemType } from '../systems/ItemSystem';
import {
  getBest,
  loadSettings,
  saveBest,
  saveSettings,
  type GameSettings,
} from '../systems/settings';
import { Track } from './Track';
import { TRACK_LAYOUTS, type TrackLayoutId } from './TrackLayouts';
import { createSeededRandom } from '../utils/random';
import { loadGameTexture } from '../assets/textures';

const TOTAL_LAPS = 3;
const COUNTDOWN_SECONDS = 3.4;

type RacePhase = 'menu' | 'countdown' | 'racing' | 'finished';

function emptyInput(): RaceInputFrame {
  return { throttle: 0, brake: 0, steer: 0, drift: false, nitro: false, useItem: false, reset: false };
}

function itemLabel(item: ItemType | null): string {
  switch (item) {
    case 'turbo':
      return '🚀';
    case 'missile':
      return '🎯';
    case 'shield':
      return '🛡';
    case 'mine':
      return '💣';
    default:
      return '—';
  }
}

function gearOf(speed: number, boosting: boolean): string {
  if (speed < 1) return 'N';
  if (boosting) return 'B';
  if (speed > 40) return '6';
  if (speed > 32) return '5';
  if (speed > 24) return '4';
  if (speed > 16) return '3';
  if (speed > 8) return '2';
  return '1';
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cameraP1 = new THREE.PerspectiveCamera(58, 1, 0.1, 500);
  private readonly cameraP2 = new THREE.PerspectiveCamera(58, 1, 0.1, 500);
  private readonly input: InputController;
  private track = new Track('neon');
  private trackId: TrackLayoutId = 'neon';
  private readonly player1 = new PlayerRacer({ color: '#2a6cff', accent: '#2de2ff', name: 'P1' });
  private readonly player2 = new PlayerRacer({ color: '#ff8a1f', accent: '#ffd166', name: 'P2' });
  private readonly ais: AIRacer[] = [];
  private readonly audio = new AudioSystem();
  private readonly hud = new Hud();
  private readonly vfx = new Vfx();
  private readonly items = new ItemSystem(42);
  private readonly cameraRig1 = new CameraRig(this.cameraP1);
  private readonly cameraRig2 = new CameraRig(this.cameraP2);
  private readonly lightP1 = new THREE.PointLight('#b8e4ff', 3.2, 36);
  private readonly lightP2 = new THREE.PointLight('#ffd166', 2.4, 28);
  private post: PostPipeline;
  private readonly speedLines = document.querySelector<HTMLElement>('#speed-lines');
  private offtrackHelp: HTMLElement | null = null;
  private offTrackTimer = 0;
  private readonly loop = new Loop(
    (delta, elapsed) => this.update(delta, elapsed),
    () => this.render(),
  );

  private readonly inputP1 = emptyInput();
  private readonly inputP2 = emptyInput();
  private mode: DualMode = 'solo';

  private readonly tuning = {
    maxDpr: 1.75,
    exposure: 0.98,
  };

  private phase: RacePhase = 'menu';
  private finishShown = false;
  private raceTime = 0;
  private countdownTimer = 0;
  private lastCountdownLabel = '';
  private lapTimes: number[] = [];
  private currentLapStart = 0;
  private bestLap: number | null = null;
  private prevProgressP1 = 0;
  private prevProgressP2 = 0;
  private lastRank1 = 1;
  private offTrackShakeTimer = 0;
  private comboCount = 0;
  private comboTimer = 0;
  private comboLabel = '';
  private frame = 0;
  private minimapPath: Array<{ x: number; z: number }> | null = null;
  private rng = createSeededRandom(7);
  private pausedForScreenshot = false;
  private reducedMotion = false;
  private elapsed = 0;
  private readonly startButton = this.getElement('#start-button');
  private readonly restartButton = this.getElement('#restart-button');
  private readonly modeSolo = this.getElement('#mode-solo');
  private readonly modeDuo = this.getElement('#mode-duo');
  private readonly pauseFab = this.getElement('#pause-fab');
  private readonly overlayPause = this.getElement('#overlay-pause');
  private readonly resumeButton = this.getElement('#resume-button');
  private readonly pauseRestartButton = this.getElement('#pause-restart-button');
  private readonly pauseMenuButton = this.getElement('#pause-menu-button');
  private readonly finishMenuButton = this.getElement('#finish-menu-button');
  private readonly muteToggle = this.getElement('#mute-toggle');
  private settings: GameSettings = loadSettings();
  private paused = false;
  private savedBestThisRace: number | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = createRenderer(canvas);
    this.renderer.toneMappingExposure = this.tuning.exposure;
    this.cameraP1.far = 420;
    this.cameraP2.far = 420;

    const stick = this.getElement('#touch-stick');
    const knob = this.getElement('#touch-knob');
    const driftButton = this.getElement('#drift-button');
    const nitroButton = this.getElement('#nitro-button');
    const itemButton = this.getElement('#item-button');
    const resetButton = this.getElement('#reset-button');
    this.input = new InputController(stick, knob, driftButton, nitroButton, itemButton, resetButton);
    this.offtrackHelp = document.querySelector<HTMLElement>('#offtrack-help');

    // Solo: 3 AI. Duo: P2 replaces one AI slot → 2 AI.
    this.ais.push(new AIRacer(0));
    this.ais.push(new AIRacer(1));
    this.ais.push(new AIRacer(2));

    this.player1.setBoostFlashHandler(() => {
      this.hud.flashNitro();
      this.audio.whoosh();
      this.cameraRig1.addTrauma(0.25);
    });
    this.player2.setBoostFlashHandler(() => {
      this.audio.whoosh();
      this.cameraRig2.addTrauma(0.22);
    });

    this.createScene();
    this.items.build(this.track);
    this.scene.add(this.items.group);
    this.post = createPostPipeline(this.renderer, this.scene, this.cameraP1);
    this.resetRace(true);
    this.hud.showStart();
    this.hud.setMode('solo');
    resizeRenderer(this.renderer, this.cameraP1, this.tuning.maxDpr);
    this.post.resize();

    this.modeSolo.addEventListener('click', () => this.selectMode('solo'));
    this.modeDuo.addEventListener('click', () => this.selectMode('duo'));
    this.installTrackPicker();
    this.startButton.addEventListener('click', () => {
      void this.beginRace();
    });
    this.restartButton.addEventListener('click', () => {
      void this.beginRace();
    });
    this.finishMenuButton.addEventListener('click', () => this.returnToMenu());
    this.pauseFab.addEventListener('click', () => this.togglePause());
    this.resumeButton.addEventListener('click', () => this.togglePause(false));
    this.pauseRestartButton.addEventListener('click', () => {
      this.togglePause(false);
      void this.beginRace();
    });
    this.pauseMenuButton.addEventListener('click', () => {
      this.togglePause(false);
      this.returnToMenu();
    });
    this.muteToggle.addEventListener('click', () => this.setMuted(!this.settings.muted));
    document.querySelectorAll('.diff-btn').forEach((el) => {
      el.addEventListener('click', () => {
        const d = (el as HTMLElement).dataset.diff as GameSettings['difficulty'];
        this.setDifficulty(d || 'normal');
      });
    });
    window.addEventListener('keydown', this.onGlobalKey);
    this.applySettingsUi();

    this.installTestHooks();
    this.publishDiagnostics();
  }

  private readonly onGlobalKey = (event: KeyboardEvent) => {
    if (event.code === 'Escape') {
      event.preventDefault();
      this.togglePause();
    }
  };

  private setMuted(muted: boolean): void {
    this.settings.muted = muted;
    saveSettings(this.settings);
    this.audio.setMuted(muted);
    this.applySettingsUi();
  }

  private setDifficulty(diff: GameSettings['difficulty']): void {
    this.settings.difficulty = diff;
    saveSettings(this.settings);
    this.applySettingsUi();
  }

  private applySettingsUi(): void {
    this.muteToggle.textContent = this.settings.muted ? '关' : '开';
    this.muteToggle.classList.toggle('off', this.settings.muted);
    document.querySelectorAll('.diff-btn').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.diff === this.settings.difficulty);
    });
  }

  private togglePause(force?: boolean): void {
    if (this.phase !== 'racing' && this.phase !== 'countdown' && force !== false) {
      // Allow pause only during an active race; ignore on menu/finish unless forcing resume
      if (force === undefined && this.phase === 'menu') return;
      if (force === undefined && this.phase === 'finished') return;
    }
    this.paused = force === undefined ? !this.paused : force;
    this.overlayPause.classList.toggle('visible', this.paused);
    if (this.paused) {
      this.overlayPause.style.display = '';
    } else {
      this.overlayPause.style.display = 'none';
    }
  }

  private returnToMenu(): void {
    this.paused = false;
    this.overlayPause.style.display = 'none';
    this.overlayPause.classList.remove('visible');
    this.finishShown = false;
    this.selectMode(this.mode);
  }

  private difficultyScale(): number {
    if (this.settings.difficulty === 'easy') return 0.88;
    if (this.settings.difficulty === 'hard') return 1.06;
    return 1;
  }

  start(): void {
    this.loop.start();
  }

  dispose(): void {
    this.loop.stop();
    this.input.dispose();
    this.audio.dispose();
    this.vfx.dispose();
    this.items.dispose();
    this.player1.kart.dispose();
    this.player2.kart.dispose();
    for (const ai of this.ais) ai.kart.dispose();
    this.track.dispose();
    this.post.dispose();
    this.renderer.dispose();
    window.removeEventListener('keydown', this.onGlobalKey);
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
  }

  private selectMode(mode: DualMode): void {
    this.mode = mode;
    this.input.setMode(mode);
    this.modeSolo.classList.toggle('active', mode === 'solo');
    this.modeDuo.classList.toggle('active', mode === 'duo');
    this.hud.setMode(mode);
    this.finishShown = false;
    this.resetRace(true);
    this.hud.showStart();
    this.hud.hideFinish();
    this.hud.setTrackBest(getBest(this.trackId));
    // Re-sync canvas size and post targets after mode switch.
    resizeRenderer(this.renderer, this.cameraP1, this.tuning.maxDpr);
    this.post.resize();
    this.render();
  }

  private installTrackPicker(): void {
    const host = document.querySelector('#track-picker');
    if (!host) return;
    host.innerHTML = '';
    for (const layout of TRACK_LAYOUTS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `track-btn${layout.id === this.trackId ? ' active' : ''}`;
      btn.dataset.trackId = layout.id;
      btn.innerHTML = `<strong>${layout.name}</strong><span>${layout.desc}</span>`;
      btn.addEventListener('click', () => this.selectTrack(layout.id));
      host.appendChild(btn);
    }
  }

  private selectTrack(id: TrackLayoutId): void {
    if (id === this.trackId) return;
    this.trackId = id;
    this.scene.remove(this.track.group);
    this.track.dispose();
    this.track = new Track(id);
    this.scene.add(this.track.group);
    this.hud.setTrackName(this.track.layout.name);
    this.hud.setTrackBest(getBest(this.trackId));
    this.minimapPath = null;
    this.hud.resetMinimapBounds();
    document.querySelectorAll('.track-btn').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.trackId === id);
    });
    this.finishShown = false;
    this.resetRace(true);
    this.hud.showStart();
    this.hud.hideFinish();
    this.cameraRig1.snapTo(
      this.player1.kart.state.position,
      this.player1.kart.state.heading,
      0,
    );
    this.render();
    this.publishDiagnostics();
  }

  private async beginRace(): Promise<void> {
    this.finishShown = false;
    this.paused = false;
    this.overlayPause.style.display = 'none';
    this.overlayPause.classList.remove('visible');
    this.savedBestThisRace = null;
    this.resetRace(false);
    this.hud.hideStart();
    this.hud.hideFinish();
    this.hud.setTrackBest(getBest(this.trackId));
    this.phase = 'countdown';
    this.countdownTimer = COUNTDOWN_SECONDS;
    this.lastCountdownLabel = '';
    try {
      await this.audio.unlock();
      this.audio.setMuted(this.settings.muted);
      this.audio.startEngine();
    } catch {
      // Audio may be blocked in headless / autoplay policies; race still runs.
    }
  }

  private update(delta: number, elapsed: number): void {
    this.frame += 1;
    this.elapsed = elapsed;
    if (this.pausedForScreenshot || this.paused) {
      this.publishDiagnostics();
      return;
    }

    const aspect = Math.max(0.5, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    const viewAspect = this.mode === 'duo' ? aspect / 2 : aspect;
    this.cameraP1.aspect = viewAspect;
    this.cameraP2.aspect = viewAspect;
    this.cameraP1.updateProjectionMatrix();
    this.cameraP2.updateProjectionMatrix();

    resizeRenderer(this.renderer, this.cameraP1, this.tuning.maxDpr);
    this.post.resize();
    const animDelta = this.reducedMotion ? 0 : delta;

    this.track.update(animDelta, elapsed);
    this.input.readPlayer1(this.inputP1);
    this.input.readPlayer2(this.inputP2);

    if (this.phase === 'countdown') {
      this.countdownTimer -= delta;
      this.updateCountdownUi();
      if (this.countdownTimer <= 0) {
        this.phase = 'racing';
        this.hud.showCountdown('GO!');
        this.audio.countdownBeep(true);
      }
    }

    const raceActive = this.phase === 'racing';
    this.items.update(animDelta, elapsed);

    this.updateHumanPlayer(this.player1, this.inputP1, delta, raceActive, 1);
    if (this.mode === 'duo') {
      this.updateHumanPlayer(this.player2, this.inputP2, delta, raceActive, 2);
    }

    // AI field: solo 3, duo 2
    const leadProgress = Math.max(
      this.player1.kart.state.totalProgress,
      this.mode === 'duo' ? this.player2.kart.state.totalProgress : -Infinity,
    );
    const aiCount = this.mode === 'duo' ? 2 : 3;
    const diff = this.difficultyScale();
    for (let i = 0; i < this.ais.length; i += 1) {
      const ai = this.ais[i];
      ai.kart.group.visible = i < aiCount;
      if (i >= aiCount) continue;
      ai.setDifficultyScale(diff);
      ai.update(delta, this.track, raceActive, leadProgress);
      this.trackProgressForKart(ai.kart.state, raceActive);
      if (raceActive) {
        if (this.items.collect(ai.kart.state.position, 1.2) && this.rng() > 0.55) {
          ai.kart.state.boostTimer = Math.max(ai.kart.state.boostTimer, 0.8);
        }
        if (this.items.checkMineHit(ai.kart.state.position, 1.1)) {
          ai.kart.state.speed *= 0.4;
        }
      }
      if (ai.kart.state.lap >= TOTAL_LAPS && !ai.kart.state.finished) {
        ai.kart.state.finished = true;
        ai.kart.state.finishTime = this.raceTime;
      }
    }

    this.vfx.update(delta);
    this.emitPlayerVfx(this.player1);
    if (this.mode === 'duo') this.emitPlayerVfx(this.player2);

    const p1 = this.player1.kart.state;
    this.cameraRig1.update(delta, p1.position, p1.heading, p1.speed, p1.isBoosting);
    this.lightP1.position.set(p1.position.x, 5.5, p1.position.z);
    if (this.mode === 'duo') {
      const p2 = this.player2.kart.state;
      this.cameraRig2.update(delta, p2.position, p2.heading, p2.speed, p2.isBoosting);
      this.lightP2.position.set(p2.position.x, 5.5, p2.position.z);
      this.lightP2.visible = true;
    } else {
      this.lightP2.visible = false;
    }

    this.audio.updateEngine(Math.min(1, p1.speed / 55), p1.isBoosting);
    this.updateSpeedLines(p1.speed, p1.isBoosting, p1.isDrifting);
    this.updateOffTrackHelp(delta, p1.offTrack, p1.speed);

    // Rank-change flash
    const rankNow = this.rankOf(this.player1);
    if (this.phase === 'racing' && rankNow !== this.lastRank1) {
      if (rankNow < this.lastRank1) this.hud.showBanner(`↑ 升至第 ${rankNow}`, 'rank');
      else this.hud.showBanner(`↓ 落至第 ${rankNow}`, 'rank');
      this.lastRank1 = rankNow;
    }

    // Off-road camera rumble
    if (p1.offTrack && p1.speed > 4 && this.phase === 'racing') {
      this.offTrackShakeTimer += delta;
      if (this.offTrackShakeTimer > 0.15) {
        this.cameraRig1.addTrauma(0.08);
        this.offTrackShakeTimer = 0;
      }
    } else {
      this.offTrackShakeTimer = 0;
    }

    // Combo window decay
    if (this.comboCount > 0) {
      this.comboTimer -= delta;
      if (this.comboTimer <= 0) this.comboCount = 0;
    }

    if (this.phase === 'racing' && this.checkFinish()) {
      this.finishRace();
    }

    this.updateHud();
    this.publishDiagnostics();
  }

  private updateHumanPlayer(
    player: PlayerRacer,
    input: RaceInputFrame,
    delta: number,
    raceActive: boolean,
    which: 1 | 2,
  ): void {
    const prevProgress = which === 1 ? this.prevProgressP1 : this.prevProgressP2;
    const canControl = raceActive && !player.kart.state.finished;

    // One-key return to track (R / touch)
    if (canControl && input.reset) {
      player.resetToTrack(this.track);
      const pos = player.kart.state.position.clone();
      pos.y = 0.3;
      this.vfx.emitShockwave(pos, '#ffd166');
      this.audio.whoosh();
      (which === 1 ? this.cameraRig1 : this.cameraRig2).addTrauma(0.3);
      if (which === 1) {
        this.hud.flashNitro();
        this.offTrackTimer = 0;
      }
    }

    const result = player.update(
      delta,
      input,
      this.track,
      canControl,
      prevProgress,
      input.useItem && canControl,
    );

    if (which === 1) {
      this.prevProgressP1 = player.kart.state.progress;
    } else {
      this.prevProgressP2 = player.kart.state.progress;
    }

    if (!raceActive) return;

    const cam = which === 1 ? this.cameraRig1 : this.cameraRig2;
    if (result.boostPad || result.driftBoost > 0 || result.firedItem === 'turbo') {
      this.audio.whoosh();
      cam.addTrauma(0.22 + (result.driftBoost ?? 0) * 0.06);
      this.emitBoostShock(player);
      if (which === 1) this.hud.flashNitro();
      this.flashScreen(result.driftBoost > 0 ? 'drift' : 'boost');
    }
    if (result.driftBoost > 0) {
      this.registerCombo('drift');
    }
    if (result.firedItem) {
      this.registerCombo(result.firedItem);
    }
    if (result.boostPad) {
      this.registerCombo('boost');
    }
    if (result.firedItem === 'mine') {
      this.items.dropMine(player.kart.state.position, player.kart.state.heading);
    } else if (result.firedItem === 'missile') {
      this.fireMissileFrom(player);
    }

    if (this.items.collect(player.kart.state.position, 1.6)) {
      player.setItem(this.items.rollItem());
      this.audio.countdownBeep(true);
      if (which === 1) this.hud.flashNitro();
    }
    if (this.items.checkMineHit(player.kart.state.position, 1.2)) {
      if (player.applyMineHit()) {
        cam.addTrauma(0.55);
        this.audio.whoosh();
        const pos = player.kart.state.position.clone();
        pos.y = 0.3;
        this.vfx.emitSparks(pos, 20, '#ff6b6b');
        this.flashScreen('hit');
      }
    }

    const prevLap = player.kart.state.lap;
    this.trackProgressForKart(player.kart.state, true);
    if (player.kart.state.lap > prevLap && which === 1) {
      this.onPlayerLapComplete();
    }

    // Individual checkered flag
    if (!player.kart.state.finished && player.kart.state.lap >= TOTAL_LAPS) {
      player.kart.state.finished = true;
      player.kart.state.finishTime = this.raceTime;
      cam.addTrauma(0.3);
      this.audio.countdownBeep(true);
    }
  }

  private checkFinish(): boolean {
    const p1Done = this.player1.kart.state.finished || this.player1.kart.state.lap >= TOTAL_LAPS;
    const p2Done =
      this.mode !== 'duo' ||
      this.player2.kart.state.finished ||
      this.player2.kart.state.lap >= TOTAL_LAPS;
    return p1Done && p2Done;
  }

  private finishRace(): void {
    if (this.finishShown) return;
    this.finishShown = true;
    this.phase = 'finished';
    if (!this.player1.kart.state.finished) {
      this.player1.kart.state.finished = true;
      this.player1.kart.state.finishTime = this.raceTime;
    }
    if (this.mode === 'duo' && !this.player2.kart.state.finished) {
      this.player2.kart.state.finished = true;
      this.player2.kart.state.finishTime = this.raceTime;
    }
    for (const ai of this.ais) {
      if (!ai.kart.state.finished) {
        ai.kart.state.finished = true;
        ai.kart.state.finishTime = this.raceTime + 8;
      }
    }

    const rank1 = this.rankOf(this.player1);
    const rank2 = this.mode === 'duo' ? this.rankOf(this.player2) : null;
    const winner =
      this.mode === 'duo'
        ? rank1 <= (rank2 ?? 99)
          ? '玩家1'
          : '玩家2'
        : rank1 === 1
          ? '玩家'
          : `第 ${rank1} 名`;

    // Persist best total time for this track (solo champion / any finish)
    const isNewRecord = rank1 === 1 ? saveBest(this.trackId, this.raceTime) : false;
    this.savedBestThisRace = getBest(this.trackId);

    this.hud.showFinish({
      title: this.mode === 'duo' ? `${winner} 获胜！` : rank1 === 1 ? '冠军！' : `第 ${rank1} 名`,
      eyebrow: this.mode === 'duo' ? 'VERSUS COMPLETE' : rank1 === 1 ? 'CHAMPION' : 'RACE COMPLETE',
      time: this.raceTime,
      rank: rank1,
      total: 4,
      bestLap: this.bestLap,
      trackBest: this.savedBestThisRace,
      newRecord: isNewRecord,
      duoSummary:
        this.mode === 'duo'
          ? `P1 第${rank1}名 · P2 第${rank2}名`
          : undefined,
    });
    // Finish fireworks
    const fx = this.player1.kart.state.position.clone();
    fx.y = 2;
    this.vfx.emitFireworks(fx);
    if (this.mode === 'duo') {
      this.vfx.emitFireworks(this.player2.kart.state.position.clone().setY(2));
    }
    this.audio.whoosh();
    this.audio.countdownBeep(true);
    this.cameraRig1.addTrauma(0.4);
  }

  private fireMissileFrom(shooter: PlayerRacer): void {
    const s = shooter.kart.state;
    let best = Infinity;
    let hitPlayer: PlayerRacer | undefined;
    let hitAi: AIRacer | undefined;

    if (shooter === this.player1 && this.mode === 'duo') {
      const st = this.player2.kart.state;
      if (!st.finished) {
        const gap = st.totalProgress - s.totalProgress;
        if (gap > 0 && gap < best) {
          best = gap;
          hitPlayer = this.player2;
        }
      }
    }
    if (shooter === this.player2) {
      const st = this.player1.kart.state;
      if (!st.finished) {
        const gap = st.totalProgress - s.totalProgress;
        if (gap > 0 && gap < best) {
          best = gap;
          hitPlayer = this.player1;
        }
      }
    }
    for (const ai of this.ais) {
      if (!ai.kart.group.visible) continue;
      const st = ai.kart.state;
      if (st.finished) continue;
      const gap = st.totalProgress - s.totalProgress;
      if (gap > 0 && gap < best) {
        best = gap;
        hitPlayer = undefined;
        hitAi = ai;
      }
    }

    if (!hitPlayer && !hitAi) {
      s.boostTimer = Math.max(s.boostTimer, 1.2);
      return;
    }
    if (hitPlayer) {
      hitPlayer.applyMissileHit();
    } else if (hitAi) {
      hitAi.kart.state.speed *= 0.4;
      hitAi.kart.state.boostTimer = 0;
    }
    this.cameraRig1.addTrauma(0.4);
    this.audio.whoosh();
  }

  private render(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    // Always start from a clean full-canvas viewport/scissor.
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, w, h);

    if (this.mode === 'duo') {
      const half = Math.floor(w / 2);
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(0, 0, half, h);
      this.renderer.setScissor(0, 0, half, h);
      this.renderer.render(this.scene, this.cameraP1);
      this.renderer.setViewport(half, 0, w - half, h);
      this.renderer.setScissor(half, 0, w - half, h);
      this.renderer.render(this.scene, this.cameraP2);
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, w, h);
    } else {
      this.post.render();
      // Composer may leave viewport at its internal size; restore full canvas.
      this.renderer.setScissorTest(false);
      this.renderer.setViewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  private createScene(): void {
    // City skyline backdrop cylinder (generated panorama) — tall & close so it reads in-frame
    const skyTex = loadGameTexture('/assets/sky-city.png', { repeat: [3, 1] });
    const skyCyl = new THREE.Mesh(
      new THREE.CylinderGeometry(160, 160, 120, 64, 1, true),
      new THREE.MeshBasicMaterial({
        map: skyTex,
        side: THREE.BackSide,
        fog: false,
        depthWrite: false,
      }),
    );
    skyCyl.position.y = 40;
    skyCyl.rotation.y = Math.PI * 0.15;
    this.scene.add(skyCyl);

    // Gradient sky dome behind the city strip
    const skyGeo = new THREE.SphereGeometry(280, 32, 16);
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color('#0a1838') },
        midColor: { value: new THREE.Color('#152040') },
        bottomColor: { value: new THREE.Color('#1a1030') },
      },
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 midColor;
        uniform vec3 bottomColor;
        varying vec3 vWorld;
        void main() {
          float h = normalize(vWorld).y;
          vec3 c = mix(bottomColor, midColor, smoothstep(-0.15, 0.2, h));
          c = mix(c, topColor, smoothstep(0.15, 0.7, h));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.frustumCulled = false;
    this.scene.add(sky);

    this.scene.background = new THREE.Color('#0a1020');
    this.scene.fog = new THREE.FogExp2('#0c1428', 0.0028);

    const hemisphere = new THREE.HemisphereLight('#d8e8ff', '#2a2840', 2.15);
    this.scene.add(hemisphere);

    const key = new THREE.DirectionalLight('#fff0dc', 2.55);
    key.position.set(50, 80, 30);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 200;
    key.shadow.camera.left = -80;
    key.shadow.camera.right = 80;
    key.shadow.camera.top = 80;
    key.shadow.camera.bottom = -80;
    key.shadow.bias = -0.0004;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight('#6a9ae8', 0.7);
    fill.position.set(-40, 50, 50);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight('#8a5078', 0.25);
    rim.position.set(-60, 25, -40);
    this.scene.add(rim);

    this.lightP1.position.set(0, 10, 0);
    this.lightP1.distance = 8;
    this.lightP1.intensity = 0.15;
    this.lightP1.color.set('#90b0d0');
    this.lightP1.visible = false;
    this.scene.add(this.lightP1);

    this.lightP2.position.set(0, 10, 0);
    this.lightP2.distance = 8;
    this.lightP2.intensity = 0.12;
    this.lightP2.color.set('#c0a070');
    this.lightP2.visible = false;
    this.scene.add(this.lightP2);

    this.scene.add(this.track.group);
    this.hud.setTrackName(this.track.layout.name);
    this.scene.add(this.player1.kart.group);
    this.scene.add(this.player2.kart.group);
    this.player2.kart.group.visible = false;
    for (const ai of this.ais) this.scene.add(ai.kart.group);
    this.scene.add(this.vfx.group);
  }

  private resetRace(soft: boolean): void {
    this.raceTime = 0;
    this.lapTimes = [];
    this.bestLap = null;
    this.currentLapStart = 0;
    this.prevProgressP1 = 0;
    this.prevProgressP2 = 0;
    this.lastRank1 = 1;
    this.comboCount = 0;
    this.comboTimer = 0;
    this.items.build(this.track);

    this.player1.reset(this.track);
    // Stagger P2 slightly beside P1
    if (this.mode === 'duo') {
      this.player2.kart.group.visible = true;
      this.player2.reset(this.track);
      const s = this.track.startTransform;
      const sample = this.track.sampleAt(0);
      this.player2.kart.state.position
        .copy(sample.position)
        .addScaledVector(sample.left, -3.2)
        .addScaledVector(sample.tangent, -2.4);
      this.player2.kart.state.heading = s.heading;
      this.player2.kart.syncTransform(0);
    } else {
      this.player2.kart.group.visible = false;
    }

    const aiStart = this.mode === 'duo' ? 0 : 1;
    for (let i = 0; i < this.ais.length; i += 1) {
      this.ais[i].reset(this.track, aiStart + i);
    }
    this.player1.kart.state.totalProgress = 0;
    this.cameraRig1.snapTo(this.player1.kart.state.position, this.player1.kart.state.heading, 0);
    if (this.mode === 'duo') {
      this.cameraRig2.snapTo(this.player2.kart.state.position, this.player2.kart.state.heading, 0);
    }
    if (!soft) {
      this.phase = 'menu';
    }
    this.publishDiagnostics();
  }

  private updateCountdownUi(): void {
    const t = this.countdownTimer;
    let label = '';
    if (t > 2.3) label = '3';
    else if (t > 1.3) label = '2';
    else if (t > 0.3) label = '1';
    else label = 'GO!';
    if (label !== this.lastCountdownLabel) {
      this.lastCountdownLabel = label;
      this.hud.showCountdown(label);
      this.audio.countdownBeep(label === 'GO!');
    }
  }

  private onPlayerLapComplete(): void {
    const lapTime = this.raceTime - this.currentLapStart;
    this.lapTimes.push(lapTime);
    if (this.bestLap == null || lapTime < this.bestLap) {
      this.bestLap = lapTime;
    }
    this.currentLapStart = this.raceTime;
    const lapNo = this.player1.kart.state.lap;
    if (lapNo < TOTAL_LAPS) {
      this.hud.showBanner(`第 ${lapNo + 1} 圈`, 'lap');
    } else {
      this.hud.showBanner('冲线！', 'lap');
    }
    this.audio.countdownBeep(true);
    this.cameraRig1.addTrauma(0.2);
  }

  private trackProgressForKart(
    state: { progress: number; totalProgress: number; lap: number },
    raceActive: boolean,
  ): void {
    if (!raceActive) return;
    const prev = state.totalProgress % 1;
    const curr = state.progress;
    const floor = Math.floor(state.totalProgress);
    if (prev > 0.85 && curr < 0.15) {
      state.lap += 1;
      state.totalProgress = floor + 1 + curr;
    } else {
      state.totalProgress = floor + curr;
    }
  }

  private rankOf(player: PlayerRacer): number {
    const s = player.kart.state;
    let better = 0;
    const others: Array<{ finished: boolean; finishTime: number; totalProgress: number }> = [];
    if (this.mode === 'duo') {
      const other = player === this.player1 ? this.player2 : this.player1;
      others.push(other.kart.state);
    }
    for (const ai of this.ais) {
      if (!ai.kart.group.visible) continue;
      others.push(ai.kart.state);
    }
    for (const o of others) {
      if (o.finished && s.finished) {
        if (o.finishTime < s.finishTime) better += 1;
      } else if (o.totalProgress > s.totalProgress) {
        better += 1;
      }
    }
    return better + 1;
  }

  private emitPlayerVfx(player: PlayerRacer): void {
    const state = player.kart.state;
    const origin = state.position.clone();
    origin.y = 0.15;
    const forward = new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading));
    if (state.isDrifting && state.speed > 5) {
      this.vfx.emitDrift(origin, forward, Math.abs(state.driftAngle) + 0.3);
      // Dual-wheel spark burst for a more dramatic drift
      const left = origin.clone().addScaledVector(new THREE.Vector3(forward.z, 0, -forward.x), 0.9);
      const right = origin.clone().addScaledVector(new THREE.Vector3(forward.z, 0, -forward.x), -0.9);
      left.y = 0.12;
      right.y = 0.12;
      this.vfx.emitDrift(left, forward, Math.abs(state.driftAngle));
      this.vfx.emitDrift(right, forward, Math.abs(state.driftAngle));
    }
    if (state.isBoosting) {
      this.vfx.emitBoost(origin, forward);
      const rear = origin.clone().addScaledVector(forward, -1.2);
      rear.y = 0.25;
      this.vfx.emitBoost(rear, forward);
    } else if (state.speed > 32) {
      // High-speed heat trail (seeded, not Math.random)
      const rear = origin.clone().addScaledVector(forward, -1.0);
      rear.y = 0.2;
      if (this.rng() > 0.55) this.vfx.emitSparks(rear, 1, '#8ac8ff');
    }
  }

  private emitBoostShock(player: PlayerRacer): void {
    const s = player.kart.state;
    const pos = s.position.clone();
    pos.y = 0.2;
    this.vfx.emitShockwave(pos, '#7cf6ff');
    this.vfx.emitSparks(pos, 14, '#2de2ff');
  }

  private updateSpeedLines(speed: number, boosting: boolean, drifting: boolean): void {
    if (!this.speedLines) return;
    const ratio = THREE.MathUtils.clamp((speed - 18) / 50, 0, 1);
    const opacity = Math.max(ratio * 0.7, boosting ? 0.95 : 0);
    this.speedLines.style.opacity = String(opacity);
    this.speedLines.classList.toggle('boost', boosting);
    this.speedLines.classList.toggle('drift', drifting);
    this.post.bloom.strength = boosting ? 0.38 : 0.18 + ratio * 0.08;
  }

  private registerCombo(kind: string): void {
    this.comboCount += 1;
    this.comboTimer = 2.2;
    const labels: Record<string, string> = {
      turbo: '加速',
      missile: '导弹',
      shield: '护盾',
      mine: '地雷',
      boost: '加速带',
      drift: '漂移喷',
    };
    this.comboLabel = labels[kind] ?? kind;
    this.hud.showCombo(this.comboLabel, this.comboCount);
    if (this.comboCount >= 3) {
      this.hud.showBanner(`${this.comboLabel} ×${this.comboCount} COMBO!`, 'boost');
      this.audio.whoosh();
      this.cameraRig1.addTrauma(0.15);
    }
  }

  private updateOffTrackHelp(delta: number, offTrack: boolean, speed: number): void {
    if (!this.offtrackHelp) return;
    if (offTrack && speed > 2 && this.phase === 'racing') {
      this.offTrackTimer += delta;
    } else {
      this.offTrackTimer = 0;
    }
    this.offtrackHelp.classList.toggle('visible', this.offTrackTimer > 1.2);
  }

  private flashScreen(kind: 'boost' | 'drift' | 'hit'): void {
    const el = this.speedLines;
    if (!el) return;
    el.classList.remove('flash-boost', 'flash-drift', 'flash-hit');
    void el.offsetWidth;
    el.classList.add(
      kind === 'boost' ? 'flash-boost' : kind === 'drift' ? 'flash-drift' : 'flash-hit',
    );
  }

  private updateHud(): void {
    const p1 = this.player1.kart.state;
    const p2 = this.player2.kart.state;
    const rank1 = this.rankOf(this.player1);
    const rank2 = this.mode === 'duo' ? this.rankOf(this.player2) : 1;
    const total = this.mode === 'duo' ? 4 : 4;

    let status = '准备起跑';
    if (this.phase === 'countdown') status = '倒计时';
    else if (this.phase === 'racing') {
      if (this.mode === 'duo') {
        status = rank1 <= rank2 ? 'P1 领先' : 'P2 领先';
      } else if (p1.isBoosting) status = '氮气加速！';
      else if (p1.isDrifting) status = '漂移充能';
      else if (p1.offTrack) status = '冲出赛道';
      else status = `第 ${Math.min(p1.lap + 1, TOTAL_LAPS)} 圈`;
    } else if (this.phase === 'finished') {
      status = this.mode === 'duo' ? '比赛结束' : rank1 === 1 ? '冠军冲线' : `第 ${rank1} 名完赛`;
    }

    if (!this.minimapPath) {
      this.minimapPath = this.track.samples
        .filter((_, i) => i % 8 === 0)
        .map((s) => ({ x: s.position.x, z: s.position.z }));
    }

    const dots: MinimapDot[] = [
      { x: p1.position.x, z: p1.position.z, color: '#2de2ff', isPlayer: true },
    ];
    if (this.mode === 'duo') {
      dots.push({ x: p2.position.x, z: p2.position.z, color: '#ffd166', isPlayer: true });
    }
    const aiColors = ['#ff3cac', '#7cff6b'];
    for (let i = 0; i < this.ais.length; i += 1) {
      if (!this.ais[i].kart.group.visible) continue;
      dots.push({
        x: this.ais[i].kart.state.position.x,
        z: this.ais[i].kart.state.position.z,
        color: aiColors[i] ?? '#ffffff',
      });
    }

    this.hud.update({
      mode: this.mode,
      rank: rank1,
      rank2,
      totalRacers: total,
      lap: Math.min(Math.max(p1.lap, 0) + 1, TOTAL_LAPS),
      lap2: Math.min(Math.max(p2.lap, 0) + 1, TOTAL_LAPS),
      totalLaps: TOTAL_LAPS,
      time: this.raceTime,
      bestLap: this.bestLap,
      speedKmh: p1.speed * 3.6,
      speed2Kmh: p2.speed * 3.6,
      nitro: p1.nitro,
      nitro2: p2.nitro,
      boosting: p1.isBoosting,
      boosting2: p2.isBoosting,
      drifting: p1.isDrifting,
      status,
      gear: gearOf(p1.speed, p1.isBoosting),
      gear2: gearOf(p2.speed, p2.isBoosting),
      driftChargeLevel: this.player1.getDriftChargeLevel(),
      driftChargeLevel2: this.player2.getDriftChargeLevel(),
      item: this.player1.getItem(),
      item2: this.player2.getItem(),
      itemLabel: itemLabel(this.player1.getItem()),
      itemLabel2: itemLabel(this.player2.getItem()),
      trackPath: this.minimapPath,
      dots,
    });
  }

  private installTestHooks(): void {
    window.__THREE_GAME_TEST_HOOKS__ = {
      seed: (value: number) => {
        this.vfx.reseed(value);
        this.rng = createSeededRandom(value);
      },
      setMode: (mode: string) => {
        this.selectMode(mode === 'duo' ? 'duo' : 'solo');
        return { mode: this.mode };
      },
      setTrack: (id: string) => {
        this.selectTrack((id as TrackLayoutId) || 'neon');
        return { track: this.trackId };
      },
      forceRace: () => {
        this.finishShown = false;
        this.resetRace(false);
        this.hud.hideStart();
        this.hud.hideFinish();
        this.phase = 'racing';
        this.countdownTimer = 0;
        this.lastCountdownLabel = '';
        // Give a rolling start so tests and restarts feel snappy
        this.player1.kart.state.speed = 18;
        if (this.mode === 'duo') this.player2.kart.state.speed = 16;
        for (const ai of this.ais) {
          if (ai.kart.group.visible) ai.kart.state.speed = 15;
        }
        this.updateHud();
        this.render();
        this.publishDiagnostics();
        return { phase: this.phase, mode: this.mode };
      },
      setState: (name: string) => {
        if (name === 'menu') {
          this.selectMode(this.mode);
        } else if (name === 'active-play') {
          this.selectMode(this.mode);
          this.phase = 'racing';
          this.raceTime = 18.5;
          const sample = this.track.sampleAt(0.32);
          this.player1.kart.state.lap = 1;
          this.player1.kart.state.progress = 0.32;
          this.player1.kart.state.totalProgress = 1.32;
          this.player1.kart.state.speed = 42;
          this.player1.kart.state.nitro = 0.72;
          this.player1.kart.state.position.copy(sample.position);
          this.player1.kart.state.heading = Math.atan2(sample.tangent.x, sample.tangent.z);
          this.player1.kart.syncTransform(0);
          this.prevProgressP1 = 0.32;
          this.lapTimes = [24.2, 23.8];
          this.bestLap = 23.8;
          if (this.mode === 'duo') {
            this.player2.kart.state.lap = 1;
            this.player2.kart.state.progress = 0.28;
            this.player2.kart.state.totalProgress = 1.28;
            this.player2.kart.state.speed = 38;
            const s2 = this.track.sampleAt(0.28);
            this.player2.kart.state.position.copy(s2.position).addScaledVector(s2.left, -2);
            this.player2.kart.state.heading = Math.atan2(s2.tangent.x, s2.tangent.z);
            this.player2.kart.syncTransform(0);
            this.prevProgressP2 = 0.28;
          }
          for (let i = 0; i < this.ais.length; i += 1) {
            if (!this.ais[i].kart.group.visible) continue;
            const t = 0.24 - i * 0.04;
            const s = this.track.sampleAt(t);
            this.ais[i].kart.state.position.copy(s.position).addScaledVector(s.left, (i % 2 === 0 ? -1 : 1) * 2);
            this.ais[i].kart.state.heading = Math.atan2(s.tangent.x, s.tangent.z);
            this.ais[i].kart.state.progress = t;
            this.ais[i].kart.state.totalProgress = 1 + t;
            this.ais[i].kart.state.lap = 1;
            this.ais[i].kart.state.speed = 32;
            this.ais[i].kart.syncTransform(0);
          }
          this.hud.hideStart();
          this.hud.hideFinish();
          this.cameraRig1.snapTo(
            this.player1.kart.state.position,
            this.player1.kart.state.heading,
            this.player1.kart.state.speed,
          );
          if (this.mode === 'duo') {
            this.cameraRig2.snapTo(
              this.player2.kart.state.position,
              this.player2.kart.state.heading,
              this.player2.kart.state.speed,
            );
          }
        } else if (name === 'complete') {
          this.selectMode(this.mode);
          this.finishShown = false;
          this.phase = 'finished';
          this.raceTime = 72.4;
          this.lapTimes = [24.1, 23.9, 24.4];
          this.bestLap = 23.9;
          this.player1.kart.state.lap = TOTAL_LAPS;
          this.player1.kart.state.finished = true;
          this.player1.kart.state.finishTime = this.raceTime;
          const sample = this.track.sampleAt(0.01);
          this.player1.kart.state.position.copy(sample.position);
          this.player1.kart.state.heading = Math.atan2(sample.tangent.x, sample.tangent.z);
          this.player1.kart.state.speed = 8;
          this.player1.kart.syncTransform(0);
          if (this.mode === 'duo') {
            this.player2.kart.state.lap = TOTAL_LAPS;
            this.player2.kart.state.finished = true;
            this.player2.kart.state.finishTime = this.raceTime + 1;
          }
          for (const ai of this.ais) {
            ai.kart.state.finished = true;
            ai.kart.state.lap = TOTAL_LAPS;
            ai.kart.state.finishTime = this.raceTime + 2;
            ai.kart.state.totalProgress = TOTAL_LAPS;
          }
          this.hud.hideStart();
          this.finishRace();
        } else {
          throw new Error(`Unknown test state: ${name}`);
        }
        this.updateHud();
        this.render();
        this.publishDiagnostics();
        return { state: name };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
        this.render();
        this.publishDiagnostics();
      },
      hideDebugUi: (_hidden: boolean) => {
        // no-op
      },
    };
  }

  private publishDiagnostics(): void {
    const info = this.renderer.info;
    const state = this.player1.kart.state;
    window.__THREE_GAME_DIAGNOSTICS__ = {
      frame: this.frame,
      elapsed: this.elapsed,
      raceTime: this.raceTime,
      phase: this.phase,
      mode: this.mode,
      track: this.trackId,
      lap: state.lap,
      rank: this.rankOf(this.player1),
      bestLap: this.bestLap,
      complete: this.phase === 'finished',
      player: {
        position: {
          x: state.position.x,
          y: state.position.y,
          z: state.position.z,
        },
        speed: state.speed,
        heading: state.heading,
        nitro: state.nitro,
        progress: state.progress,
        totalProgress: state.totalProgress,
        drifting: state.isDrifting,
        boosting: state.isBoosting,
        offTrack: state.offTrack,
      },
      player2:
        this.mode === 'duo'
          ? {
              position: {
                x: this.player2.kart.state.position.x,
                y: this.player2.kart.state.position.y,
                z: this.player2.kart.state.position.z,
              },
              speed: this.player2.kart.state.speed,
              nitro: this.player2.kart.state.nitro,
              progress: this.player2.kart.state.progress,
            }
          : undefined,
      renderer: {
        calls: info.render.calls,
        triangles: info.render.triangles,
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
      canvas: {
        clientWidth: this.canvas.clientWidth,
        clientHeight: this.canvas.clientHeight,
        width: this.canvas.width,
        height: this.canvas.height,
        dpr: Math.min(window.devicePixelRatio || 1, this.tuning.maxDpr),
      },
    };
  }

  private getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  }
}
