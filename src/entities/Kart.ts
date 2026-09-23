import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
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

/** Radius of the soft additive pool painted on the road under a kart. */
const GROUND_GLOW_RADIUS = 1.9;
/** Peak opacity of that pool. Additive, so this reads brighter than it sounds. */
const GROUND_GLOW_OPACITY = 0.6;

let glowTextureCache: THREE.Texture | null = null;

/**
 * Radial white-to-transparent falloff, built once and shared by every kart.
 *
 * This replaces a per-kart PointLight. The light had to be toggled `visible`
 * with the drift state, and three.js drops invisible lights from the light list
 * — but the light counts are part of the material program cache key, so every
 * drift start/stop recompiled every lit material in the scene. Measured: the
 * visible light count oscillated 7 <-> 8 and the compiled program count grew
 * 60 -> 76 during a single drift. A MeshBasicMaterial decal is unlit, so it
 * neither joins the lighting loop nor touches the program key.
 */
function glowTexture(): THREE.Texture {
  if (glowTextureCache) return glowTextureCache;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const half = size / 2;
    const gradient = ctx.createRadialGradient(half, half, 0, half, half, half);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.5)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  // Additive blending multiplies by the map's alpha, so the falloff above is
  // what keeps the pool soft instead of a hard-edged disc.
  texture.colorSpace = THREE.SRGBColorSpace;
  glowTextureCache = texture;
  return texture;
}

/**
 * Parts are merged per material so one kart costs ~22 draw calls instead of ~55.
 * The local transforms below mirror the original per-mesh placement exactly, so
 * the merged silhouette is identical to the hand-placed version.
 */
type PlacedPart = {
  geo: THREE.BufferGeometry;
  pos?: [number, number, number];
  rot?: [number, number, number];
};

function mergeParts(parts: PlacedPart[]): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const euler = new THREE.Euler();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3(1, 1, 1);

  const prepared = parts.map((part) => {
    const geometry = part.geo;
    euler.set(part.rot?.[0] ?? 0, part.rot?.[1] ?? 0, part.rot?.[2] ?? 0);
    quaternion.setFromEuler(euler);
    position.set(part.pos?.[0] ?? 0, part.pos?.[1] ?? 0, part.pos?.[2] ?? 0);
    matrix.compose(position, quaternion, scale);
    geometry.applyMatrix4(matrix);
    return geometry;
  });

  const merged = mergeGeometries(prepared, false);
  for (const geometry of prepared) geometry.dispose();
  return merged ?? new THREE.BufferGeometry();
}

type BodyGeometries = {
  paint: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
  carbon: THREE.BufferGeometry;
  dark: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  tailStrip: THREE.BufferGeometry;
  headlights: THREE.BufferGeometry;
  tailLamps: THREE.BufferGeometry;
};

type WheelGeometries = {
  tire: THREE.BufferGeometry;
  rim: THREE.BufferGeometry;
  hub: THREE.BufferGeometry;
};

type KartGeometries = {
  body: BodyGeometries;
  /** Index 0 = front axle (slightly smaller), index 1 = rear axle. */
  wheels: [WheelGeometries, WheelGeometries];
  flame: THREE.BufferGeometry;
  /** Two triangles lying flat — the additive pool under the kart. */
  groundGlow: THREE.BufferGeometry;
};

let geometryCache: KartGeometries | null = null;

function buildBodyGeometries(): BodyGeometries {
  return {
    paint: mergeParts([
      { geo: new THREE.BoxGeometry(BODY_WIDTH, 0.28, BODY_LENGTH), pos: [0, 0.42, 0] },
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.9, 0.22, BODY_LENGTH * 0.62),
        pos: [0, 0.62, -0.08],
      },
    ]),
    accent: mergeParts([
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.78, 0.14, 0.58),
        pos: [0, 0.38, BODY_LENGTH * 0.55],
        rot: [-0.1, 0, 0],
      },
      {
        geo: new THREE.BoxGeometry(0.06, 0.05, BODY_LENGTH * 0.5),
        pos: [-BODY_WIDTH * 0.48 - 0.1, 0.42, -0.1],
      },
      {
        geo: new THREE.BoxGeometry(0.06, 0.05, BODY_LENGTH * 0.5),
        pos: [BODY_WIDTH * 0.48 + 0.1, 0.42, -0.1],
      },
      {
        geo: new THREE.TorusGeometry(0.42, 0.04, 8, 20, Math.PI),
        pos: [0, 0.92, 0.05],
        rot: [-Math.PI / 2, 0, 0],
      },
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 1.15, 0.06, 0.32),
        pos: [0, 1.0, -BODY_LENGTH * 0.46],
      },
    ]),
    carbon: mergeParts([
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 1.05, 0.06, 0.5),
        pos: [0, 0.22, BODY_LENGTH * 0.48],
      },
      {
        geo: new THREE.BoxGeometry(0.22, 0.2, BODY_LENGTH * 0.55),
        pos: [-BODY_WIDTH * 0.48, 0.32, -0.1],
      },
      {
        geo: new THREE.BoxGeometry(0.22, 0.2, BODY_LENGTH * 0.55),
        pos: [BODY_WIDTH * 0.48, 0.32, -0.1],
      },
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.95, 0.16, 0.35),
        pos: [0, 0.28, -BODY_LENGTH * 0.48],
      },
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.9, 0.05, 0.2),
        pos: [0, 0.72, -BODY_LENGTH * 0.5],
      },
      { geo: new THREE.BoxGeometry(0.06, 0.34, 0.08), pos: [-0.45, 0.82, -BODY_LENGTH * 0.46] },
      { geo: new THREE.BoxGeometry(0.06, 0.34, 0.08), pos: [0.45, 0.82, -BODY_LENGTH * 0.46] },
    ]),
    dark: mergeParts([{ geo: new THREE.BoxGeometry(0.72, 0.26, 0.85), pos: [0, 0.8, 0.05] }]),
    glass: mergeParts([{ geo: new THREE.BoxGeometry(0.58, 0.1, 0.4), pos: [0, 0.95, 0.3] }]),
    tailStrip: mergeParts([
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.85, 0.04, 0.05),
        pos: [0, 0.5, -BODY_LENGTH * 0.52],
      },
    ]),
    headlights: mergeParts([
      { geo: new THREE.BoxGeometry(0.22, 0.07, 0.06), pos: [-0.28, 0.42, BODY_LENGTH * 0.7] },
      { geo: new THREE.BoxGeometry(0.22, 0.07, 0.06), pos: [0.28, 0.42, BODY_LENGTH * 0.7] },
    ]),
    tailLamps: mergeParts([
      { geo: new THREE.BoxGeometry(0.16, 0.05, 0.04), pos: [-0.36, 0.48, -BODY_LENGTH * 0.5] },
      { geo: new THREE.BoxGeometry(0.16, 0.05, 0.04), pos: [0.36, 0.48, -BODY_LENGTH * 0.5] },
    ]),
  };
}

function buildWheelGeometries(radius: number): WheelGeometries {
  const tirePoints = [
    new THREE.Vector2(0.01, -0.11),
    new THREE.Vector2(radius * 0.55, -0.12),
    new THREE.Vector2(radius * 0.95, -0.09),
    new THREE.Vector2(radius, 0),
    new THREE.Vector2(radius * 0.95, 0.09),
    new THREE.Vector2(radius * 0.55, 0.12),
    new THREE.Vector2(0.01, 0.11),
  ];

  // Rim disc plus the five spokes collapse into one mesh sharing the rim material.
  const rimParts: PlacedPart[] = [
    {
      geo: new THREE.CylinderGeometry(radius * 0.58, radius * 0.58, 0.2, 16),
      rot: [0, 0, Math.PI / 2],
    },
  ];
  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2;
    rimParts.push({
      geo: new THREE.BoxGeometry(0.06, radius * 0.9, 0.08),
      pos: [0, 0, 0.1],
      rot: [angle, 0, 0],
    });
  }

  return {
    tire: new THREE.LatheGeometry(tirePoints, 20),
    rim: mergeParts(rimParts),
    hub: mergeParts([
      {
        geo: new THREE.CylinderGeometry(radius * 0.2, radius * 0.2, 0.26, 12),
        rot: [0, 0, Math.PI / 2],
      },
    ]),
  };
}

/** Shared by every kart — built once, never disposed per instance. */
function kartGeometries(): KartGeometries {
  if (geometryCache) return geometryCache;
  geometryCache = {
    body: buildBodyGeometries(),
    wheels: [buildWheelGeometries(WHEEL_RADIUS * 0.96), buildWheelGeometries(WHEEL_RADIUS)],
    flame: new THREE.ConeGeometry(0.2, 1.5, 12),
    groundGlow: new THREE.PlaneGeometry(GROUND_GLOW_RADIUS * 2, GROUND_GLOW_RADIUS * 2),
  };
  return geometryCache;
}

type WheelMaterials = {
  tire: THREE.MeshStandardMaterial;
  rim: THREE.MeshStandardMaterial;
  hub: THREE.MeshStandardMaterial;
};

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
  private readonly groundGlow: THREE.Mesh;
  private readonly groundGlowMaterial: THREE.MeshBasicMaterial;
  private readonly materials: THREE.Material[] = [];
  private readonly name: string;
  /** Accumulated simulation time for the flame flicker. Using the wall clock
   *  here meant the exhaust kept flickering under "reduce motion", and made the
   *  flame depend on how fast the machine happened to be rendering. */
  private flamePhase = 0;
  private reducedMotion = false;

  /** The exhaust flicker is decoration; freeze it when motion is reduced. */
  setReducedMotion(reduced: boolean): void {
    this.reducedMotion = reduced;
  }

  constructor(private readonly config: KartConfig) {
    this.name = config.name;
    const geometries = kartGeometries();
    this.body = this.createBody(geometries.body);
    this.group.add(this.body);

    const wheelMaterials: WheelMaterials = {
      tire: this.track(
        new THREE.MeshStandardMaterial({ color: '#0b0d12', roughness: 0.92, metalness: 0.08 }),
      ),
      rim: this.track(
        new THREE.MeshStandardMaterial({ color: '#c8d4e8', roughness: 0.22, metalness: 0.88 }),
      ),
      hub: this.track(
        new THREE.MeshStandardMaterial({
          color: this.config.accent,
          emissive: this.config.accent,
          emissiveIntensity: 0.35,
          roughness: 0.3,
          metalness: 0.6,
        }),
      ),
    };

    const wheelSlots: Array<[number, number, boolean]> = [
      [-0.62, 0.78, true],
      [0.62, 0.78, true],
      [-0.66, -0.68, false],
      [0.66, -0.68, false],
    ];
    for (const [x, z, front] of wheelSlots) {
      const wheel = this.createWheel(front ? 0 : 1, wheelMaterials);
      wheel.position.set(x, WHEEL_RADIUS, z);
      this.wheels.push(wheel);
      this.group.add(wheel);
    }

    const flameMaterial = this.track(
      new THREE.MeshBasicMaterial({
        color: '#a8f4ff',
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    for (const x of [-0.22, 0.22]) {
      const flame = new THREE.Mesh(geometries.flame, flameMaterial);
      flame.rotation.x = Math.PI / 2;
      flame.position.set(x, 0.38, -BODY_LENGTH * 0.62);
      this.boostFlames.push(flame);
      this.group.add(flame);
    }

    this.groundGlowMaterial = this.track(
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: this.config.accent,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.groundGlow = new THREE.Mesh(geometries.groundGlow, this.groundGlowMaterial);
    this.groundGlow.rotation.x = -Math.PI / 2;
    // Just clear of the road surface, which sits at y = 0.
    this.groundGlow.position.y = 0.04;
    this.groundGlow.visible = false;
    this.group.add(this.groundGlow);
  }

  get displayName(): string {
    return this.name;
  }

  /**
   * Ground-glow opacity. 0 when idle, raised while drifting or boosting — the
   * only externally visible part of the effect, and what the tests assert on.
   */
  get glowOpacity(): number {
    return this.groundGlowMaterial.opacity;
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
    this.flamePhase += this.reducedMotion ? 0 : delta;
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
    const flicker = 0.85 + Math.sin(this.flamePhase * 40) * 0.15;
    for (const flame of this.boostFlames) {
      const mat = flame.material as THREE.MeshBasicMaterial;
      mat.opacity = THREE.MathUtils.lerp(mat.opacity, boostStrength * 1, Math.min(1, delta * 16));
      flame.scale.set(
        1.1 + boostStrength * 0.7,
        0.9 + boostStrength * 1.3 * flicker,
        1.1 + boostStrength * 0.7,
      );
    }

    // Same intensity curve the PointLight used, expressed as decal opacity.
    // Toggling a mesh's `visible` is free — unlike a light, a mesh is not part
    // of the material program cache key, so this cannot trigger a recompile.
    const glowTarget = this.state.isDrifting
      ? 1.2 + Math.abs(this.state.driftAngle) * 0.8
      : boostStrength * 1.2;
    const glowStrength = Math.min(glowTarget / 2, 1);
    const material = this.groundGlowMaterial;
    material.opacity = THREE.MathUtils.lerp(
      material.opacity,
      glowStrength * GROUND_GLOW_OPACITY,
      Math.min(1, delta * 10),
    );
    this.groundGlow.visible = material.opacity > 0.01;
    if (this.groundGlow.visible) {
      this.groundGlow.scale.setScalar(0.85 + glowStrength * 0.3);
    }
  }

  /**
   * Releases per-instance materials only. Geometries and the glow falloff
   * texture are shared for the lifetime of the page, like `geometryCache`.
   */
  dispose(): void {
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
  }

  private track<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }

  private createBody(geometries: BodyGeometries): THREE.Group {
    const group = new THREE.Group();
    const livery = loadGameTexture(this.config.livery ?? '/assets/kart-livery.webp', {
      repeat: [1, 1],
    });

    const paint = this.track(
      new THREE.MeshPhysicalMaterial({
        color: this.config.color,
        map: livery,
        roughness: 0.2,
        metalness: 0.55,
        clearcoat: 1,
        clearcoatRoughness: 0.1,
      }),
    );
    const accentMat = this.track(
      new THREE.MeshStandardMaterial({
        color: this.config.accent,
        emissive: this.config.accent,
        emissiveIntensity: 0.22,
        roughness: 0.3,
        metalness: 0.55,
      }),
    );
    const darkMat = this.track(
      new THREE.MeshStandardMaterial({ color: '#0a0e16', roughness: 0.22, metalness: 0.75 }),
    );
    const carbon = this.track(
      new THREE.MeshStandardMaterial({
        color: '#151a24',
        roughness: 0.4,
        metalness: 0.5,
        map: loadGameTexture(this.config.livery ?? '/assets/kart-livery.webp', {
          repeat: [0.5, 0.5],
        }),
      }),
    );
    const glassMat = this.track(
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
    const stripMat = this.track(
      new THREE.MeshStandardMaterial({
        color: '#8a1840',
        emissive: '#ff2a6d',
        emissiveIntensity: 0.7,
        roughness: 0.4,
      }),
    );
    const lampMat = this.track(new THREE.MeshBasicMaterial({ color: '#eefcff' }));
    const tailMat = this.track(new THREE.MeshBasicMaterial({ color: '#ff2a6d' }));

    const shell = new THREE.Mesh(geometries.paint, paint);
    shell.castShadow = true;
    group.add(shell);

    const trim = new THREE.Mesh(geometries.accent, accentMat);
    trim.castShadow = true;
    group.add(trim);

    group.add(new THREE.Mesh(geometries.carbon, carbon));
    group.add(new THREE.Mesh(geometries.dark, darkMat));
    group.add(new THREE.Mesh(geometries.glass, glassMat));
    group.add(new THREE.Mesh(geometries.tailStrip, stripMat));
    group.add(new THREE.Mesh(geometries.headlights, lampMat));
    group.add(new THREE.Mesh(geometries.tailLamps, tailMat));

    return group;
  }

  private createWheel(axle: 0 | 1, materials: WheelMaterials): THREE.Mesh {
    const geometries = kartGeometries().wheels[axle];
    const wheel = new THREE.Mesh(geometries.tire, materials.tire);
    wheel.rotation.z = Math.PI / 2;
    wheel.castShadow = true;
    wheel.add(new THREE.Mesh(geometries.rim, materials.rim));
    wheel.add(new THREE.Mesh(geometries.hub, materials.hub));
    return wheel;
  }
}
