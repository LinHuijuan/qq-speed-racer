import * as THREE from 'three';
import { createSeededRandom } from '../utils/random';

type Particle = {
  life: number;
  maxLife: number;
  velocity: THREE.Vector3;
  gravity: number;
  /** Base point size in the same units as the old PointsMaterial `size`. */
  size: number;
};

/**
 * Soft round sprite, drawn as a point.
 *
 * PointsMaterial cannot vary the size per particle, and it has no map here, so
 * every spark used to render as a hard-edged square of one size — which is also
 * a poor bloom source, because bloom keys off bright pixels and a square has
 * four of them. A tiny ShaderMaterial fixes both: `aSize` is per particle, and
 * the fragment shader carves a quartic falloff out of the point square so the
 * centre is bright and the rim reaches zero.
 *
 * The size maths deliberately mirrors three's own `sizeAttenuation` path
 * (`size * pixelRatio * drawingBufferHeight * 0.5 / -mvPosition.z`), so a
 * particle keeps the exact on-screen size the old material gave it at 0.38.
 */
const VERTEX_SHADER = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelScale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // Clamped: the pool sits right behind the kart, a couple of metres from a
  // chase camera, and an unclamped attenuated point there covers most of the
  // screen. Several of those overlapping plus bloom washes the kart out
  // completely, so a glow stops growing once it is this wide.
  gl_PointSize = min(aSize * uPixelScale / max(0.001, -mv.z), 140.0);
  gl_Position = projectionMatrix * mv;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying vec3 vColor;
void main() {
  // 0 at the centre of the point square, 1 at the midpoint of each edge, so the
  // disc inscribed in the square is exactly r2 <= 1.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r2 = dot(d, d) * 4.0;
  if (r2 > 1.0) discard;
  float a = 1.0 - r2;
  a *= a;
  // Alpha is 1 and the falloff rides in the colour: AdditiveBlending is
  // src.rgb * src.a + dst.rgb, so this contributes vColor * a without the
  // falloff being squared twice.
  gl_FragColor = vec4(vColor * a, 1.0);
}
`;

/** Additive particle pool for drift sparks, boost trails, and impact sparks. */
export class Vfx {
  readonly group = new THREE.Group();
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly particles: Particle[] = [];
  private readonly geometry = new THREE.BufferGeometry();
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private cursor = 0;
  private readonly max = 360;
  private rng = createSeededRandom(7);
  private liveCount = 0;
  private dirty = true;
  private readonly scratch = new THREE.Vector3();
  private readonly colorScratch = new THREE.Color();
  private readonly colorCache = new Map<string, readonly [number, number, number]>();
  /** Reused by the per-frame size uniform update — must not allocate. */
  private readonly drawingSize = new THREE.Vector2();

  constructor() {
    this.positions = new Float32Array(this.max * 3);
    this.colors = new Float32Array(this.max * 3);
    this.sizes = new Float32Array(this.max);
    this.positionAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colorAttr = new THREE.BufferAttribute(this.colors, 3);
    this.sizeAttr = new THREE.BufferAttribute(this.sizes, 1);
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('aColor', this.colorAttr);
    this.geometry.setAttribute('aSize', this.sizeAttr);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uPixelScale: { value: 400 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    // Match three's sizeAttenuation maths. Done here rather than on resize so
    // it stays correct through the duo split's resized render targets.
    this.material.onBeforeRender = (renderer) => {
      renderer.getDrawingBufferSize(this.drawingSize);
      this.material.uniforms.uPixelScale.value =
        renderer.getPixelRatio() * this.drawingSize.y * 0.5;
    };

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.group.add(this.points);

    for (let i = 0; i < this.max; i += 1) {
      this.particles.push({
        life: 0,
        maxLife: 1,
        velocity: new THREE.Vector3(),
        gravity: 0,
        size: 0.38,
      });
      this.positions[i * 3 + 1] = -999;
    }
  }

  emitDrift(origin: THREE.Vector3, direction: THREE.Vector3, intensity: number): void {
    const count = intensity > 0.5 ? 10 : 5;
    for (let i = 0; i < count; i += 1) {
      const index = this.spawn(origin, 0.3 + this.rng() * 0.18);
      const p = this.particles[index];
      p.maxLife = 0.55 + this.rng() * 0.45;
      p.life = p.maxLife;
      p.gravity = 5;
      p.velocity
        .copy(direction)
        .multiplyScalar(-5 - this.rng() * 7)
        .add(
          this.scratch.set(
            (this.rng() - 0.5) * 3.2,
            2.2 + this.rng() * 2.4,
            (this.rng() - 0.5) * 3.2,
          ),
        );
      const c = this.rng();
      this.setColorAt(index, c > 0.55 ? '#ff3cac' : c > 0.25 ? '#ff9ad5' : '#ffd166');
    }
  }

  emitBoost(origin: THREE.Vector3, direction: THREE.Vector3): void {
    for (let i = 0; i < 4; i += 1) {
      const index = this.spawn(origin, 0.34 + this.rng() * 0.16);
      const p = this.particles[index];
      p.maxLife = 0.38 + this.rng() * 0.15;
      p.life = p.maxLife;
      p.gravity = 0;
      p.velocity
        .copy(direction)
        .multiplyScalar(-16 - this.rng() * 12)
        .add(
          this.scratch.set(
            (this.rng() - 0.5) * 1.4,
            (this.rng() - 0.3) * 0.8,
            (this.rng() - 0.5) * 1.4,
          ),
        );
      this.setColorAt(index, this.rng() > 0.5 ? '#7cf6ff' : '#b8f0ff');
    }
  }

  emitFireworks(center: THREE.Vector3): void {
    const colors = ['#2de2ff', '#ff3cac', '#ffd166', '#7cff6b', '#ffffff'];
    for (let burst = 0; burst < 5; burst += 1) {
      const ox = center.x + (this.rng() - 0.5) * 18;
      const oy = 6 + this.rng() * 10;
      const oz = center.z + (this.rng() - 0.5) * 18;
      const color = colors[burst % colors.length] ?? '#ffffff';
      const origin = this.scratch.set(ox, oy, oz);
      for (let i = 0; i < 28; i += 1) {
        const index = this.spawn(origin, 0.46 + this.rng() * 0.26);
        const p = this.particles[index];
        const a = (i / 28) * Math.PI * 2;
        const elev = (this.rng() - 0.3) * Math.PI;
        const sp = 4 + this.rng() * 7;
        p.maxLife = 0.9 + this.rng() * 0.6;
        p.life = p.maxLife;
        p.gravity = 3;
        p.velocity.set(
          Math.cos(a) * Math.cos(elev) * sp,
          Math.sin(elev) * sp * 0.7 + 2,
          Math.sin(a) * Math.cos(elev) * sp,
        );
        this.setColorAt(index, color);
      }
    }
  }

  emitShockwave(origin: THREE.Vector3, color = '#7cf6ff'): void {
    for (let i = 0; i < 18; i += 1) {
      const index = this.spawn(origin, 0.52 + this.rng() * 0.22);
      const p = this.particles[index];
      const a = (i / 18) * Math.PI * 2;
      p.maxLife = 0.55;
      p.life = p.maxLife;
      p.gravity = 1;
      p.velocity.set(Math.cos(a) * 7, 0.4 + this.rng() * 1.2, Math.sin(a) * 7);
      this.setColorAt(index, color);
    }
  }

  emitSparks(origin: THREE.Vector3, count = 10, color = '#ffd166'): void {
    for (let i = 0; i < count; i += 1) {
      const index = this.spawn(origin, 0.22 + this.rng() * 0.14);
      const p = this.particles[index];
      p.maxLife = 0.35 + this.rng() * 0.25;
      p.life = p.maxLife;
      p.gravity = 10;
      p.velocity.set(
        (this.rng() - 0.5) * 8,
        2 + this.rng() * 5,
        (this.rng() - 0.5) * 8,
      );
      this.setColorAt(index, color);
    }
  }

  /**
   * Heat trail off the rear of the kart. Kept separate from emitSparks because
   * those are *impact* sparks — they fire upward and fall hard. These drift
   * backwards and hang, which is what actually reads as speed, and they are the
   * soft-glow particles the sprite shader was written for.
   */
  emitTrail(origin: THREE.Vector3, direction: THREE.Vector3, intensity: number): void {
    const count = intensity > 0.7 ? 2 : 1;
    for (let i = 0; i < count; i += 1) {
      const index = this.spawn(origin, 0.3 + this.rng() * 0.24);
      const p = this.particles[index];
      p.maxLife = 0.3 + this.rng() * 0.3;
      p.life = p.maxLife;
      p.gravity = 1.2;
      p.velocity
        .copy(direction)
        .multiplyScalar(-(2 + intensity * 6))
        .add(
          this.scratch.set(
            (this.rng() - 0.5) * 1.6,
            0.4 + this.rng() * 1.4,
            (this.rng() - 0.5) * 1.6,
          ),
        );
      const c = this.rng();
      this.setColorAt(index, c > 0.6 ? '#7cf6ff' : c > 0.3 ? '#8ac8ff' : '#d8f4ff');
    }
  }

  /** Live particle count — 0 means the update pass is being skipped entirely. */
  get live(): number {
    return this.liveCount;
  }

  update(delta: number): void {
    // Skip the whole pass (and both buffer uploads) when nothing is alive.
    const needsUpload = this.dirty || this.liveCount > 0;
    let live = 0;

    if (needsUpload) {
      for (let i = 0; i < this.max; i += 1) {
        const p = this.particles[i];
        if (p.life <= 0) continue;
        p.life -= delta;
        const idx = i * 3;
        if (p.life <= 0) {
          this.positions[idx + 1] = -999;
          continue;
        }
        live += 1;
        this.positions[idx] += p.velocity.x * delta;
        this.positions[idx + 1] += p.velocity.y * delta;
        this.positions[idx + 2] += p.velocity.z * delta;
        p.velocity.y -= p.gravity * delta;
        // Fade color toward black by scaling the stored color
        const fade = p.life / p.maxLife;
        const k = 0.92 + fade * 0.08;
        this.colors[idx] *= k;
        this.colors[idx + 1] *= k;
        this.colors[idx + 2] *= k;
        // Glows shrink as they die too, which reads as dissipating rather than
        // merely dimming.
        this.sizes[i] = p.size * (0.5 + fade * 0.5);
      }
      this.positionAttr.needsUpdate = true;
      this.colorAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
      this.dirty = false;
    }

    this.liveCount = live;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  reseed(seed: number): void {
    this.rng = createSeededRandom(seed);
  }

  /** Claims a slot in the ring buffer and writes the emission point and size. */
  private spawn(origin: THREE.Vector3, size: number): number {
    const index = this.cursor;
    this.cursor = (this.cursor + 1) % this.max;
    this.positions[index * 3] = origin.x;
    this.positions[index * 3 + 1] = origin.y;
    this.positions[index * 3 + 2] = origin.z;
    this.particles[index].size = size;
    this.sizes[index] = size;
    this.dirty = true;
    return index;
  }

  private setColorAt(index: number, hex: string): void {
    let rgb = this.colorCache.get(hex);
    if (!rgb) {
      this.colorScratch.setStyle(hex);
      rgb = [this.colorScratch.r, this.colorScratch.g, this.colorScratch.b];
      this.colorCache.set(hex, rgb);
    }
    this.colors[index * 3] = rgb[0];
    this.colors[index * 3 + 1] = rgb[1];
    this.colors[index * 3 + 2] = rgb[2];
  }
}
