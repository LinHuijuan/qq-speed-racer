import * as THREE from 'three';
import type { RaceInputFrame } from '../core/InputController';
import type { Track } from '../game/Track';
import type { ItemType } from '../systems/ItemSystem';
import { Kart } from './Kart';

export type KartTuning = {
  maxSpeed: number;
  boostSpeed: number;
  acceleration: number;
  brakePower: number;
  turnRate: number;
  grip: number;
  driftTurnMultiplier: number;
  driftFriction: number;
  offTrackDrag: number;
  wallBounce: number;
  nitroDrain: number;
  driftCharge: number;
  boostPadStrength: number;
  boostPadDuration: number;
};

export const PLAYER_TUNING: KartTuning = {
  maxSpeed: 52,
  boostSpeed: 78,
  acceleration: 38,
  brakePower: 48,
  turnRate: 2.6,
  grip: 10.5,
  driftTurnMultiplier: 1.55,
  driftFriction: 1.4,
  offTrackDrag: 16,
  wallBounce: 0.4,
  nitroDrain: 0.32,
  driftCharge: 0.52,
  boostPadStrength: 1.2,
  boostPadDuration: 1.4,
};

/**
 * Exported so the HUD can explain a rejected drift with the same number the
 * physics actually tests, instead of a copy that drifts out of sync.
 */
export const MIN_SPEED_TO_DRIFT = 12;
/** `canDrift` also requires this much steering input — see `update()`. */
export const MIN_STEER_TO_DRIFT = 0.12;
const NITRO_MAX = 1;

export type DriftBoostLevel = 0 | 1 | 2 | 3;

export class PlayerRacer {
  kart: Kart;
  private readonly forward = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private boostFlashHandler: (() => void) | null = null;
  private driftCharge = 0;
  private shieldTimer = 0;
  private stunTimer = 0;
  private slowTimer = 0;
  private item: ItemType | null = null;
  private scrapeThisFrame = false;
  private driftScore = 0;

  constructor(config?: { color: string; accent: string; name: string; livery?: string }) {
    this.kart = new Kart({
      color: config?.color ?? '#2a6cff',
      accent: config?.accent ?? '#2de2ff',
      name: config?.name ?? '你',
      livery: config?.livery,
    });
  }

  /** Swap visual style without losing race state. */
  applyStyle(config: { color: string; accent: string; name: string; livery?: string }): void {
    const s = { ...this.kart.state };
    this.kart.dispose();
    this.kart = new Kart(config);
    this.kart.state.position.copy(s.position);
    this.kart.state.heading = s.heading;
    this.kart.state.speed = s.speed;
    this.kart.state.lap = s.lap;
    this.kart.state.progress = s.progress;
    this.kart.state.totalProgress = s.totalProgress;
    this.kart.state.nitro = s.nitro;
    this.kart.state.finished = s.finished;
    this.kart.state.finishTime = s.finishTime;
    this.kart.syncTransform(0);
  }

  reset(track: Track): void {
    const start = track.startTransform;
    this.kart.reset(start.position, start.heading);
    this.driftCharge = 0;
    this.shieldTimer = 0;
    this.stunTimer = 0;
    this.slowTimer = 0;
    this.item = null;
  }

  setBoostFlashHandler(handler: (() => void) | null): void {
    this.boostFlashHandler = handler;
  }

  getItem(): ItemType | null {
    return this.item;
  }

  setItem(item: ItemType | null): void {
    this.item = item;
  }

  hasShield(): boolean {
    return this.shieldTimer > 0;
  }

  applyShield(duration = 3): void {
    this.shieldTimer = Math.max(this.shieldTimer, duration);
  }

  applyMissileHit(): boolean {
    if (this.shieldTimer > 0) {
      this.shieldTimer = 0;
      return false;
    }
    this.stunTimer = 1.1;
    this.slowTimer = 2.2;
    this.kart.state.speed *= 0.35;
    return true;
  }

  applyMineHit(): boolean {
    if (this.shieldTimer > 0) {
      this.shieldTimer = 0;
      return false;
    }
    this.stunTimer = 0.7;
    this.slowTimer = 1.6;
    this.kart.state.speed *= 0.45;
    return true;
  }

  getDriftChargeLevel(): DriftBoostLevel {
    if (this.driftCharge >= 0.75) return 3;
    if (this.driftCharge >= 0.45) return 2;
    if (this.driftCharge >= 0.2) return 1;
    return 0;
  }

  getDriftCharge(): number {
    return this.driftCharge;
  }

  /**
   * While stunned the kart ignores throttle, steering, drift, nitro and items
   * outright — which, without a readout, is indistinguishable from a broken
   * controller. The HUD says so instead of leaving the player to guess.
   */
  isStunned(): boolean {
    return this.stunTimer > 0;
  }

  getDriftScore(): number {
    return Math.floor(this.driftScore);
  }

  resetDriftScore(): void {
    this.driftScore = 0;
  }

  /** Snap kart back onto the racing surface at the nearest track point. */
  resetToTrack(track: Track): void {
    const state = this.kart.state;
    const t = track.projectProgress(state.position, state.progress);
    const sample = track.sampleAt(t);
    state.position.copy(sample.position);
    state.position.y = 0;
    state.heading = Math.atan2(sample.tangent.x, sample.tangent.z);
    state.velocity.set(0, 0, 0);
    state.lateralSpeed = 0;
    state.driftAngle = 0;
    state.isDrifting = false;
    state.offTrack = false;
    state.progress = t;
    // Keep some momentum so it doesn't feel like a full stop
    state.speed = Math.min(state.speed, PLAYER_TUNING.maxSpeed * 0.55);
    state.speed = Math.max(state.speed, 12);
    this.kart.syncTransform(0);
  }

  /** Snap the kart back onto the racing surface at the nearest sample. */
  respawnOnTrack(track: Track): void {
    const state = this.kart.state;
    const sample = track.sampleAt(state.progress);
    state.position.copy(sample.position);
    state.position.y = 0;
    state.heading = Math.atan2(sample.tangent.x, sample.tangent.z);
    state.velocity.set(0, 0, 0);
    state.lateralSpeed = 0;
    state.driftAngle = 0;
    state.isDrifting = false;
    state.offTrack = false;
    state.speed = Math.max(state.speed * 0.55, 12);
    this.driftCharge = 0;
    this.kart.syncTransform(0);
  }

  update(
    delta: number,
    input: RaceInputFrame,
    track: Track,
    canControl: boolean,
    previousProgress: number,
    useItem: boolean,
  ): { nitroUsed: boolean; boostPad: boolean; firedItem: ItemType | null; driftBoost: DriftBoostLevel; wallScrape: boolean; slipstream: boolean } {
    const state = this.kart.state;
    this.shieldTimer = Math.max(0, this.shieldTimer - delta);
    this.stunTimer = Math.max(0, this.stunTimer - delta);
    this.slowTimer = Math.max(0, this.slowTimer - delta);

    let firedItem: ItemType | null = null;
    if (useItem && this.item && this.stunTimer <= 0) {
      firedItem = this.item;
      this.item = null;
      if (firedItem === 'turbo') {
        state.boostTimer = Math.max(state.boostTimer, 1.6);
        state.isBoosting = true;
        state.speed = Math.max(state.speed, PLAYER_TUNING.boostSpeed * 0.75);
      } else if (firedItem === 'shield') {
        this.applyShield(3.5);
      }
      this.boostFlashHandler?.();
    }

    if (state.finished) {
      state.speed = Math.max(0, state.speed - 12 * delta);
      this.applyVelocityFromHeading(delta);
      this.resolveTrack(delta, track, previousProgress);
      this.kart.syncTransform(delta);
      return { nitroUsed: false, boostPad: false, firedItem, driftBoost: 0, wallScrape: false, slipstream: false };
    }

    const stunned = this.stunTimer > 0;
    const throttle = canControl && !stunned ? input.throttle : 0;
    const brake = canControl && !stunned ? input.brake : 0;
    const steer = canControl && !stunned ? input.steer : 0;
    const wantDrift = canControl && !stunned && input.drift;
    const wantNitro = canControl && !stunned && input.nitro;

    if (state.boostTimer > 0) {
      state.boostTimer = Math.max(0, state.boostTimer - delta);
    }

    let nitroUsed = false;
    if (wantNitro && state.nitro > 0.05 && state.boostTimer <= 0.05) {
      state.isBoosting = true;
      state.nitro = Math.max(0, state.nitro - PLAYER_TUNING.nitroDrain * delta);
      nitroUsed = true;
    } else if (state.boostTimer > 0) {
      state.isBoosting = true;
    } else {
      state.isBoosting = false;
    }

    // Drift store — hold drift to charge, release for a mini turbo
    const canDrift =
      wantDrift && state.speed > MIN_SPEED_TO_DRIFT && Math.abs(steer) > MIN_STEER_TO_DRIFT;
    let driftBoost: DriftBoostLevel = 0;
    if (canDrift && !state.isDrifting) {
      state.isDrifting = true;
      state.driftAngle = Math.sign(steer) * 0.25;
      this.driftCharge = 0;
    } else if (!wantDrift && state.isDrifting) {
      driftBoost = this.getDriftChargeLevel();
      if (driftBoost > 0) {
        const strength = 0.35 + driftBoost * 0.28;
        state.boostTimer = Math.max(state.boostTimer, strength);
        state.isBoosting = true;
        state.speed = Math.max(state.speed, PLAYER_TUNING.maxSpeed * (0.95 + driftBoost * 0.04));
        this.boostFlashHandler?.();
      }
      state.isDrifting = false;
      this.driftCharge = 0;
    }

    const turnScale = THREE.MathUtils.clamp(1.2 - state.speed / 90, 0.48, 1.15);
    // Chase camera looks along +Z, so world +X is screen-LEFT.
    // Left key must increase heading (nose → +X = screen left).
    const turn = -steer * PLAYER_TUNING.turnRate * turnScale;
    if (state.isDrifting) {
      state.heading += turn * PLAYER_TUNING.driftTurnMultiplier * delta;
      const targetDrift = THREE.MathUtils.clamp(-steer * 0.58, -0.72, 0.72);
      state.driftAngle = THREE.MathUtils.damp(state.driftAngle, targetDrift, 4.8, delta);
      this.driftCharge = Math.min(1, this.driftCharge + PLAYER_TUNING.driftCharge * Math.abs(steer) * delta);
      state.nitro = Math.min(NITRO_MAX, state.nitro + PLAYER_TUNING.driftCharge * 0.7 * Math.abs(steer) * delta);
    } else {
      state.heading += turn * delta;
      state.driftAngle = THREE.MathUtils.damp(state.driftAngle, 0, 7.5, delta);
    }

    const slowFactor = this.slowTimer > 0 ? 0.72 : 1;
    const maxSpeed =
      (state.isBoosting ? PLAYER_TUNING.boostSpeed : PLAYER_TUNING.maxSpeed) * slowFactor;
    if (throttle > 0) {
      const accel =
        PLAYER_TUNING.acceleration * (state.isBoosting ? 1.45 : 1) * (1 - state.speed / (maxSpeed * 1.1));
      state.speed += accel * throttle * delta;
    } else if (brake > 0) {
      state.speed -= PLAYER_TUNING.brakePower * brake * delta;
      if (state.speed < 0) state.speed = Math.max(state.speed, -10);
    } else {
      state.speed -= 4.2 * delta;
      if (state.speed < 0) state.speed = 0;
    }

    this.forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    this.right.set(this.forward.z, 0, -this.forward.x);

    const velocity = state.velocity.copy(this.forward).multiplyScalar(state.speed);
    if (state.isDrifting) {
      // Drift slide follows the same visual-left convention as steering.
      state.lateralSpeed = THREE.MathUtils.damp(state.lateralSpeed, -steer * state.speed * 0.28, 5, delta);
      velocity.addScaledVector(this.right, state.lateralSpeed);
      state.speed = Math.max(0, state.speed - PLAYER_TUNING.driftFriction * delta);
      this.driftScore += Math.abs(state.driftAngle) * state.speed * delta * 2.5;
    } else {
      state.lateralSpeed = THREE.MathUtils.damp(state.lateralSpeed, 0, PLAYER_TUNING.grip, delta);
      velocity.addScaledVector(this.right, state.lateralSpeed);
    }

    if (state.offTrack) {
      state.speed = Math.max(0, state.speed - PLAYER_TUNING.offTrackDrag * delta);
      velocity.multiplyScalar(0.92);
    }

    state.speed = Math.min(state.speed, maxSpeed * 1.02);
    state.position.addScaledVector(velocity, delta);
    state.position.y = 0;

    const boostPad = this.resolveTrack(delta, track, previousProgress);
    const wallScrape = this.scrapeThisFrame;
    this.scrapeThisFrame = false;
    if (boostPad) {
      state.boostTimer = Math.max(state.boostTimer, PLAYER_TUNING.boostPadDuration);
      state.isBoosting = true;
      state.speed = Math.max(state.speed, PLAYER_TUNING.boostSpeed * 0.82);
      this.boostFlashHandler?.();
    }

    this.kart.syncTransform(delta);
    return { nitroUsed, boostPad, firedItem, driftBoost, wallScrape, slipstream: false };
  }

  /** Called by Game when drafting behind another kart. */
  applySlipstream(delta: number): void {
    const state = this.kart.state;
    if (state.speed < 8) return;
    state.speed += 14 * delta;
    state.speed = Math.min(state.speed, PLAYER_TUNING.boostSpeed * 0.95);
  }

  private applyVelocityFromHeading(delta: number): void {
    const state = this.kart.state;
    this.forward.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    state.velocity.copy(this.forward).multiplyScalar(state.speed);
    state.position.addScaledVector(state.velocity, delta);
  }

  private resolveTrack(delta: number, track: Track, previousProgress: number): boolean {
    const state = this.kart.state;
    state.progress = track.projectProgress(state.position, previousProgress);
    const { lateral, sample } = track.lateralOffset(state.position, state.progress);
    state.offTrack = Math.abs(lateral) > track.halfWidth * 0.96;

    // Soft walls + scrape detection
    const wallLimit = track.halfWidth + 0.85;
    const scrapeZone = track.halfWidth + 0.35;
    if (Math.abs(lateral) > scrapeZone && Math.abs(lateral) <= wallLimit) {
      this.scrapeThisFrame = true;
    }
    if (Math.abs(lateral) > wallLimit) {
      const excess = Math.abs(lateral) - wallLimit;
      const sign = Math.sign(lateral);
      state.position.addScaledVector(sample.left, -sign * excess);
      state.lateralSpeed *= -PLAYER_TUNING.wallBounce;
      state.speed *= 0.86;
      this.scrapeThisFrame = true;
      const tangentHeading = Math.atan2(sample.tangent.x, sample.tangent.z);
      // Real frame delta, not a fixed step — otherwise this is frame-rate dependent.
      state.heading = THREE.MathUtils.damp(state.heading, tangentHeading, 3.5, Math.max(delta, 1e-4));
    }

    return track.collectBoostPad(state.position, 1.4);
  }
}
