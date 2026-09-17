import * as THREE from 'three';
import type { Track } from '../game/Track';
import { Kart } from './Kart';
import { type KartTuning, PLAYER_TUNING } from './PlayerRacer';

type AIProfile = {
  color: string;
  accent: string;
  name: string;
  skill: number;
  laneOffset: number;
  maxSpeedScale: number;
};

const PROFILES: AIProfile[] = [
  { color: '#ff3cac', accent: '#ff9ad5', name: '绯红', skill: 0.9, laneOffset: -2.4, maxSpeedScale: 0.9 },
  { color: '#7cff6b', accent: '#d4ff9a', name: '翠影', skill: 0.86, laneOffset: 2.2, maxSpeedScale: 0.87 },
  { color: '#ffd166', accent: '#fff1b8', name: '金戈', skill: 0.84, laneOffset: 0.5, maxSpeedScale: 0.85 },
];

export class AIRacer {
  readonly kart: Kart;
  private readonly profile: AIProfile;
  private readonly tuning: KartTuning;
  private targetProgress = 0;
  private difficultyScale = 1;
  private readonly desiredPos = new THREE.Vector3();
  private readonly steerVec = new THREE.Vector3();

  setDifficultyScale(scale: number): void {
    this.difficultyScale = scale;
  }

  constructor(index: number) {
    this.profile = PROFILES[index % PROFILES.length];
    this.kart = new Kart({
      color: this.profile.color,
      accent: this.profile.accent,
      name: this.profile.name,
    });
    this.tuning = {
      ...PLAYER_TUNING,
      maxSpeed: PLAYER_TUNING.maxSpeed * this.profile.maxSpeedScale,
      boostSpeed: PLAYER_TUNING.boostSpeed * (this.profile.maxSpeedScale + 0.02),
      acceleration: PLAYER_TUNING.acceleration * 0.88,
      turnRate: PLAYER_TUNING.turnRate * 0.94,
    };
  }

  reset(track: Track, gridIndex: number): void {
    const startT = (0.002 * (gridIndex % 2) + 0) % 1;
    const sample = track.sampleAt(startT);
    const stagger = 0.9 + Math.floor(gridIndex / 2) * 2.4;
    const position = sample.position
      .clone()
      .addScaledVector(sample.left, this.profile.laneOffset)
      .addScaledVector(sample.tangent, -stagger);
    const heading = Math.atan2(sample.tangent.x, sample.tangent.z);
    this.kart.reset(position, heading);
    this.targetProgress = startT;
  }

  update(delta: number, track: Track, raceActive: boolean, playerProgress: number): void {
    const state = this.kart.state;
    if (state.finished) {
      state.speed = Math.max(0, state.speed - 10 * delta);
      state.position.addScaledVector(
        new THREE.Vector3(Math.sin(state.heading), 0, Math.cos(state.heading)),
        state.speed * delta,
      );
      this.kart.syncTransform(delta);
      return;
    }

    if (!raceActive) {
      state.speed = THREE.MathUtils.damp(state.speed, 0, 4, delta);
      this.kart.syncTransform(delta);
      return;
    }

    // Rubber-band stays gentle so AI never out-paces a skilled player.
    const gap = playerProgress - state.totalProgress;
    const rubber =
      THREE.MathUtils.clamp(1 + gap * 0.05, 0.93, 1.02) * this.difficultyScale;

    // Aim a bit ahead along the racing line
    const lookAhead = 0.022 + state.speed * 0.00045;
    this.targetProgress = (state.progress + lookAhead) % 1;
    const targetSample = track.sampleAt(this.targetProgress);
    const lateralWave = Math.sin(state.totalProgress * 18) * this.profile.laneOffset * 0.35;
    this.desiredPos
      .copy(targetSample.position)
      .addScaledVector(targetSample.left, this.profile.laneOffset + lateralWave);

    const toTarget = this.desiredPos.sub(state.position);
    const distance = toTarget.length();
    const targetHeading = Math.atan2(toTarget.x, toTarget.z);
    let headingDelta = targetHeading - state.heading;
    while (headingDelta > Math.PI) headingDelta -= Math.PI * 2;
    while (headingDelta < -Math.PI) headingDelta += Math.PI * 2;

    const steer = THREE.MathUtils.clamp(headingDelta * 1.8 * this.profile.skill, -1, 1);
    const throttle = 1;
    const brake = Math.abs(headingDelta) > 0.85 && state.speed > 18 ? 0.45 : 0;

    // Boost usage on straights when nitro is charged — less frequent than player
    const useNitro = state.nitro > 0.7 && targetSample.curvature < 0.06 && distance > 5;
    if (useNitro) {
      state.nitro = Math.max(0, state.nitro - 0.4 * delta);
      state.boostTimer = Math.max(state.boostTimer, 0.4);
    }

    // Soft drift-charge through corners
    if (Math.abs(headingDelta) > 0.35 && state.speed > 14) {
      state.isDrifting = true;
      state.driftAngle = THREE.MathUtils.damp(state.driftAngle, THREE.MathUtils.clamp(steer * 0.5, -0.6, 0.6), 4, delta);
      state.nitro = Math.min(1, state.nitro + 0.28 * delta);
    } else {
      state.isDrifting = false;
      state.driftAngle = THREE.MathUtils.damp(state.driftAngle, 0, 6, delta);
    }

    if (state.boostTimer > 0) {
      state.boostTimer = Math.max(0, state.boostTimer - delta);
      state.isBoosting = true;
    } else {
      state.isBoosting = false;
    }

    const maxSpeed = (state.isBoosting ? this.tuning.boostSpeed : this.tuning.maxSpeed) * rubber;
    if (brake > 0) state.speed -= this.tuning.brakePower * brake * delta;
    else state.speed += this.tuning.acceleration * throttle * delta * rubber;

    if (state.speed > maxSpeed) state.speed = THREE.MathUtils.damp(state.speed, maxSpeed, 2, delta);
    state.speed = Math.max(0, state.speed);

    const turnScale = THREE.MathUtils.clamp(1.1 - state.speed / 50, 0.4, 1.05);
    state.heading += steer * this.tuning.turnRate * turnScale * (state.isDrifting ? 1.3 : 1) * delta;

    const forward = this.steerVec.set(Math.sin(state.heading), 0, Math.cos(state.heading));
    state.velocity.copy(forward).multiplyScalar(state.speed);
    state.position.addScaledVector(state.velocity, delta);
    state.position.y = 0;

    // Track projection + walls
    state.progress = track.projectProgress(state.position, state.progress);
    const { lateral, sample } = track.lateralOffset(state.position, state.progress);
    state.offTrack = Math.abs(lateral) > track.halfWidth;
    if (Math.abs(lateral) > track.halfWidth + 0.7) {
      const excess = Math.abs(lateral) - (track.halfWidth + 0.7);
      state.position.addScaledVector(sample.left, -Math.sign(lateral) * excess);
      state.speed *= 0.9;
    }

    // Collect pads
    if (track.collectBoostPad(state.position, 1.2)) {
      state.boostTimer = Math.max(state.boostTimer, 0.9);
      state.isBoosting = true;
    }

    this.kart.syncTransform(delta);
  }
}
