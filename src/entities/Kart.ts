import * as THREE from 'three';
import { loadGameTexture } from '../assets/textures';

export type KartConfig = {
  color: THREE.ColorRepresentation;
  accent: THREE.ColorRepresentation;
  name: string;
  livery?: string;
};

export type KartState = {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  heading: number;
  speed: number;
  lateralSpeed: number;
  driftAngle: number;
  isDrifting: boolean;
  isBoosting: boolean;
  nitro: number;
  boostTimer: number;
  offTrack: boolean;
  progress: number;
  totalProgress: number;
  lap: number;
  finished: boolean;
  finishTime: number;
};

const WHEEL_RADIUS = 0.3;
const BODY_LENGTH = 2.35;
const BODY_WIDTH = 1.2;

export class Kart {
  readonly group = new THREE.Group();
  readonly state: KartState = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    heading: 0,
    speed: 0,
    lateralSpeed: 0,
    driftAngle: 0,
    isDrifting: false,
    isBoosting: false,
    nitro: 0,
    boostTimer: 0,
    offTrack: false,
    progress: 0,
    totalProgress: 0,
    lap: 0,
    finished: false,
    finishTime: 0,
  };

  private readonly body: THREE.Group;
  private readonly wheels: THREE.Mesh[] = [];
  private readonly boostFlames: THREE.Mesh[] = [];
  private readonly driftGlow: THREE.PointLight;
  private readonly name: string;

  constructor(private readonly config: KartConfig) {
    this.name = config.name;
    this.body = this.createBody();
    this.group.add(this.body);

    for (const [x, z, front] of [
      [-0.62, 0.78, true],
      [0.62, 0.78, true],
      [-0.66, -0.68, false],
      [0.66, -0.68, false],
    ] as Array<[number, number, boolean]>) {
      const wheel = this.createWheel(front);
      wheel.position.set(x, WHEEL_RADIUS, z);
      this.wheels.push(wheel);
      this.group.add(wheel);
    }

    for (const x of [-0.22, 0.22]) {
      const flame = new THREE.Mesh(
        new THREE.ConeGeometry(0.2, 1.5, 12),
        new THREE.MeshBasicMaterial({
          color: '#a8f4ff',
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      flame.rotation.x = Math.PI / 2;
      flame.position.set(x, 0.38, -BODY_LENGTH * 0.62);
      this.boostFlames.push(flame);
      this.group.add(flame);
    }

    this.driftGlow = new THREE.PointLight(this.config.accent, 0, 5);
    this.driftGlow.position.set(0, 0.5, 0);
    this.driftGlow.visible = false;
    this.group.add(this.driftGlow);
  }

  get displayName(): string {
    return this.name;
  }

  reset(position: THREE.Vector3, heading: number): void {
    this.state.position.copy(position);
    this.state.position.y = 0;
    this.state.velocity.set(0, 0, 0);
    this.state.heading = heading;
    this.state.speed = 0;
    this.state.lateralSpeed = 0;
    this.state.driftAngle = 0;
    this.state.isDrifting = false;
    this.state.isBoosting = false;
    this.state.nitro = 0;
    this.state.boostTimer = 0;
    this.state.offTrack = false;
    this.state.progress = 0;
    this.state.totalProgress = 0;
    this.state.lap = 0;
    this.state.finished = false;
    this.state.finishTime = 0;
    this.syncTransform(0);
  }

  syncTransform(delta: number): void {
    this.group.position.copy(this.state.position);
    this.group.position.y = 0;
    this.group.rotation.y = this.state.heading + this.state.driftAngle;

    const spin = this.state.speed * delta * 4.2;
    for (let i = 0; i < this.wheels.length; i += 1) {
      const wheel = this.wheels[i];
      wheel.rotation.x -= spin;
      if (i < 2) {
        wheel.rotation.y = this.state.driftAngle * 0.4;
      }
    }

    const boostStrength = this.state.isBoosting ? 1 : 0;
    const flicker = 0.85 + Math.sin(performance.now() * 0.04) * 0.15;
    for (const flame of this.boostFlames) {
      const mat = flame.material as THREE.MeshBasicMaterial;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, boostStrength * 1, Math.min(1, delta * 16));
      flame.scale.set(
        1.1 + boostStrength * 0.7,
        0.9 + boostStrength * 1.3 * flicker,
        1.1 + boostStrength * 0.7,
      );
    }

    const glowTarget = this.state.isDrifting
      ? 1.2 + Math.abs(this.state.driftAngle) * 0.8
      : boostStrength * 1.2;
    this.driftGlow.visible = glowTarget > 0.05;
    this.driftGlow.intensity = THREE.MathUtils.lerp(this.driftGlow.intensity, glowTarget, Math.min(1, delta * 10));
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mat = obj.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat.dispose();
      }
    });
  }

  private createBody(): THREE.Group {
    const group = new THREE.Group();
    const livery = loadGameTexture(this.config.livery ?? '/assets/kart-livery.png', { repeat: [1, 1] });
    const paint = new THREE.MeshPhysicalMaterial({
      color: this.config.color,
      map: livery,
      roughness: 0.2,
      metalness: 0.55,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
    });
    const accentMat = new THREE.MeshStandardMaterial({
      color: this.config.accent,
      emissive: this.config.accent,
      emissiveIntensity: 0.22,
      roughness: 0.3,
      metalness: 0.55,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: '#0a0e16',
      roughness: 0.22,
      metalness: 0.75,
    });
    const carbon = new THREE.MeshStandardMaterial({
      color: '#151a24',
      roughness: 0.4,
      metalness: 0.5,
      map: loadGameTexture(this.config.livery ?? '/assets/kart-livery.png', { repeat: [0.5, 0.5] }),
    });

    // Low wide chassis
    const shell = new THREE.Mesh(new THREE.BoxGeometry(BODY_WIDTH, 0.28, BODY_LENGTH), paint);
    shell.position.y = 0.42;
    shell.castShadow = true;
    group.add(shell);

    // Upper body taper
    const mid = new THREE.Mesh(new THREE.BoxGeometry(BODY_WIDTH * 0.9, 0.22, BODY_LENGTH * 0.62), paint);
    mid.position.set(0, 0.62, -0.08);
    mid.castShadow = true;
    group.add(mid);

    // Front splitter
    const splitter = new THREE.Mesh(new THREE.BoxGeometry(BODY_WIDTH * 1.05, 0.06, 0.5), carbon);
    splitter.position.set(0, 0.22, BODY_LENGTH * 0.48);
    group.add(splitter);

    // Nose
    const nose = new THREE.Mesh(new THREE.BoxGeometry(BODY_WIDTH * 0.78, 0.14, 0.58), accentMat);
    nose.position.set(0, 0.38, BODY_LENGTH * 0.55);
    nose.rotation.x = -0.1;
    nose.castShadow = true;
    group.add(nose);

    // Side pods
    for (const x of [-BODY_WIDTH * 0.48, BODY_WIDTH * 0.48]) {
      const pod = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.2, BODY_LENGTH * 0.55), carbon);
      pod.position.set(x, 0.32, -0.1);
      group.add(pod);
      const accent = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.05, BODY_LENGTH * 0.5), accentMat);
      accent.position.set(x + Math.sign(x) * 0.1, 0.42, -0.1);
      group.add(accent);
    }

    // Cockpit tub
    const cockpit = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.26, 0.85), darkMat);
    cockpit.position.set(0, 0.8, 0.05);
    group.add(cockpit);

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(0.58, 0.1, 0.4),
      new THREE.MeshPhysicalMaterial({
        color: '#8ad4ff',
        roughness: 0.04,
        metalness: 0.15,
        transmission: 0.65,
        transparent: true,
        opacity: 0.9,
        thickness: 0.2,
      }),
    );
    glass.position.set(0, 0.95, 0.3);
    group.add(glass);

    // Halo / canopy rim
    const halo = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.04, 8, 20, Math.PI), accentMat);
    halo.position.set(0, 0.92, 0.05);
    halo.rotation.x = -Math.PI / 2;
    group.add(halo);

    // Rear diffuser
    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(BODY_WIDTH * 0.95, 0.16, 0.35), carbon);
    diffuser.position.set(0, 0.28, -BODY_LENGTH * 0.48);
    group.add(diffuser);

    // Rear wing
    const wing = new THREE.Mesh(new THREE.BoxGeometry(BODY_WIDTH * 1.15, 0.06, 0.32), accentMat);
    wing.position.set(0, 1.0, -BODY_LENGTH * 0.46);
    wing.castShadow = true;
    group.add(wing);

    const wingLow = new THREE.Mesh(new THREE.BoxGeometry(BODY_WIDTH * 0.9, 0.05, 0.2), carbon);
    wingLow.position.set(0, 0.72, -BODY_LENGTH * 0.5);
    group.add(wingLow);

    for (const x of [-0.45, 0.45]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.08), carbon);
      post.position.set(x, 0.82, -BODY_LENGTH * 0.46);
      group.add(post);
    }

    // Tail light bar
    const strip = new THREE.Mesh(
      new THREE.BoxGeometry(BODY_WIDTH * 0.85, 0.04, 0.05),
      new THREE.MeshStandardMaterial({
        color: '#8a1840',
        emissive: '#ff2a6d',
        emissiveIntensity: 0.7,
        roughness: 0.4,
      }),
    );
    strip.position.set(0, 0.5, -BODY_LENGTH * 0.52);
    group.add(strip);

    // Headlights
    for (const x of [-0.28, 0.28]) {
      const lamp = new THREE.Mesh(
        new THREE.BoxGeometry(0.22, 0.07, 0.06),
        new THREE.MeshBasicMaterial({ color: '#eefcff' }),
      );
      lamp.position.set(x, 0.42, BODY_LENGTH * 0.7);
      group.add(lamp);
    }

    // Tail lamps
    for (const x of [-0.36, 0.36]) {
      const tail = new THREE.Mesh(
        new THREE.BoxGeometry(0.16, 0.05, 0.04),
        new THREE.MeshBasicMaterial({ color: '#ff2a6d' }),
      );
      tail.position.set(x, 0.48, -BODY_LENGTH * 0.5);
      group.add(tail);
    }

    return group;
  }

  private createWheel(front: boolean): THREE.Mesh {
    const radius = front ? WHEEL_RADIUS * 0.96 : WHEEL_RADIUS;
    // Tire with sidewall profile
    const tirePoints = [
      new THREE.Vector2(0.01, -0.11),
      new THREE.Vector2(radius * 0.55, -0.12),
      new THREE.Vector2(radius * 0.95, -0.09),
      new THREE.Vector2(radius, 0),
      new THREE.Vector2(radius * 0.95, 0.09),
      new THREE.Vector2(radius * 0.55, 0.12),
      new THREE.Vector2(0.01, 0.11),
    ];
    const wheel = new THREE.Mesh(
      new THREE.LatheGeometry(tirePoints, 20),
      new THREE.MeshStandardMaterial({
        color: '#0b0d12',
        roughness: 0.92,
        metalness: 0.08,
      }),
    );
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;

    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, 0.2, 16),
      new THREE.MeshStandardMaterial({
        color: '#c8d4e8',
        roughness: 0.22,
        metalness: 0.88,
      }),
    );
    rim.rotation.z = Math.PI / 2;
    wheel.add(rim);

    // Spoke details
    for (let i = 0; i < 5; i += 1) {
      const a = (i / 5) * Math.PI * 2;
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(0.06, radius * 0.9, 0.08),
        new THREE.MeshStandardMaterial({ color: '#8a96aa', roughness: 0.3, metalness: 0.7 }),
      );
      spoke.position.set(0, 0, 0.1);
      spoke.rotation.x = a;
      wheel.add(spoke);
    }

    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, 0.26, 12),
      new THREE.MeshStandardMaterial({
        color: this.config.accent,
        emissive: this.config.accent,
        emissiveIntensity: 0.35,
        roughness: 0.3,
        metalness: 0.6,
      }),
    );
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    return wheel;
  }
}
