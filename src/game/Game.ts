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
import type { Kart } from '../entities/Kart';
import { PlayerRacer } from '../entities/PlayerRacer';
import { AudioSystem } from '../systems/AudioSystem';
import { CameraRig } from '../systems/CameraRig';
import { Hud, type MinimapDot, type RaceHudState } from '../systems/Hud';
import { Vfx } from '../systems/Vfx';
import { ItemSystem, type ItemType } from '../systems/ItemSystem';
import {
  getBest,
  loadSettings,
  saveBest,
  saveSettings,
  type GameSettings,
} from '../systems/settings';
import { clearRaceSave, loadRace, saveRace, type KartSave, type RaceSave } from '../systems/save';
import { Track } from './Track';
import { TRACK_LAYOUTS, type TrackLayoutId } from './TrackLayouts';
import { CAR_STYLES, getCarStyle } from './CarStyles';
import { createSeededRandom } from '../utils/random';
import { loadGameTexture } from '../assets/textures';

const TOTAL_LAPS = 3;
const COUNTDOWN_SECONDS = 3.4;
/** Picture-in-picture refresh interval — it costs a second scene render. */
const PIP_INTERVAL = 1 / 20;
/**
 * Minimum spacing between "尾流" toasts. The slipstream branch runs every frame
 * while drafting, so without a cooldown the HUD appended a chip per frame.
 */
const SLIPSTREAM_TOAST_INTERVAL = 1.6;

type RacePhase = 'menu' | 'countdown' | 'racing' | 'finished';

function emptyInput(): RaceInputFrame {
  return { throttle: 0, brake: 0, steer: 0, drift: false, nitro: false, useItem: false, reset: false };
}

/** Two AI colours; the minimap walks this list. Module-level so it is not
 *  rebuilt (and re-allocated) on every HUD push. */
const AI_MINIMAP_COLORS = ['#ff3cac', '#7cff6b'];
const MINIMAP_STRIDE = 8;

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
  private readonly lightP2 = new THREE.PointLight('#ffd166', 2.4, 28);
  private keyLight: THREE.DirectionalLight | null = null;
  private readonly shadowFocus = new THREE.Vector3();
  private post: PostPipeline;
  private readonly speedLines = document.querySelector<HTMLElement>('#speed-lines');
  private offtrackHelp: HTMLElement | null = null;
  private offTrackTimer = 0;
  private readonly loop = new Loop(
    (delta, elapsed) => this.update(delta, elapsed),
    () => this.render(),
  );
  private readonly resizeObserver =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => this.syncViewport())
      : null;
  private readonly onWindowResize = () => this.syncViewport();
  /** Reusable scratch vectors — the per-frame paths must not allocate. */
  private readonly scratchForward = new THREE.Vector3();
  private readonly scratchTo = new THREE.Vector3();
  private readonly scratchOrigin = new THREE.Vector3();
  private readonly scratchSide = new THREE.Vector3();
  private readonly scratchRear = new THREE.Vector3();
  private readonly kartRefs: Array<{ kart: Kart }> = [];
  /** Reused by rankOf — it runs twice per frame and must not allocate. */
  private readonly rankScratch: Array<{
    finished: boolean;
    finishTime: number;
    totalProgress: number;
  }> = [];
  /** Reused by updateHud so the per-frame HUD push allocates nothing. */
  private readonly hudDots: MinimapDot[] = [];
  /** Pooled dot records — mutated in place rather than re-created per frame. */
  private readonly dotPool: MinimapDot[] = [
    { x: 0, z: 0, color: '#2de2ff', isPlayer: true },
    { x: 0, z: 0, color: '#ffd166', isPlayer: true },
    { x: 0, z: 0, color: '#ff3cac', isPlayer: false },
    { x: 0, z: 0, color: '#7cff6b', isPlayer: false },
  ];
  private readonly hudState = {
    mode: 'solo',
    rank: 1,
    rank2: 1,
    totalRacers: 4,
    lap: 1,
    lap2: 1,
    totalLaps: TOTAL_LAPS,
    time: 0,
    bestLap: null,
    speedKmh: 0,
    speed2Kmh: 0,
    nitro: 0,
    nitro2: 0,
    boosting: false,
    boosting2: false,
    drifting: false,
    status: '',
    gear: 'N',
    gear2: 'N',
    driftChargeLevel: 0,
    driftChargeLevel2: 0,
    driftScore: 0,
    item: null,
    item2: null,
    itemLabel: '—',
    itemLabel2: '—',
    trackPath: undefined,
    dots: undefined,
  } as unknown as RaceHudState;

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
  /**
   * Honours the OS "reduce motion" preference. The stylesheet already reacts to
   * it, but the 3D scene did not: particles, camera shake and the full-screen
   * boost flash all kept running. The test hook can override it either way.
   */
  private readonly motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  private reducedMotion = this.motionQuery.matches;
  /** Animation clock driven by `animDelta`, so it freezes with reduced motion. */
  private animElapsed = 0;
  private elapsed = 0;
  private slipstreamToastCooldown = 0;
  private lastSpeedLineOpacity = -1;
  private lastSpeedLinesBoost = false;
  private lastSpeedLinesDrift = false;
  private lastOffTrackHelpVisible = false;
  private readonly startButton = this.getElement('#start-button');
  private readonly continueButton = this.getElement('#continue-button');
  private readonly restartButton = this.getElement('#restart-button');
  private readonly modeSolo = this.getElement('#mode-solo');
  private readonly modeDuo = this.getElement('#mode-duo');
  private readonly pauseFab = this.getElement('#pause-fab');
  private readonly pipToggle = this.getElement('#pip-toggle');
  private readonly pipFrame = this.getElement('#pip-frame');
  private readonly pipLabel = this.getElement('#pip-label');
  private readonly pipWrap = this.getElement('#pip-canvas-wrap');
  private pipEnabled = false;
  private pipAccum = 0;
  private pipRenderer: THREE.WebGLRenderer | null = null;
  private readonly pipCamera = new THREE.PerspectiveCamera(55, 16 / 10, 0.1, 300);
  private pipFocus: { kart: { group: THREE.Group; state: { heading: number; speed: number; position: THREE.Vector3 } }; name: string } | null = null;
  private readonly overlayPause = this.getElement('#overlay-pause');
  private readonly resumeButton = this.getElement('#resume-button');
  private readonly pauseRestartButton = this.getElement('#pause-restart-button');
  private readonly pauseMenuButton = this.getElement('#pause-menu-button');
  private readonly finishMenuButton = this.getElement('#finish-menu-button');
  /** One per settings panel — the start overlay and the pause overlay share the class. */
  private readonly muteToggles = Array.from(
    document.querySelectorAll<HTMLElement>('.mute-toggle'),
  );
  private settings: GameSettings = loadSettings();
  private paused = false;
  private savedBestThisRace: number | null = null;
  /** Built lazily by installDiagnostics() and reused for the whole session. */
  private diagnostics: NonNullable<Window['__THREE_GAME_DIAGNOSTICS__']> | null = null;

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
    this.rebuildKartRefs();

    this.player1.setBoostFlashHandler(() => {
      this.hud.flashNitro();
      this.audio.whoosh();
      this.addTrauma(this.cameraRig1, 0.25);
    });
    this.player2.setBoostFlashHandler(() => {
      this.audio.whoosh();
      this.addTrauma(this.cameraRig2, 0.22);
    });

    this.createScene();
    this.items.build(this.track);
    this.scene.add(this.items.group);
    this.post = createPostPipeline(this.renderer, this.scene, this.cameraP1);
    this.resetRace(true);
    this.hud.showStart();
    this.hud.setMode('solo');
    // Every other menu entry point goes through selectMode(), which hides these.
    // Without this first-load call the PiP toggle (z-index 9, above the overlays
    // at z-index 8) sat on top of the start panel while the pause button, at
    // z-index 6, was correctly buried behind it.
    this.setRaceControlsVisible(false);
    this.syncRenderMode();
    this.syncViewport();
    // Viewport work is event driven — never per frame.
    this.resizeObserver?.observe(this.canvas);
    window.addEventListener('resize', this.onWindowResize);

    this.modeSolo.addEventListener('click', () => this.selectMode('solo'));
    this.modeDuo.addEventListener('click', () => this.selectMode('duo'));
    this.installTrackPicker();
    this.installCarPicker();
    this.applyPlayerCar();
    this.startButton.addEventListener('click', () => {
      clearRaceSave();
      this.refreshContinueButton();
      void this.beginRace();
    });
    this.continueButton.addEventListener('click', () => {
      void this.continueSavedRace();
    });
    this.restartButton.addEventListener('click', () => {
      clearRaceSave();
      this.refreshContinueButton();
      void this.beginRace();
    });
    this.finishMenuButton.addEventListener('click', () => this.returnToMenu());
    this.pauseFab.addEventListener('click', () => this.togglePause());
    this.pipToggle.addEventListener('click', () => this.togglePip());
    this.resumeButton.addEventListener('click', () => this.togglePause(false));
    this.pauseRestartButton.addEventListener('click', () => {
      this.togglePause(false);
      void this.beginRace();
    });
    this.pauseMenuButton.addEventListener('click', () => {
      this.togglePause(false);
      this.returnToMenu();
    });
    this.muteToggles.forEach((el) => {
      el.addEventListener('click', () => this.setMuted(!this.settings.muted));
    });
    document.querySelectorAll('.diff-btn').forEach((el) => {
      el.addEventListener('click', () => {
        const d = (el as HTMLElement).dataset.diff as GameSettings['difficulty'];
        this.setDifficulty(d || 'normal');
      });
    });
    window.addEventListener('keydown', this.onGlobalKey);
    this.motionQuery.addEventListener('change', this.onMotionPreferenceChange);
    this.applySettingsUi();
    this.refreshContinueButton();

    this.installDiagnostics();
    this.installTestHooks();
  }

  private readonly onMotionPreferenceChange = (event: MediaQueryListEvent) => {
    this.reducedMotion = event.matches;
    this.applyMotionPreference();
  };

  private refreshContinueButton(): void {
    const save = loadRace();
    const show = !!save && (save.phase === 'countdown' || save.phase === 'racing');
    this.continueButton.style.display = show ? '' : 'none';
  }

  private captureKartSave(kart: { state: {
    position: THREE.Vector3;
    heading: number;
    speed: number;
    progress: number;
    totalProgress: number;
    lap: number;
    nitro: number;
    finished: boolean;
    finishTime: number;
  } }, item: string | null): KartSave {
    const s = kart.state;
    return {
      x: s.position.x,
      y: s.position.y,
      z: s.position.z,
      heading: s.heading,
      speed: s.speed,
      progress: s.progress,
      totalProgress: s.totalProgress,
      lap: s.lap,
      nitro: s.nitro,
      item,
      finished: s.finished,
      finishTime: s.finishTime,
    };
  }

  private applyKartSave(
    kart: { state: {
      position: THREE.Vector3;
      heading: number;
      speed: number;
      progress: number;
      totalProgress: number;
      lap: number;
      nitro: number;
      finished: boolean;
      finishTime: number;
    }; syncTransform: (d: number) => void },
    save: KartSave,
    setItem?: (item: string | null) => void,
  ): void {
    const s = kart.state;
    s.position.set(save.x, save.y, save.z);
    s.heading = save.heading;
    s.speed = save.speed;
    s.progress = save.progress;
    s.totalProgress = save.totalProgress;
    s.lap = save.lap;
    s.nitro = save.nitro;
    s.finished = save.finished;
    s.finishTime = save.finishTime;
    setItem?.(save.item as never);
    kart.syncTransform(0);
  }

  private persistRace(): void {
    if (this.phase !== 'racing' && this.phase !== 'countdown') return;
    const save: RaceSave = {
      v: 1,
      mode: this.mode,
      trackId: this.trackId,
      phase: this.phase === 'countdown' ? 'countdown' : 'racing',
      raceTime: this.raceTime,
      countdownTimer: this.countdownTimer,
      currentLapStart: this.currentLapStart,
      bestLap: this.bestLap,
      lapTimes: [...this.lapTimes],
      player1: this.captureKartSave(this.player1.kart, this.player1.getItem()),
      player2:
        this.mode === 'duo'
          ? this.captureKartSave(this.player2.kart, this.player2.getItem())
          : null,
      ais: this.ais.filter((a) => a.kart.group.visible).map((a) => this.captureKartSave(a.kart, null)),
      savedAt: Date.now(),
    };
    saveRace(save);
    this.refreshContinueButton();
  }

  private async continueSavedRace(): Promise<void> {
    const save = loadRace();
    if (!save) return;
    try {
      await this.audio.unlock();
      this.audio.setMuted(this.settings.muted);
      this.audio.startEngine();
    } catch {
      // Audio may be blocked in headless / autoplay policies; race still resumes.
    }

    if (save.trackId !== this.trackId) this.selectTrack(save.trackId as TrackLayoutId);
    if (save.mode !== this.mode) this.selectMode(save.mode);

    this.finishShown = false;
    this.paused = false;
    this.overlayPause.style.display = 'none';
    this.overlayPause.classList.remove('visible');
    this.hud.hideStart();
    this.hud.hideFinish();
    this.setRaceControlsVisible(true);

    this.applyKartSave(this.player1.kart, save.player1, (i) =>
      this.player1.setItem((i as ItemType | null) ?? null),
    );
    if (save.mode === 'duo' && save.player2) {
      this.player2.kart.group.visible = true;
      this.applyKartSave(this.player2.kart, save.player2, (i) =>
        this.player2.setItem((i as ItemType | null) ?? null),
      );
    }

    const visibleAis = this.ais.filter((a) => a.kart.group.visible);
    for (let i = 0; i < visibleAis.length && i < save.ais.length; i += 1) {
      this.applyKartSave(visibleAis[i].kart, save.ais[i]);
    }

    this.raceTime = save.raceTime;
    this.currentLapStart = save.currentLapStart;
    this.bestLap = save.bestLap;
    this.lapTimes = [...save.lapTimes];
    this.countdownTimer = save.countdownTimer;
    this.lastCountdownLabel = '';
    this.phase = save.phase;
    this.prevProgressP1 = save.player1.progress;
    this.prevProgressP2 = save.player2?.progress ?? 0;
    this.lastRank1 = this.rankOf(this.player1);
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
    this.updateHud();
    this.render();
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
    for (const el of this.muteToggles) {
      el.textContent = this.settings.muted ? '关' : '开';
      el.classList.toggle('off', this.settings.muted);
    }
    document.querySelectorAll('.diff-btn').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.diff === this.settings.difficulty);
    });
  }

  private setRaceControlsVisible(visible: boolean): void {
    this.pauseFab.classList.toggle('hidden-ctl', !visible);
    this.pipToggle.classList.toggle('hidden-ctl', !visible);
    if (!visible) {
      this.pipEnabled = false;
      this.pipFrame.classList.add('hidden');
      this.pipToggle.classList.remove('active');
    }
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
      this.persistRace();
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
    this.refreshContinueButton();
  }

  private difficultyScale(): number {
    if (this.settings.difficulty === 'easy') return 0.88;
    if (this.settings.difficulty === 'hard') return 1.06;
    return 1;
  }

  private togglePip(): void {
    this.pipEnabled = !this.pipEnabled;
    this.pipFrame.classList.toggle('hidden', !this.pipEnabled);
    this.pipToggle.classList.toggle('active', this.pipEnabled);
    if (this.pipEnabled) this.ensurePipRenderer();
  }

  private ensurePipRenderer(): void {
    if (this.pipRenderer) return;
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 200;
    this.pipWrap.appendChild(canvas);
    this.pipRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.pipRenderer.setPixelRatio(1);
    this.pipRenderer.setSize(320, 200, false);
    this.pipRenderer.outputColorSpace = THREE.SRGBColorSpace;
    this.pipRenderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.pipRenderer.toneMappingExposure = 1.05;
    this.pipCamera.aspect = 320 / 200;
    this.pipCamera.updateProjectionMatrix();
  }

  private updatePip(delta: number): void {
    if (!this.pipEnabled || this.phase === 'menu') return;
    this.ensurePipRenderer();

    // The PiP window owns a second WebGL context, so refresh it at 20fps instead
    // of paying for a full extra scene render on every frame.
    this.pipAccum += delta;
    if (this.pipAccum < PIP_INTERVAL) return;
    const step = Math.min(this.pipAccum, 0.25);
    this.pipAccum = 0;

    // Focus the leading AI (or player2 in duo if no AI ahead)
    let best: (typeof this.ais)[0] | null = null;
    let bestProg = -1;
    for (const ai of this.ais) {
      if (!ai.kart.group.visible) continue;
      if (ai.kart.state.totalProgress > bestProg) {
        bestProg = ai.kart.state.totalProgress;
        best = ai;
      }
    }

    const focusKart = best ? best.kart : this.mode === 'duo' ? this.player2.kart : null;
    if (!focusKart) {
      this.pipFocus = null;
      return;
    }
    if (!this.pipFocus || this.pipFocus.kart !== focusKart) {
      const name = best ? focusKart.displayName : 'P2';
      this.pipFocus = { kart: focusKart, name };
      this.pipLabel.textContent = `对手 · ${name}`;
    }
    if (!this.pipRenderer) return;

    const state = focusKart.state;
    const fwd = this.scratchForward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    this.scratchOrigin.copy(state.position).addScaledVector(fwd, -7.5);
    this.scratchOrigin.y += 3.2;
    this.pipCamera.position.lerp(this.scratchOrigin, 1 - Math.exp(-step * 6));
    this.scratchRear.copy(state.position).addScaledVector(fwd, 5);
    this.scratchRear.y += 0.8;
    this.pipCamera.lookAt(this.scratchRear);
    const fov = 52 + Math.min(state.speed * 0.2, 12);
    if (Math.abs(this.pipCamera.fov - fov) > 0.01) {
      this.pipCamera.fov = fov;
      this.pipCamera.updateProjectionMatrix();
    }
    this.pipRenderer.render(this.scene, this.pipCamera);
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
    this.pipRenderer?.dispose();
    this.renderer.dispose();
    window.removeEventListener('keydown', this.onGlobalKey);
    window.removeEventListener('resize', this.onWindowResize);
    this.motionQuery.removeEventListener('change', this.onMotionPreferenceChange);
    this.resizeObserver?.disconnect();
    window.__THREE_GAME_DIAGNOSTICS__ = undefined;
    window.__THREE_GAME_TEST_HOOKS__ = undefined;
    this.diagnostics = null;
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
    this.setRaceControlsVisible(false);
    // Re-sync cameras and canvas size after the mode switch.
    this.syncRenderMode();
    this.syncViewport();
    this.render();
  }

  private installCarPicker(): void {
    const host = document.querySelector('#car-picker');
    if (!host) return;
    host.innerHTML = '';
    for (const car of CAR_STYLES) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `car-btn${car.id === this.settings.carId ? ' active' : ''}`;
      btn.dataset.carId = car.id;
      btn.innerHTML = `<span class="swatch" style="background:linear-gradient(135deg,${car.color},${car.accent})"></span><strong>${car.name}</strong><span>${car.desc}</span>`;
      btn.addEventListener('click', () => this.selectCar(car.id));
      host.appendChild(btn);
    }
  }

  private selectCar(id: string): void {
    this.settings.carId = id;
    saveSettings(this.settings);
    document.querySelectorAll('.car-btn').forEach((el) => {
      el.classList.toggle('active', (el as HTMLElement).dataset.carId === id);
    });
    this.applyPlayerCar();
  }

  private applyPlayerCar(): void {
    const style = getCarStyle(this.settings.carId);
    this.scene.remove(this.player1.kart.group);
    this.player1.applyStyle({
      color: style.color,
      accent: style.accent,
      name: 'P1',
      livery: style.livery,
    });
    this.scene.add(this.player1.kart.group);
    this.rebuildKartRefs();
    this.player1.setBoostFlashHandler(() => {
      this.hud.flashNitro();
      this.audio.whoosh();
      this.addTrauma(this.cameraRig1, 0.25);
    });
    if (this.phase === 'menu') {
      this.player1.reset(this.track);
      this.cameraRig1.snapTo(
        this.player1.kart.state.position,
        this.player1.kart.state.heading,
        0,
      );
    }
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
    this.setRaceControlsVisible(true);
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

    // Reduced motion freezes every ambient animation. `animElapsed` is driven by
    // the same clamped delta, so track/pad/box bobbing stops with it instead of
    // continuing off the raw wall clock.
    const animDelta = this.reducedMotion ? 0 : delta;
    this.animElapsed += animDelta;

    this.track.update(animDelta, this.animElapsed);
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
    // The race clock only runs while racing — countdown / pause / finish freeze it.
    if (raceActive) this.raceTime += delta;
    this.items.update(animDelta, this.animElapsed);

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
        this.addTrauma(this.cameraRig1, 0.08);
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
    if (this.slipstreamToastCooldown > 0) {
      this.slipstreamToastCooldown = Math.max(0, this.slipstreamToastCooldown - delta);
    }

    if (this.phase === 'racing' && this.checkFinish()) {
      this.finishRace();
    }

    this.updateHud();
    this.updatePip(delta);
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
      this.audio.whoosh();
      this.addTrauma(which === 1 ? this.cameraRig1 : this.cameraRig2, 0.3);
      if (!this.reducedMotion) {
        const pos = this.scratchOrigin.copy(player.kart.state.position);
        pos.y = 0.3;
        this.vfx.emitShockwave(pos, '#ffd166');
      }
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
      this.addTrauma(cam, 0.22 + (result.driftBoost ?? 0) * 0.06);
      this.emitBoostShock(player);
      if (which === 1) this.hud.flashNitro();
      this.flashScreen(result.driftBoost > 0 ? 'drift' : 'boost');
    }
    if (result.wallScrape) {
      this.addTrauma(cam, 0.06);
      if (!this.reducedMotion) {
        const pos = this.scratchOrigin.copy(player.kart.state.position);
        pos.y = 0.2;
        this.vfx.emitSparks(pos, 6, '#ffd166');
      }
    }
    if (result.driftBoost > 0) {
      this.registerCombo('drift');
    }

    // Slipstream: draft behind another kart for a speed kick
    if (canControl && player.kart.state.speed > 16 && !player.kart.state.isBoosting) {
      const forward = this.scratchForward.set(
        Math.sin(player.kart.state.heading),
        0,
        Math.cos(player.kart.state.heading),
      );
      // kartRefs is built once; invisible slots (P2 in solo) are skipped below.
      for (const other of this.kartRefs) {
        if (other.kart === player.kart) continue;
        if (!other.kart.group.visible) continue;
        const to = this.scratchTo.copy(other.kart.state.position).sub(player.kart.state.position);
        const dist = to.length();
        if (dist > 3 && dist < 12) {
          to.normalize();
          const dot = to.dot(forward);
          if (dot > 0.88) {
            player.applySlipstream(delta);
            // This branch runs on every frame the draft window is open, so the
            // toast needs its own cooldown — it used to append a chip per frame.
            if (which === 1 && this.slipstreamToastCooldown <= 0) {
              this.hud.showCombo('尾流', 1);
              this.slipstreamToastCooldown = SLIPSTREAM_TOAST_INTERVAL;
            }
            break;
          }
        }
      }
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
        this.addTrauma(cam, 0.55);
        this.audio.whoosh();
        this.flashScreen('hit');
        if (!this.reducedMotion) {
          const pos = this.scratchOrigin.copy(player.kart.state.position);
          pos.y = 0.3;
          this.vfx.emitSparks(pos, 20, '#ff6b6b');
        }
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
      this.addTrauma(cam, 0.3);
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
    // The results panel replaces the race controls; leaving them up let the PiP
    // toggle (z-index 9) float over the panel.
    this.setRaceControlsVisible(false);
    clearRaceSave();
    this.refreshContinueButton();
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
    if (!this.reducedMotion) {
      const fx = this.scratchOrigin.copy(this.player1.kart.state.position);
      fx.y = 2;
      this.vfx.emitFireworks(fx);
      if (this.mode === 'duo') {
        this.vfx.emitFireworks(
          this.scratchTo.copy(this.player2.kart.state.position).setY(2),
        );
      }
    }
    this.audio.whoosh();
    this.audio.countdownBeep(true);
    this.addTrauma(this.cameraRig1, 0.4);
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
    this.addTrauma(this.cameraRig1, 0.4);
    this.audio.whoosh();
  }

  /**
   * Camera shake is one of the things "reduce motion" is meant to switch off,
   * so every trauma request goes through here rather than straight to the rig.
   */
  private addTrauma(rig: CameraRig, amount: number): void {
    if (this.reducedMotion) return;
    rig.addTrauma(amount);
  }

  /**
   * Keeps the shadow frustum centred on the action. The focus snaps to a 4-unit
   * grid so the shadow map doesn't shimmer while driving.
   */
  private followShadow(position: THREE.Vector3): void {
    if (!this.keyLight) return;
    const focusX = Math.round(position.x / 4) * 4;
    const focusZ = Math.round(position.z / 4) * 4;
    this.shadowFocus.set(focusX, 0, focusZ);
    this.keyLight.position.set(focusX + 50, 80, focusZ + 30);
    this.keyLight.target.position.copy(this.shadowFocus);
  }

  /** Selects the single-camera or split-screen post pass for the current mode. */
  private syncRenderMode(): void {
    if (this.mode === 'duo') this.post.setCameras(this.cameraP1, this.cameraP2);
    else this.post.setCameras(this.cameraP1);
  }

  /**
   * Applies canvas size and camera aspect changes. Driven by ResizeObserver and
   * window resize rather than running on every frame.
   */
  private syncViewport(): void {
    const resized = resizeRenderer(this.renderer, this.cameraP1, this.tuning.maxDpr);
    const aspect = Math.max(0.5, this.canvas.clientWidth / Math.max(1, this.canvas.clientHeight));
    const viewAspect = this.mode === 'duo' ? aspect / 2 : aspect;

    let aspectChanged = false;
    if (Math.abs(this.cameraP1.aspect - viewAspect) > 1e-4) {
      this.cameraP1.aspect = viewAspect;
      this.cameraP1.updateProjectionMatrix();
      aspectChanged = true;
    }
    if (Math.abs(this.cameraP2.aspect - viewAspect) > 1e-4) {
      this.cameraP2.aspect = viewAspect;
      this.cameraP2.updateProjectionMatrix();
      aspectChanged = true;
    }

    if (resized || aspectChanged) this.post.resize();
  }

  private rebuildKartRefs(): void {
    this.kartRefs.length = 0;
    this.kartRefs.push({ kart: this.player1.kart }, { kart: this.player2.kart });
    for (const ai of this.ais) this.kartRefs.push({ kart: ai.kart });
    this.applyMotionPreference();
  }

  /** Pushes the current motion preference down to every kart's decoration. */
  private applyMotionPreference(): void {
    for (const { kart } of this.kartRefs) kart.setReducedMotion(this.reducedMotion);
  }

  private render(): void {
    // Single choke point for every drawn frame, so the shadow frustum is always
    // centred on the player even after a snap/respawn without an update tick.
    this.followShadow(this.player1.kart.state.position);
    // Solo renders one view, duo renders a scissored pair — both through the
    // composer so bloom and tone mapping stay identical.
    this.post.render();
  }

  private createScene(): void {
    // City skyline backdrop cylinder (generated panorama) — tall & close so it reads in-frame
    const skyTex = loadGameTexture('/assets/sky-city.webp', { repeat: [3, 1] });
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

    const hemisphere = new THREE.HemisphereLight('#e0eeff', '#2a2840', 2.35);
    this.scene.add(hemisphere);

    const key = new THREE.DirectionalLight('#fff2e0', 2.75);
    key.position.set(50, 80, 30);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 200;
    // Tight frustum: it now tracks the player instead of covering the whole map.
    key.shadow.camera.left = -64;
    key.shadow.camera.right = 64;
    key.shadow.camera.top = 64;
    key.shadow.camera.bottom = -64;
    key.shadow.bias = -0.0004;
    this.scene.add(key);
    this.scene.add(key.target);
    this.keyLight = key;

    const fill = new THREE.DirectionalLight('#6a9ae8', 0.7);
    fill.position.set(-40, 50, 50);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight('#8a5078', 0.25);
    rim.position.set(-60, 25, -40);
    this.scene.add(rim);

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
    this.slipstreamToastCooldown = 0;
    this.player1.resetDriftScore();
    this.player2.resetDriftScore();
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
    this.addTrauma(this.cameraRig1, 0.2);
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
    // Reused array: rankOf runs twice per frame from the HUD and the rank flash.
    const others = this.rankScratch;
    others.length = 0;
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
    if (this.reducedMotion) return;
    const state = player.kart.state;
    const origin = this.scratchOrigin.copy(state.position);
    origin.y = 0.15;
    const forward = this.scratchForward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    if (state.isDrifting && state.speed > 5) {
      this.vfx.emitDrift(origin, forward, Math.abs(state.driftAngle) + 0.3);
      // Dual-wheel spark burst for a more dramatic drift
      const side = this.scratchSide.set(forward.z, 0, -forward.x);
      const left = this.scratchRear.copy(origin).addScaledVector(side, 0.9);
      left.y = 0.12;
      this.vfx.emitDrift(left, forward, Math.abs(state.driftAngle));
      const right = this.scratchTo.copy(origin).addScaledVector(side, -0.9);
      right.y = 0.12;
      this.vfx.emitDrift(right, forward, Math.abs(state.driftAngle));
    }
    if (state.isBoosting) {
      this.vfx.emitBoost(origin, forward);
      const rear = this.scratchRear.copy(origin).addScaledVector(forward, -1.2);
      rear.y = 0.25;
      this.vfx.emitBoost(rear, forward);
    } else if (state.speed > 32) {
      // High-speed heat trail (seeded, not Math.random)
      const rear = this.scratchRear.copy(origin).addScaledVector(forward, -1.0);
      rear.y = 0.2;
      if (this.rng() > 0.55) this.vfx.emitSparks(rear, 1, '#8ac8ff');
    }
  }

  private emitBoostShock(player: PlayerRacer): void {
    if (this.reducedMotion) return;
    const s = player.kart.state;
    const pos = this.scratchOrigin.copy(s.position);
    pos.y = 0.2;
    this.vfx.emitShockwave(pos, '#7cf6ff');
    this.vfx.emitSparks(pos, 14, '#2de2ff');
  }

  private updateSpeedLines(speed: number, boosting: boolean, drifting: boolean): void {
    if (!this.speedLines) return;
    const ratio = THREE.MathUtils.clamp((speed - 18) / 50, 0, 1);
    const opacity = Math.max(ratio * 0.7, boosting ? 0.95 : 0);
    // Style writes invalidate the element, so only touch the DOM when a value
    // actually changed — this runs every frame.
    if (opacity !== this.lastSpeedLineOpacity) {
      this.speedLines.style.opacity = String(opacity);
      this.lastSpeedLineOpacity = opacity;
    }
    if (boosting !== this.lastSpeedLinesBoost) {
      this.speedLines.classList.toggle('boost', boosting);
      this.lastSpeedLinesBoost = boosting;
    }
    if (drifting !== this.lastSpeedLinesDrift) {
      this.speedLines.classList.toggle('drift', drifting);
      this.lastSpeedLinesDrift = drifting;
    }
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
      this.addTrauma(this.cameraRig1, 0.15);
    }
  }

  private updateOffTrackHelp(delta: number, offTrack: boolean, speed: number): void {
    if (!this.offtrackHelp) return;
    if (offTrack && speed > 2 && this.phase === 'racing') {
      this.offTrackTimer += delta;
    } else {
      this.offTrackTimer = 0;
    }
    const visible = this.offTrackTimer > 1.2;
    if (visible !== this.lastOffTrackHelpVisible) {
      this.offtrackHelp.classList.toggle('visible', visible);
      this.lastOffTrackHelpVisible = visible;
    }
  }

  private flashScreen(kind: 'boost' | 'drift' | 'hit'): void {
    const el = this.speedLines;
    if (!el || this.reducedMotion) return;
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
      const path: Array<{ x: number; z: number }> = [];
      for (let i = 0; i < this.track.samples.length; i += MINIMAP_STRIDE) {
        const sample = this.track.samples[i];
        path.push({ x: sample.position.x, z: sample.position.z });
      }
      this.minimapPath = path;
    }

    // Dots are pooled and mutated in place — this runs on every frame.
    const dots = this.hudDots;
    dots.length = 0;
    const first = this.dotPool[0];
    first.x = p1.position.x;
    first.z = p1.position.z;
    first.color = '#2de2ff';
    first.isPlayer = true;
    dots.push(first);
    let slot = 1;

    if (this.mode === 'duo') {
      const second = this.dotPool[slot];
      slot += 1;
      second.x = p2.position.x;
      second.z = p2.position.z;
      second.color = '#ffd166';
      second.isPlayer = true;
      dots.push(second);
    }
    for (let i = 0; i < this.ais.length && slot < this.dotPool.length; i += 1) {
      if (!this.ais[i].kart.group.visible) continue;
      const dot = this.dotPool[slot];
      slot += 1;
      dot.x = this.ais[i].kart.state.position.x;
      dot.z = this.ais[i].kart.state.position.z;
      dot.color = AI_MINIMAP_COLORS[i] ?? '#ffffff';
      dot.isPlayer = false;
      dots.push(dot);
    }

    const hud = this.hudState;
    hud.mode = this.mode;
    hud.rank = rank1;
    hud.rank2 = rank2;
    hud.totalRacers = total;
    hud.lap = Math.min(Math.max(p1.lap, 0) + 1, TOTAL_LAPS);
    hud.lap2 = Math.min(Math.max(p2.lap, 0) + 1, TOTAL_LAPS);
    hud.totalLaps = TOTAL_LAPS;
    hud.time = this.raceTime;
    hud.bestLap = this.bestLap;
    hud.speedKmh = p1.speed * 3.6;
    hud.speed2Kmh = p2.speed * 3.6;
    hud.nitro = p1.nitro;
    hud.nitro2 = p2.nitro;
    hud.boosting = p1.isBoosting;
    hud.boosting2 = p2.isBoosting;
    hud.drifting = p1.isDrifting;
    hud.status = status;
    hud.gear = gearOf(p1.speed, p1.isBoosting);
    hud.gear2 = gearOf(p2.speed, p2.isBoosting);
    hud.driftChargeLevel = this.player1.getDriftChargeLevel();
    hud.driftChargeLevel2 = this.player2.getDriftChargeLevel();
    hud.driftScore = this.player1.getDriftScore();
    hud.item = this.player1.getItem();
    hud.item2 = this.player2.getItem();
    hud.itemLabel = itemLabel(this.player1.getItem());
    hud.itemLabel2 = itemLabel(this.player2.getItem());
    hud.trackPath = this.minimapPath;
    hud.dots = dots;
    this.hud.update(hud);
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
      /**
       * Hands the player an item without having to drive over a box. Item boxes
       * sit at randomised lateral offsets, so collection is not deterministic.
       */
      grantItem: (type?: string) => {
        this.player1.setItem((type as ItemType | undefined) ?? 'turbo');
        this.updateHud();
        this.render();
        this.publishDiagnostics();
        return { item: this.player1.getItem() };
      },
      /**
       * Parks P1 a few units behind the leading AI, aimed at it, so the
       * slipstream window is open. Both the draft cone and the item boxes are
       * position dependent, and driving there in a headless run is not
       * reproducible, so the geometry is set up directly.
       */
      draftPlayer: () => {
        let leader: AIRacer | null = null;
        let leaderProgress = -1;
        for (const ai of this.ais) {
          if (!ai.kart.group.visible) continue;
          if (ai.kart.state.totalProgress > leaderProgress) {
            leaderProgress = ai.kart.state.totalProgress;
            leader = ai;
          }
        }
        if (!leader) return { drafted: false, distance: -1, dot: 0 };
        const target = leader.kart.state;
        const heading = target.heading;
        const forward = this.scratchForward.set(Math.sin(heading), 0, Math.cos(heading));
        const s = this.player1.kart.state;
        s.position.copy(target.position).addScaledVector(forward, -7);
        s.position.y = 0;
        s.heading = heading;
        s.speed = Math.min(target.speed + 6, 44);
        s.isBoosting = false;
        s.boostTimer = 0;
        s.lateralSpeed = 0;
        s.driftAngle = 0;
        s.isDrifting = false;
        s.progress = this.track.projectProgress(s.position, s.progress);
        this.prevProgressP1 = s.progress;
        this.player1.kart.syncTransform(0);
        this.updateHud();
        this.render();
        this.publishDiagnostics();
        const to = this.scratchTo.copy(target.position).sub(s.position);
        const distance = to.length();
        return { drafted: true, distance, dot: distance > 0 ? to.normalize().dot(forward) : 0 };
      },
      setPausedForScreenshot: (paused: boolean) => {
        this.pausedForScreenshot = paused;
      },
      setReducedMotion: (enabled: boolean) => {
        this.reducedMotion = enabled;
        this.applyMotionPreference();
        this.render();
        this.publishDiagnostics();
      },
      /**
       * The composer masks renderer.info (the last pass is a fullscreen quad),
       * so measure the raw scene cost with one direct render.
       */
      measureDrawCalls: () => {
        const info = this.renderer.info;
        const autoReset = info.autoReset;
        const previousTarget = this.renderer.getRenderTarget();
        info.autoReset = false;
        info.reset();
        this.renderer.setScissorTest(false);
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.cameraP1);
        const calls = info.render.calls;
        const triangles = info.render.triangles;
        info.autoReset = autoReset;
        info.reset();
        this.renderer.setRenderTarget(previousTarget);
        return { calls, triangles, geometries: info.memory.geometries };
      },
      hideDebugUi: (_hidden: boolean) => {
        // no-op
      },
    };
  }

  /**
   * Diagnostics used to be rebuilt from scratch on every frame — a fresh tree
   * of ~10 nested objects, purely so that test scripts could read a couple of
   * numbers. Install it once with live getters instead: readers see the current
   * values and the render loop allocates nothing.
   */
  private installDiagnostics(): void {
    if (this.diagnostics && window.__THREE_GAME_DIAGNOSTICS__ === this.diagnostics) return;
    const game = this;
    this.diagnostics = {
      get frame() {
        return game.frame;
      },
      get elapsed() {
        return game.elapsed;
      },
      get raceTime() {
        return game.raceTime;
      },
      get phase() {
        return game.phase;
      },
      get mode() {
        return game.mode;
      },
      get track() {
        return game.trackId;
      },
      get lap() {
        return game.player1.kart.state.lap;
      },
      get rank() {
        return game.rankOf(game.player1);
      },
      get bestLap() {
        return game.bestLap;
      },
      get complete() {
        return game.phase === 'finished';
      },
      get reducedMotion() {
        return game.reducedMotion;
      },
      get vfxLive() {
        return game.vfx.live;
      },
      get player() {
        const state = game.player1.kart.state;
        return {
          position: { x: state.position.x, y: state.position.y, z: state.position.z },
          speed: state.speed,
          heading: state.heading,
          nitro: state.nitro,
          progress: state.progress,
          totalProgress: state.totalProgress,
          drifting: state.isDrifting,
          boosting: state.isBoosting,
          offTrack: state.offTrack,
        };
      },
      get player2() {
        if (game.mode !== 'duo') return undefined;
        const state = game.player2.kart.state;
        return {
          position: { x: state.position.x, y: state.position.y, z: state.position.z },
          speed: state.speed,
          nitro: state.nitro,
          progress: state.progress,
        };
      },
      get renderer() {
        const info = game.renderer.info;
        return {
          calls: info.render.calls,
          triangles: info.render.triangles,
          geometries: info.memory.geometries,
          textures: info.memory.textures,
        };
      },
      get canvas() {
        return {
          clientWidth: game.canvas.clientWidth,
          clientHeight: game.canvas.clientHeight,
          width: game.canvas.width,
          height: game.canvas.height,
          dpr: Math.min(window.devicePixelRatio || 1, game.tuning.maxDpr),
        };
      },
    };
    window.__THREE_GAME_DIAGNOSTICS__ = this.diagnostics;
  }

  /** Cheap per-frame keep-alive: re-installs only if something cleared it. */
  private publishDiagnostics(): void {
    this.installDiagnostics();
  }

  private getElement(selector: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(selector);
    if (!element) throw new Error(`Missing element: ${selector}`);
    return element;
  }
}
