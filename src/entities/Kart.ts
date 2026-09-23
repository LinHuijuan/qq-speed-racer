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
  /** Bright emissive bar along the hood centerline. Sits on its own material
   *  because the accent trim's emissiveIntensity (0.22) is too soft to read
   *  as an LED, and bumping the accent up would also brighten the splitter,
   *  skirts and wing beyond what bloom can carry. */
  ledStrip: THREE.BufferGeometry;
  /** Thin emissive strip along each side skirt — always on, gives an idle glow
   *  even when the ground decal (drift/boost only) is hidden. */
  underbodyGlow: THREE.BufferGeometry;
  /** Additive halo quads in front of the headlights. Unlit, so they neither
   *  join the lighting loop nor bloat the shader cache; their job is purely to
   *  feed the bloom pass a soft white pool. */
  headlightHalo: THREE.BufferGeometry;
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
  // The old version of this function used 8 box primitives per kart and read
  // as a Lego: a square black cabin, a thin glass slab, a half-torus roll hoop
  // floating above the body, two wing struts that didn't reach the wing, and a
  // nose that ended in a blunt 90° face. The shape now follows a few F1-kart
  // cues: a tapered nose tip, a windshield-tilted canopy, a low-profile roll
  // hoop behind the cockpit, a real airfoil tilted at -0.18 rad, a three-fin
  // rear diffuser, side air intakes with a darker inset, and a single LED strip
  // running along the hood centerline. Brighter idle lighting comes from a thin
  // accent strip on each side skirt; the headlights get a soft additive halo
  // so the bloom pass picks them up instead of just two white pixels.
  return {
    paint: mergeParts([
      // Lower chassis pan — the slab everything else sits on.
      { geo: new THREE.BoxGeometry(BODY_WIDTH, 0.28, BODY_LENGTH), pos: [0, 0.42, 0] },
      // Upper hull — narrower and shorter than the pan, set slightly forward.
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.9, 0.22, BODY_LENGTH * 0.62),
        pos: [0, 0.62, -0.08],
      },
      // Tapered nose tip — shorter than the upper hull and lower, so the
      // silhouette drops cleanly to the splitter instead of hitting a 90° face.
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.62, 0.16, 0.55),
        pos: [0, 0.36, BODY_LENGTH * 0.6],
      },
      // Fender flares — a half-torus arch standing over each wheel. This is
      // the single biggest silhouette change in the pass: without them the
      // body was a bare slab with four wheels poking out of the sides, which
      // is what made it read as a toy. TorusGeometry lies in the XY plane by
      // default, so the arc runs +X → -X over +Y; rotating +90° about Y maps
      // that to +Z → -Z over +Y, i.e. an arch spanning the wheel fore-to-aft.
      // Radius 0.42 / tube 0.06 clears the 0.30 wheel by 0.06 — at 0.46/0.075
      // the arches floated 0.17 above the tyre and read as loose tubing.
      {
        geo: new THREE.TorusGeometry(0.42, 0.06, 8, 18, Math.PI),
        pos: [-0.62, 0.28, 0.78],
        rot: [0, Math.PI / 2, 0],
      },
      {
        geo: new THREE.TorusGeometry(0.42, 0.06, 8, 18, Math.PI),
        pos: [0.62, 0.28, 0.78],
        rot: [0, Math.PI / 2, 0],
      },
      {
        geo: new THREE.TorusGeometry(0.42, 0.06, 8, 18, Math.PI),
        pos: [-0.66, 0.28, -0.68],
        rot: [0, Math.PI / 2, 0],
      },
      {
        geo: new THREE.TorusGeometry(0.42, 0.06, 8, 18, Math.PI),
        pos: [0.66, 0.28, -0.68],
        rot: [0, Math.PI / 2, 0],
      },
    ]),
    accent: mergeParts([
      // Splitter lip — the front splitter itself is carbon now (see below);
      // only this 3cm leading-edge strip stays accent, which is what makes it
      // read as a lit edge rather than a glowing wedge. The old accent
      // splitter was a 0.78×0.14×0.58 slab facing up at -0.1 rad, so it caught
      // the key light *and* carried 0.22 emissive — under bloom it blew out to
      // a flat white wedge in every front shot.
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 1.0, 0.03, 0.07),
        pos: [0, 0.21, BODY_LENGTH * 0.5 + 0.29],
        rot: [-0.08, 0, 0],
      },
      // Side skirts (kept — these are the slim accent bars down each flank).
      {
        geo: new THREE.BoxGeometry(0.06, 0.05, BODY_LENGTH * 0.5),
        pos: [-BODY_WIDTH * 0.48 - 0.1, 0.42, -0.1],
      },
      {
        geo: new THREE.BoxGeometry(0.06, 0.05, BODY_LENGTH * 0.5),
        pos: [BODY_WIDTH * 0.48 + 0.1, 0.42, -0.1],
      },
      // (Hood LED strip moved to its own geometry/material so it can have a
      //  higher emissive intensity without dragging the splitter, skirts, and
      //  wing up with it.)
      // Rear wing — was a flat slab, now a tilted airfoil. Endplates sit just
      // outside the wing tips and read as the wing's vertical seals.
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 1.18, 0.05, 0.34),
        pos: [0, 1.04, -BODY_LENGTH * 0.46],
        rot: [-0.18, 0, 0],
      },
      {
        geo: new THREE.BoxGeometry(0.05, 0.18, 0.32),
        pos: [-BODY_WIDTH * 0.58, 1.04, -BODY_LENGTH * 0.46],
      },
      {
        geo: new THREE.BoxGeometry(0.05, 0.18, 0.32),
        pos: [BODY_WIDTH * 0.58, 1.04, -BODY_LENGTH * 0.46],
      },
      // Roll hoop. The original was a 0.42-radius π-torus rotated
      // `[-π/2, 0, 0]`, which lays the ring FLAT — so it was a horizontal
      // half-ring hovering over the body, and it read as a carry handle, not a
      // roll bar. A hoop has to stand up: no X rotation, so the arc runs
      // +X → -X over +Y, straddling the cockpit. Radius 0.32 spans 0.64,
      // just wider than the 0.56 canopy, and the 0.8 base height puts the
      // crown at 1.12 — 0.13 above the canopy.
      {
        geo: new THREE.TorusGeometry(0.32, 0.032, 8, 20, Math.PI),
        pos: [0, 0.8, -0.42],
      },
    ]),
    carbon: mergeParts([
      // Front splitter — the main plate. Moved here from the accent group: a
      // dark splitter with a thin lit lip (above) looks like real aero, where
      // an all-accent splitter looked like a glowing plank.
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 1.05, 0.07, 0.6),
        pos: [0, 0.24, BODY_LENGTH * 0.5],
        rot: [-0.08, 0, 0],
      },
      // Lower side skirts — keep these as the dark base under the accent bars.
      {
        geo: new THREE.BoxGeometry(0.22, 0.2, BODY_LENGTH * 0.55),
        pos: [-BODY_WIDTH * 0.48, 0.32, -0.1],
      },
      {
        geo: new THREE.BoxGeometry(0.22, 0.2, BODY_LENGTH * 0.55),
        pos: [BODY_WIDTH * 0.48, 0.32, -0.1],
      },
      // Rear deck — wider carbon panel behind the cockpit (kept).
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.95, 0.16, 0.35),
        pos: [0, 0.28, -BODY_LENGTH * 0.48],
      },
      // Engine cover — thin panel under the rear wing (kept).
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.9, 0.05, 0.2),
        pos: [0, 0.72, -BODY_LENGTH * 0.5],
      },
      // Rear diffuser — three vertical fins below the rear deck. The center
      // fin is wider; the outer two step back slightly so the silhouette
      // tapers like a real diffuser rather than a flat wall.
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.92, 0.14, 0.018),
        pos: [0, 0.18, -BODY_LENGTH * 0.5],
      },
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.7, 0.12, 0.015),
        pos: [-BODY_WIDTH * 0.18, 0.2, -BODY_LENGTH * 0.535],
      },
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.7, 0.12, 0.015),
        pos: [BODY_WIDTH * 0.18, 0.2, -BODY_LENGTH * 0.535],
      },
    ]),
    dark: mergeParts([
      // Cockpit shell — flatter than the old 0.26-tall block so the canopy
      // can sit on top of it without overlapping.
      { geo: new THREE.BoxGeometry(0.72, 0.16, 0.85), pos: [0, 0.74, 0.05] },
      // Driver helmet hint — a low-poly sphere inside the canopy. At 0.10
      // radius it reads as a head shape without modelling a face.
      { geo: new THREE.SphereGeometry(0.1, 14, 10), pos: [0, 0.86, 0.14] },
      // Side air intakes — slim carbon-look boxes hugging the cockpit. The
      // inset face is the same material so they show as a notch, not a slot.
      { geo: new THREE.BoxGeometry(0.04, 0.16, 0.5), pos: [-BODY_WIDTH * 0.42, 0.62, 0.05] },
      { geo: new THREE.BoxGeometry(0.04, 0.16, 0.5), pos: [BODY_WIDTH * 0.42, 0.62, 0.05] },
    ]),
    glass: mergeParts([
      // The old canopy was a 0.58×0.1×0.4 slab that read as a thin lid. This
      // one is tilted forward 0.12 rad so the front face acts as a windshield.
      // Trimmed from 0.6×0.24×0.86 to 0.56×0.2×0.8 — at the larger size it
      // looked like a glass brick parked on the hull rather than a cockpit.
      {
        geo: new THREE.BoxGeometry(0.56, 0.2, 0.8),
        pos: [0, 0.89, 0.0],
        rot: [-0.12, 0, 0],
      },
    ]),
    tailStrip: mergeParts([
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.85, 0.04, 0.05),
        pos: [0, 0.5, -BODY_LENGTH * 0.52],
      },
    ]),
    ledStrip: mergeParts([
      // Hood centerline LED — 6cm wide and 2cm tall, emissive at 1.2 with the
      // livery accent. Sits flush with the top of the upper hull.
      {
        geo: new THREE.BoxGeometry(0.06, 0.02, BODY_LENGTH * 0.42),
        pos: [0, 0.74, 0.05],
      },
    ]),
    headlights: mergeParts([
      // Pulled forward onto the nose tip so they sit on the wedge face, not
      // behind it.
      { geo: new THREE.BoxGeometry(0.16, 0.05, 0.05), pos: [-0.24, 0.4, BODY_LENGTH * 0.65] },
      { geo: new THREE.BoxGeometry(0.16, 0.05, 0.05), pos: [0.24, 0.4, BODY_LENGTH * 0.65] },
    ]),
    tailLamps: mergeParts([
      { geo: new THREE.BoxGeometry(0.16, 0.05, 0.04), pos: [-0.36, 0.48, -BODY_LENGTH * 0.5] },
      { geo: new THREE.BoxGeometry(0.16, 0.05, 0.04), pos: [0.36, 0.48, -BODY_LENGTH * 0.5] },
    ]),
    underbodyGlow: mergeParts([
      // Two slim emissive strips below the body line. They are always on (not
      // drift/boost gated) so the kart has a permanent soft accent at idle.
      {
        geo: new THREE.BoxGeometry(0.018, 0.022, BODY_LENGTH * 0.5),
        pos: [-BODY_WIDTH * 0.48 - 0.13, 0.16, -0.08],
      },
      {
        geo: new THREE.BoxGeometry(0.018, 0.022, BODY_LENGTH * 0.5),
        pos: [BODY_WIDTH * 0.48 + 0.13, 0.16, -0.08],
      },
      // Short underglow under the nose so the front end reads as lit too.
      {
        geo: new THREE.BoxGeometry(BODY_WIDTH * 0.6, 0.018, 0.018),
        pos: [0, 0.14, BODY_LENGTH * 0.46],
      },
    ]),
    headlightHalo: mergeParts([
      // Halo geometry has shrunk three times during the beautify pass. v1 was
      // 0.42×0.22 and additive at opacity 0.55 — the bloom pass picked up
      // both halos and merged them into a single white slab that covered the
      // front of the kart. 0.26×0.10 at opacity 0.22 sits tight around the
      // headlight box, the planes are 0.32 apart on X (no overlap), and the
      // bloom contribution drops below the visual-saturation threshold.
      {
        geo: new THREE.PlaneGeometry(0.2, 0.08),
        pos: [-0.24, 0.4, BODY_LENGTH * 0.68],
      },
      {
        geo: new THREE.PlaneGeometry(0.2, 0.08),
        pos: [0.24, 0.4, BODY_LENGTH * 0.68],
      },
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
        // Dark smoked canopy instead of the old milky `#8ad4ff` at opacity
        // 0.9. Stacking a bright base colour, `transparent: true`, AND
        // `transmission` is what made the canopy read as frosted plastic: the
        // opacity blend whitened whatever was behind it while the transmission
        // pass tried to refract the same pixels. A dark tint with transmission
        // near 1 and `transparent: false` lets the refraction do all the work,
        // so the canopy darkens its contents instead of washing them out.
        color: '#16303f',
        roughness: 0.06,
        metalness: 0,
        transmission: 0.92,
        transparent: false,
        thickness: 0.35,
        ior: 1.45,
        attenuationColor: '#1d4a63',
        attenuationDistance: 1.4,
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
    // Hood LED material — emissive at 1.2 with the livery accent. The gold
    // livery (#ffd166, luminance ~0.86) clears the 0.72 bloom threshold at
    // intensity 1.0 already, so the LED bar blooms even without a halo. The
    // other liveries need this level to read as lit at all.
    const ledStripMat = this.track(
      new THREE.MeshStandardMaterial({
        color: this.config.accent,
        emissive: this.config.accent,
        emissiveIntensity: 1.2,
        roughness: 0.3,
      }),
    );
    const lampMat = this.track(new THREE.MeshBasicMaterial({ color: '#eefcff' }));
    const tailMat = this.track(new THREE.MeshBasicMaterial({ color: '#ff2a6d' }));
    // The idle underbody strip is plain (no additive, no emissive) so it
    // reads as a painted accent rather than feeding the bloom pass. The gold
    // livery (#ffd166) already clears the 0.72 bloom threshold on its own;
    // pushing more luminance there would blow out the surrounding pixels.
    const underbodyMat = this.track(
      new THREE.MeshBasicMaterial({
        color: this.config.accent,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    // Headlight halos *should* bloom — that is the entire point of them —
// so additive with a soft alpha and no depth write. Opacity 0.22 keeps
// the two halos from merging into one slab via the bloom pass (threshold
// 0.72, radius 0.42): each plane alone contributes 0.22 to the pixel, well
// under saturation. A faint cool tint instead of #ffffff reads as "lit" and
// matches the headlight box's #eefcff.
const headlightHaloMat = this.track(
  new THREE.MeshBasicMaterial({
    color: '#ddeeff',
    transparent: true,
    opacity: 0.22,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  }),
);

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
    group.add(new THREE.Mesh(geometries.ledStrip, ledStripMat));
    group.add(new THREE.Mesh(geometries.headlights, lampMat));
    group.add(new THREE.Mesh(geometries.tailLamps, tailMat));
    group.add(new THREE.Mesh(geometries.underbodyGlow, underbodyMat));
    group.add(new THREE.Mesh(geometries.headlightHalo, headlightHaloMat));

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
