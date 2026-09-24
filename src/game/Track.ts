import * as THREE from 'three';
import { loadGameTexture } from '../assets/textures';
import {
  getTrackLayout,
  layoutToCurve,
  type TrackLayout,
  type TrackLayoutId,
} from './TrackLayouts';

export type TrackSample = {
  t: number;
  position: THREE.Vector3;
  tangent: THREE.Vector3;
  left: THREE.Vector3;
  halfWidth: number;
  curvature: number;
};

export type BoostPad = {
  position: THREE.Vector3;
  mesh: THREE.Mesh;
  radius: number;
  active: boolean;
  respawn: number;
};

const ROAD_HALF_WIDTH = 7.5;
const SAMPLE_COUNT = 420;
const BOOST_RESPAWN = 4.5;
/**
 * How far down the road the start line looks when deciding which way it faces.
 * In world units, so it behaves the same on every layout.
 */
const START_LINE_LOOKAHEAD = 8;

export class Track {
  readonly group = new THREE.Group();
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  readonly samples: TrackSample[] = [];
  readonly boostPads: BoostPad[] = [];
  readonly layout: TrackLayout;
  readonly startTransform = {
    position: new THREE.Vector3(),
    heading: 0,
  };

  private readonly startLine: THREE.Group;
  /** Reused by lateralOffset so the per-kart hot path allocates nothing. */
  private readonly lateralScratch = new THREE.Vector3();
  private readonly lateralResult = { lateral: 0, sample: null as unknown as TrackSample };

  constructor(layoutId: TrackLayoutId = 'neon') {
    this.layout = getTrackLayout(layoutId);
    this.curve = layoutToCurve(this.layout);
    this.curve.arcLengthDivisions = 800;
    this.length = this.curve.getLength();
    this.buildSamples();
    this.buildRoadMesh();
    this.buildBarriers();
    this.buildScenery();
    this.buildTracksideKit();
    this.boostPads = this.buildBoostPads();
    this.startLine = this.buildStartLine();
    this.group.add(this.startLine);

    const first = this.samples[0];
    this.startTransform.position.copy(first.position);
    this.startTransform.heading = Math.atan2(first.tangent.x, first.tangent.z);
  }

  get halfWidth(): number {
    return ROAD_HALF_WIDTH;
  }

  sampleAt(t: number): TrackSample {
    const wrapped = ((t % 1) + 1) % 1;
    const index = Math.min(this.samples.length - 1, Math.floor(wrapped * this.samples.length));
    return this.samples[index];
  }

  /** Local progress 0..1 by projecting a world position onto the closed curve. */
  projectProgress(position: THREE.Vector3, hintT = 0): number {
    const hintIndex = Math.floor((((hintT % 1) + 1) % 1) * this.samples.length);
    let bestIndex = hintIndex;
    let bestDist = Number.POSITIVE_INFINITY;

    for (let offset = -18; offset <= 18; offset += 1) {
      const index = (hintIndex + offset + this.samples.length) % this.samples.length;
      const sample = this.samples[index];
      const dist = sample.position.distanceToSquared(position);
      if (dist < bestDist) {
        bestDist = dist;
        bestIndex = index;
      }
    }

    // Full search if the kart was teleported far from the hint (respawn / test hook).
    if (bestDist > 400) {
      for (let i = 0; i < this.samples.length; i += 1) {
        const sample = this.samples[i];
        const dist = sample.position.distanceToSquared(position);
        if (dist < bestDist) {
          bestDist = dist;
          bestIndex = i;
        }
      }
    }

    return bestIndex / this.samples.length;
  }

  lateralOffset(position: THREE.Vector3, progress: number): { lateral: number; sample: TrackSample } {
    const sample = this.sampleAt(progress);
    this.lateralScratch.copy(position).sub(sample.position);
    this.lateralResult.lateral = this.lateralScratch.dot(sample.left);
    this.lateralResult.sample = sample;
    return this.lateralResult;
  }

  update(delta: number, elapsed: number): void {
    for (const pad of this.boostPads) {
      if (!pad.active) {
        pad.respawn -= delta;
        if (pad.respawn <= 0) {
          pad.active = true;
          pad.mesh.visible = true;
        }
      }
      if (pad.active) {
        pad.mesh.rotation.y = elapsed * 2.4;
        pad.mesh.position.y = 0.14 + Math.sin(elapsed * 4 + pad.position.x) * 0.06;
        const mat = pad.mesh.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.7 + Math.sin(elapsed * 6 + pad.position.z) * 0.35;
      }
    }
  }

  collectBoostPad(position: THREE.Vector3, radius = 1.6): boolean {
    for (const pad of this.boostPads) {
      if (!pad.active) continue;
      if (pad.position.distanceTo(position) < pad.radius + radius) {
        pad.active = false;
        pad.respawn = BOOST_RESPAWN;
        pad.mesh.visible = false;
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const material = obj.material;
        if (Array.isArray(material)) {
          for (const m of material) m.dispose();
        } else {
          material.dispose();
        }
      }
    });
  }

  private buildSamples(): void {
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const t = i / SAMPLE_COUNT;
      const position = this.curve.getPointAt(t);
      const tangent = this.curve.getTangentAt(t).setY(0).normalize();
      const left = new THREE.Vector3(-tangent.z, 0, tangent.x);
      const ahead = this.curve.getTangentAt((t + 0.012) % 1).setY(0).normalize();
      const curvature = tangent.angleTo(ahead);
      this.samples.push({
        t,
        position,
        tangent,
        left,
        halfWidth: ROAD_HALF_WIDTH,
        curvature,
      });
    }
    this.fixStartLineTangent();
  }

  /**
   * getTangentAt(0) on a closed CatmullRomCurve3 blends the incoming and outgoing
   * legs, so when the start line sits on a turn it points off the road — 39 deg out
   * on the neon layout. Everything downstream inherits the error: the road
   * cross-section (and so the mesh itself), the painted start line, the spawn
   * heading, respawns near progress 0, and the AI grid stagger. Aim at where the
   * road actually goes instead, measured far enough ahead that the local cusp
   * doesn't skew it.
   */
  private fixStartLineTangent(): void {
    const seam = this.samples[0];
    if (!seam) return;
    const spacing = this.length / SAMPLE_COUNT;
    const lookahead = Math.max(1, Math.round(START_LINE_LOOKAHEAD / spacing));
    const aim = this.samples[Math.min(lookahead, SAMPLE_COUNT - 1)];
    const dx = aim.position.x - seam.position.x;
    const dz = aim.position.z - seam.position.z;
    if (dx === 0 && dz === 0) return;
    seam.tangent.set(dx, 0, dz).normalize();
    seam.left.set(-seam.tangent.z, 0, seam.tangent.x);

    // Keep curvature on the same footing: the turn between here and a matching
    // distance further on, so AI nitro and straight-line scenery still agree.
    const beyond = this.samples[Math.min(lookahead * 2, SAMPLE_COUNT - 1)];
    const bx = beyond.position.x - aim.position.x;
    const bz = beyond.position.z - aim.position.z;
    if (bx !== 0 || bz !== 0) {
      seam.curvature = seam.tangent.angleTo(new THREE.Vector3(bx, 0, bz).normalize());
    }
  }

  private buildRoadMesh(): void {
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];

    const shoulder = 0.55;

    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const sample = this.samples[i];
      const v = i / SAMPLE_COUNT;
      const lateralOffsets = [-ROAD_HALF_WIDTH - shoulder, -ROAD_HALF_WIDTH, -1.2, 0, 1.2, ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + shoulder];
      // edgeCount = 5 road columns + 2 shoulder = we'll use 7 lateral points
      for (let e = 0; e < lateralOffsets.length; e += 1) {
        const offset = lateralOffsets[e];
        const x = sample.position.x + sample.left.x * offset;
        const z = sample.position.z + sample.left.z * offset;
        const y = 0.01;
        positions.push(x, y, z);
        const u = (e / (lateralOffsets.length - 1)) * 2;
        uvs.push(u, v * (this.length / 18));
      }
    }

    const cols = 7;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const next = (i + 1) % SAMPLE_COUNT;
      for (let e = 0; e < cols - 1; e += 1) {
        const a = i * cols + e;
        const b = i * cols + e + 1;
        const c = next * cols + e;
        const d = next * cols + e + 1;
        indices.push(a, c, b, b, c, d);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    const roadTexture = loadGameTexture('/assets/road-lanes.webp', {
      repeat: [1, Math.max(10, Math.floor(this.length / 14))],
    });
    const roughnessMap = this.createRoadRoughnessTexture();
    const material = new THREE.MeshStandardMaterial({
      color: '#d0d8e8',
      map: roadTexture,
      roughnessMap,
      roughness: 0.55,
      metalness: 0.2,
      side: THREE.DoubleSide,
    });

    const road = new THREE.Mesh(geometry, material);
    road.receiveShadow = true;
    this.group.add(road);

    // Subtle neon edge lines (not full-bright — they should not bloom out the road)
    const edgeMaterial = new THREE.MeshStandardMaterial({
      color: '#1a8aaa',
      emissive: '#2de2ff',
      emissiveIntensity: 0.7,
      roughness: 0.4,
      metalness: 0.3,
      side: THREE.DoubleSide,
    });
    const magentaMaterial = new THREE.MeshStandardMaterial({
      color: '#a02868',
      emissive: '#ff3cac',
      emissiveIntensity: 0.55,
      roughness: 0.4,
      metalness: 0.3,
      side: THREE.DoubleSide,
    });

    const leftStrip = this.createEdgeStrip(-ROAD_HALF_WIDTH + 0.15, edgeMaterial);
    const rightStrip = this.createEdgeStrip(ROAD_HALF_WIDTH - 0.15, magentaMaterial);
    this.group.add(leftStrip, rightStrip);

    this.buildNeonBeacons();
    this.buildCurbs();
  }

  /** Tall glowing pylons that pulse — primary night readability cue. */
  private buildNeonBeacons(): void {
    const beaconGeo = new THREE.BoxGeometry(0.35, 5.5, 0.35);
    const capGeo = new THREE.SphereGeometry(0.28, 10, 10);
    const cyanMat = new THREE.MeshStandardMaterial({
      color: '#0a3040',
      emissive: '#2de2ff',
      emissiveIntensity: 1.1,
      roughness: 0.3,
      metalness: 0.4,
    });
    const pinkMat = new THREE.MeshStandardMaterial({
      color: '#401030',
      emissive: '#ff3cac',
      emissiveIntensity: 0.95,
      roughness: 0.3,
      metalness: 0.4,
    });
    const capCyan = new THREE.MeshBasicMaterial({ color: '#9ef6ff' });
    const capPink = new THREE.MeshBasicMaterial({ color: '#ff9ad5' });

    const count = 20;
    const cyan = new THREE.InstancedMesh(beaconGeo, cyanMat, count);
    const pink = new THREE.InstancedMesh(beaconGeo, pinkMat, count);
    const capsC = new THREE.InstancedMesh(capGeo, capCyan, count);
    const capsP = new THREE.InstancedMesh(capGeo, capPink, count);
    const dummy = new THREE.Object3D();
    let ci = 0;
    let pi = 0;

    for (let i = 0; i < count; i += 1) {
      const t = i / count;
      const sample = this.sampleAt(t);
      const side = i % 2 === 0 ? -1 : 1;
      const offset = side * (ROAD_HALF_WIDTH + 2.8);
      const x = sample.position.x + sample.left.x * offset;
      const z = sample.position.z + sample.left.z * offset;
      dummy.position.set(x, 2.75, z);
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      if (side < 0 && ci < count) {
        cyan.setMatrixAt(ci, dummy.matrix);
        dummy.position.y = 5.6;
        dummy.updateMatrix();
        capsC.setMatrixAt(ci, dummy.matrix);
        ci += 1;
      } else if (pi < count) {
        pink.setMatrixAt(pi, dummy.matrix);
        dummy.position.y = 5.6;
        dummy.updateMatrix();
        capsP.setMatrixAt(pi, dummy.matrix);
        pi += 1;
      }
    }
    cyan.count = ci;
    pink.count = pi;
    capsC.count = ci;
    capsP.count = pi;
    cyan.instanceMatrix.needsUpdate = true;
    pink.instanceMatrix.needsUpdate = true;
    capsC.instanceMatrix.needsUpdate = true;
    capsP.instanceMatrix.needsUpdate = true;
    this.group.add(cyan, pink, capsC, capsP);
  }

  private buildCurbs(): void {
    // Red/white striped kerbs just outside the racing surface — key racing cue.
    const curbGeo = new THREE.BoxGeometry(0.55, 0.08, 1.1);
    const red = new THREE.MeshStandardMaterial({
      color: '#9a2a34',
      roughness: 0.7,
      metalness: 0.02,
    });
    const white = new THREE.MeshStandardMaterial({
      color: '#c5cad6',
      roughness: 0.65,
      metalness: 0.05,
    });

    const step = 8;
    const count = Math.floor(SAMPLE_COUNT / step) * 2;
    const redMesh = new THREE.InstancedMesh(curbGeo, red, Math.ceil(count / 2));
    const whiteMesh = new THREE.InstancedMesh(curbGeo, white, Math.ceil(count / 2));
    const dummy = new THREE.Object3D();
    let r = 0;
    let w = 0;

    for (let i = 0; i < SAMPLE_COUNT; i += step) {
      const sample = this.samples[i];
      const next = this.samples[(i + step) % SAMPLE_COUNT];
      for (const sign of [-1, 1] as const) {
        const offset = sign * (ROAD_HALF_WIDTH + 0.35);
        const x = sample.position.x + sample.left.x * offset;
        const z = sample.position.z + sample.left.z * offset;
        const nx = next.position.x + next.left.x * offset;
        const nz = next.position.z + next.left.z * offset;
        const midX = (x + nx) * 0.5;
        const midZ = (z + nz) * 0.5;
        dummy.position.set(midX, 0.06, midZ);
        dummy.lookAt(nx, 0.06, nz);
        dummy.scale.set(1, 1, Math.max(1, Math.hypot(nx - x, nz - z) / 1.1));
        dummy.updateMatrix();
        if ((i / step + (sign > 0 ? 1 : 0)) % 2 === 0) {
          if (r < redMesh.count) redMesh.setMatrixAt(r++, dummy.matrix);
        } else {
          if (w < whiteMesh.count) whiteMesh.setMatrixAt(w++, dummy.matrix);
        }
      }
    }
    redMesh.instanceMatrix.needsUpdate = true;
    whiteMesh.instanceMatrix.needsUpdate = true;
    redMesh.count = r;
    whiteMesh.count = w;
    this.group.add(redMesh, whiteMesh);
  }

  private createRoadRoughnessTexture(): THREE.CanvasTexture {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create roughness texture context.');
    ctx.fillStyle = '#b0b0b0';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 1800; i += 1) {
      const x = (i * 97) % size;
      const y = (i * 41) % size;
      const g = 150 + (i % 5) * 12;
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fillRect(x, y, 3, 3);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    return texture;
  }

  private createEdgeStrip(lateral: number, material: THREE.Material): THREE.Mesh {
    const positions: number[] = [];
    const indices: number[] = [];
    const width = 0.18;

    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const sample = this.samples[i];
      const x = sample.position.x + sample.left.x * lateral;
      const z = sample.position.z + sample.left.z * lateral;
      positions.push(x, 0.03, z);
      positions.push(x + sample.left.x * width, 0.03, z + sample.left.z * width);
    }

    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const next = (i + 1) % SAMPLE_COUNT;
      const a = i * 2;
      const b = i * 2 + 1;
      const c = next * 2;
      const d = next * 2 + 1;
      indices.push(a, c, b, b, c, d);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    return new THREE.Mesh(geometry, material);
  }

  private buildBarriers(): void {
    // The guardrails used to be two horizontal neon tubes in cyan (left) and
    // magenta (right) at low height. The road's own edge strips use the same
    // colours and the same horizontal glowing-line language — from the chase
    // camera the rail and the kerb line read as one parallel pair, so the
    // player cannot tell which one is the wall until they have already hit it.
    //
    // The wall now reads as a *surface* in a horizontal neutral surface
    // language: a yellow/black hazard kickplate (the universal "obstacle"
    // pattern) sitting just outside the red/white kerbs. The cyan/magenta
    // cues are demoted to small low-intensity post accents so the navigation
    // cue survives but the wall itself does not look like a road marking.
    //
    // Yellow #f0b020 → Rec.601 luminance ≈ 0.700, just under the bloom
    // threshold (0.72) so the stripes stay crisp instead of bleeding into a
    // soft halo. Black is well clear of any threshold.
    const hazardMap = this.createHazardTexture();
    const kickplateMat = new THREE.MeshStandardMaterial({
      map: hazardMap,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });
    const cyanPost = new THREE.MeshStandardMaterial({
      color: '#103040',
      emissive: '#2de2ff',
      emissiveIntensity: 0.18,
      roughness: 0.4,
      metalness: 0.5,
    });
    const pinkPost = new THREE.MeshStandardMaterial({
      color: '#401030',
      emissive: '#ff3cac',
      emissiveIntensity: 0.16,
      roughness: 0.4,
      metalness: 0.5,
    });
    const capCyan = new THREE.MeshBasicMaterial({ color: '#9ef6ff' });
    const capPink = new THREE.MeshBasicMaterial({ color: '#ff9ad5' });

    // Kickplate: x = thin (16cm), y = 60cm tall, z = 4m segment.
    // After `dummy.lookAt(next)` the local +Z points along the track tangent,
    // so scaling Z stretches the plate to fit each segment's chord length and
    // the long side faces (perpendicular to local X) point inward toward the
    // road and outward toward the scenery.
    const kickGeo = new THREE.BoxGeometry(0.16, 0.6, 4.0);
    const postGeo = new THREE.BoxGeometry(0.22, 1.3, 0.22);
    const capGeo = new THREE.BoxGeometry(0.32, 0.12, 0.32);

    const sideCount = Math.floor(SAMPLE_COUNT / 8);
    const leftKick = new THREE.InstancedMesh(kickGeo, kickplateMat, sideCount);
    const rightKick = new THREE.InstancedMesh(kickGeo, kickplateMat, sideCount);
    const leftPosts = new THREE.InstancedMesh(postGeo, cyanPost, sideCount);
    const rightPosts = new THREE.InstancedMesh(postGeo, pinkPost, sideCount);
    const leftCaps = new THREE.InstancedMesh(capGeo, capCyan, sideCount);
    const rightCaps = new THREE.InstancedMesh(capGeo, capPink, sideCount);

    const dummy = new THREE.Object3D();
    let lk = 0;
    let rk = 0;
    let lp = 0;
    let rp = 0;

    for (let i = 0; i < sideCount; i += 1) {
      const sampleIndex = Math.floor((i / sideCount) * SAMPLE_COUNT);
      // Skip the start/finish wrap zone — rails there look chaotic
      const t = sampleIndex / SAMPLE_COUNT;
      if (t < 0.02 || t > 0.97) continue;
      const sample = this.samples[sampleIndex];
      const next = this.samples[(sampleIndex + 6) % SAMPLE_COUNT];
      for (const sign of [-1, 1] as const) {
        const offset = sign * (ROAD_HALF_WIDTH + 0.55);
        const x = sample.position.x + sample.left.x * offset;
        const z = sample.position.z + sample.left.z * offset;
        const nx = next.position.x + next.left.x * offset;
        const nz = next.position.z + next.left.z * offset;
        const midX = (x + nx) / 2;
        const midZ = (z + nz) / 2;
        const len = Math.max(1, Math.hypot(nx - x, nz - z) * 1.05);

        // Hazard kickplate. y = 0.3 puts the bottom right at the ground
        // (above the kerbs which are y = 0.06).
        dummy.position.set(midX, 0.3, midZ);
        dummy.lookAt(nx, 0.3, nz);
        dummy.scale.set(1, 1, len / 4.0);
        dummy.updateMatrix();
        if (sign < 0) leftKick.setMatrixAt(lk++, dummy.matrix);
        else rightKick.setMatrixAt(rk++, dummy.matrix);

        // Post + cap at the segment's start
        dummy.position.set(x, 0.65, z);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        if (sign < 0 && lp < sideCount) {
          leftPosts.setMatrixAt(lp, dummy.matrix);
          dummy.position.y = 1.32;
          dummy.updateMatrix();
          leftCaps.setMatrixAt(lp++, dummy.matrix);
        } else if (sign > 0 && rp < sideCount) {
          rightPosts.setMatrixAt(rp, dummy.matrix);
          dummy.position.y = 1.32;
          dummy.updateMatrix();
          rightCaps.setMatrixAt(rp++, dummy.matrix);
        }
      }
    }
    leftKick.count = lk;
    rightKick.count = rk;
    leftPosts.count = lp;
    rightPosts.count = rp;
    leftCaps.count = lp;
    rightCaps.count = rp;
    for (const m of [leftKick, rightKick, leftPosts, rightPosts, leftCaps, rightCaps]) {
      m.instanceMatrix.needsUpdate = true;
      m.castShadow = true;
      this.group.add(m);
    }
  }

  /**
   * Yellow/black diagonal-stripe pattern used as the wall's `map`. Drawn as a
   * canvas so the build has no asset dependency. Keep the stripe colour just
   * under the bloom threshold so the pattern does not smear into a halo at
   * chase distance.
   */
  private createHazardTexture(): THREE.CanvasTexture {
    const width = 256;
    const height = 32;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create hazard texture context.');
    ctx.fillStyle = '#f0b020';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1a1a1a';
    const stripeWidth = 32;
    for (let i = 0; i < width; i += stripeWidth * 2) {
      ctx.fillRect(i, 0, stripeWidth, height);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.repeat.set(2, 1);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private buildRunoff(): void {
    // Asphalt runoff / shoulder just outside the kerbs
    const positions: number[] = [];
    const indices: number[] = [];
    const outer = ROAD_HALF_WIDTH + 2.4;
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const sample = this.samples[i];
      for (const sign of [-1, 1] as const) {
        const a = sample.position.x + sample.left.x * sign * (ROAD_HALF_WIDTH + 0.5);
        const b = sample.position.z + sample.left.z * sign * (ROAD_HALF_WIDTH + 0.5);
        const c = sample.position.x + sample.left.x * sign * outer;
        const d = sample.position.z + sample.left.z * sign * outer;
        positions.push(a, 0.008, b, c, 0.008, d);
      }
    }
    for (let i = 0; i < SAMPLE_COUNT; i += 1) {
      const next = (i + 1) % SAMPLE_COUNT;
      // left side
      const a0 = i * 4;
      const b0 = i * 4 + 1;
      const c0 = next * 4;
      const d0 = next * 4 + 1;
      indices.push(a0, c0, b0, b0, c0, d0);
      // right side
      const a1 = i * 4 + 2;
      const b1 = i * 4 + 3;
      const c1 = next * 4 + 2;
      const d1 = next * 4 + 3;
      indices.push(a1, b1, c1, b1, d1, c1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: '#3a4250',
      map: loadGameTexture('/assets/runoff.webp', { repeat: [2, 40] }),
      roughness: 0.92,
      metalness: 0.02,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private buildScenery(): void {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(460, 460),
      new THREE.MeshStandardMaterial({
        color: '#3a4258',
        map: loadGameTexture('/assets/ground-night.webp', { repeat: [40, 40] }),
        roughness: 1,
        metalness: 0,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    this.group.add(ground);

    // Runoff / gravel strip outside track (lighter)
    this.buildRunoff();

    // Grid lines on the ground for depth
    const grid = new THREE.GridHelper(400, 40, '#1a2744', '#141c30');
    grid.position.y = 0.01;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.35;
    this.group.add(grid);

    const rng = (() => {
      let s = 1337;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
    })();

    const buildingGeo = new THREE.BoxGeometry(1, 1, 1);
    const facadeTex = loadGameTexture('/assets/building-facade.webp', { repeat: [1, 1] });
    const buildingMat = new THREE.MeshStandardMaterial({
      color: '#8a92a8',
      map: facadeTex,
      roughness: 0.7,
      metalness: 0.2,
      emissive: '#102040',
      emissiveIntensity: 0.25,
    });
    const windowMat = new THREE.MeshBasicMaterial({ color: '#9ef0ff' });
    const windowWarm = new THREE.MeshBasicMaterial({ color: '#ffc48a' });

    const buildings = new THREE.InstancedMesh(buildingGeo, buildingMat, 90);
    const windows = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.28, 0.4), windowMat, 280);
    const warmWindows = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.28, 0.4), windowWarm, 120);
    const roofCaps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 0.4, 1),
      new THREE.MeshStandardMaterial({ color: '#243050', roughness: 0.5, metalness: 0.3 }),
      90,
    );
    const dummy = new THREE.Object3D();
    let wIndex = 0;
    let warmIndex = 0;

    for (let i = 0; i < 90; i += 1) {
      const angle = rng() * Math.PI * 2;
      const ring = i < 40 ? 110 + rng() * 40 : 155 + rng() * 60;
      const w = 5 + rng() * 12;
      const h = 10 + rng() * (i < 15 ? 40 : 22);
      const d = 5 + rng() * 12;
      const x = Math.cos(angle) * ring;
      const z = Math.sin(angle) * ring + 30;
      dummy.position.set(x, h / 2, z);
      dummy.scale.set(w, h, d);
      dummy.rotation.set(0, rng() * Math.PI, 0);
      dummy.updateMatrix();
      buildings.setMatrixAt(i, dummy.matrix);

      // roof cap
      dummy.position.set(x, h + 0.2, z);
      dummy.scale.set(w * 0.85, 0.4, d * 0.85);
      dummy.updateMatrix();
      roofCaps.setMatrixAt(i, dummy.matrix);

      const rows = 2 + Math.floor(rng() * 3);
      for (let n = 0; n < rows; n += 1) {
        const useWarm = rng() > 0.72;
        const target = useWarm ? warmWindows : windows;
        const idx = useWarm ? warmIndex : wIndex;
        if (idx >= (useWarm ? 120 : 280)) continue;
        dummy.position.set(
          x + (rng() - 0.5) * w * 0.7,
          h * (0.15 + rng() * 0.7),
          z + d / 2 + 0.06,
        );
        dummy.scale.set(1.6 + rng() * 1.4, 1.4, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        target.setMatrixAt(idx, dummy.matrix);
        if (useWarm) warmIndex += 1;
        else wIndex += 1;
      }
    }

    buildings.instanceMatrix.needsUpdate = true;
    windows.instanceMatrix.needsUpdate = true;
    warmWindows.instanceMatrix.needsUpdate = true;
    roofCaps.instanceMatrix.needsUpdate = true;
    this.group.add(buildings, windows, warmWindows, roofCaps);

    // Neon base strips on near buildings
    const stripMat = new THREE.MeshBasicMaterial({ color: '#2de2ff' });
    const strips = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 0.25, 0.15), stripMat, 40);
    for (let i = 0; i < 40; i += 1) {
      const angle = (i / 40) * Math.PI * 2;
      const r = 82 + rng() * 20;
      dummy.position.set(Math.cos(angle) * r, 1.2, Math.sin(angle) * r + 30);
      dummy.scale.set(6 + rng() * 8, 1, 1);
      dummy.rotation.set(0, angle, 0);
      dummy.updateMatrix();
      strips.setMatrixAt(i, dummy.matrix);
    }
    strips.instanceMatrix.needsUpdate = true;
    this.group.add(strips);

    // Neon billboards near the track — textured posters
    const bbTex = loadGameTexture('/assets/billboard-neon.webp', { repeat: [1, 1] });
    const billboardColors = ['#2de2ff', '#ff3cac', '#ffd166', '#7cff6b', '#9b6bff'];
    for (let i = 0; i < 10; i += 1) {
      const sample = this.samples[Math.floor((i / 10) * SAMPLE_COUNT)];
      const side = i % 2 === 0 ? 1 : -1;
      const offset = side * (ROAD_HALF_WIDTH + 9 + rng() * 4);
      const color = billboardColors[i % billboardColors.length] ?? '#2de2ff';
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(5.2, 2.6, 0.3),
        new THREE.MeshStandardMaterial({
          color: '#ffffff',
          map: bbTex,
          emissive: color,
          emissiveMap: bbTex,
          emissiveIntensity: 0.55,
          roughness: 0.4,
          metalness: 0.2,
        }),
      );
      board.position.set(
        sample.position.x + sample.left.x * offset,
        3.4 + rng() * 1.5,
        sample.position.z + sample.left.z * offset,
      );
      board.lookAt(sample.position.x, board.position.y, sample.position.z);
      this.group.add(board);

      const pole = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.16, board.position.y, 8),
        new THREE.MeshStandardMaterial({ color: '#2a3148', roughness: 0.5, metalness: 0.4 }),
      );
      pole.position.set(board.position.x, board.position.y / 2, board.position.z);
      this.group.add(pole);
    }

    // Pylons along the track
    const pylonGeo = new THREE.CylinderGeometry(0.18, 0.28, 8, 8);
    const pylonMat = new THREE.MeshStandardMaterial({
      color: '#1a2438',
      emissive: '#147090',
      emissiveIntensity: 0.22,
      roughness: 0.5,
    });
    const pylons = new THREE.InstancedMesh(pylonGeo, pylonMat, 36);
    for (let i = 0; i < 36; i += 1) {
      const sample = this.samples[Math.floor((i / 36) * SAMPLE_COUNT)];
      const side = i % 2 === 0 ? -1 : 1;
      const offset = side * (ROAD_HALF_WIDTH + 4.2);
      dummy.position.set(
        sample.position.x + sample.left.x * offset,
        4,
        sample.position.z + sample.left.z * offset,
      );
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      pylons.setMatrixAt(i, dummy.matrix);
    }
    pylons.instanceMatrix.needsUpdate = true;
    this.group.add(pylons);

    // Distant skyline silhouettes
    const skyMat = new THREE.MeshBasicMaterial({ color: '#0a1020' });
    const skyline = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), skyMat, 40);
    for (let i = 0; i < 40; i += 1) {
      const angle = (i / 40) * Math.PI * 2;
      const radius = 200 + rng() * 40;
      const h = 20 + rng() * 50;
      dummy.position.set(Math.cos(angle) * radius, h / 2, Math.sin(angle) * radius + 20);
      dummy.scale.set(12 + rng() * 18, h, 12 + rng() * 18);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      skyline.setMatrixAt(i, dummy.matrix);
    }
    skyline.instanceMatrix.needsUpdate = true;
    this.group.add(skyline);
  }

  /** Dense trackside kit: grandstands, catch fences, spectators, tire walls, landmarks. */
  private buildTracksideKit(): void {
    const rng = (() => {
      let s = 20240915;
      return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
    })();

    const steel = new THREE.MeshStandardMaterial({
      color: '#5a6478',
      map: loadGameTexture('/assets/metal-rail.webp', { repeat: [2, 2] }),
      roughness: 0.45,
      metalness: 0.65,
    });
    const concrete = new THREE.MeshStandardMaterial({
      color: '#8a92a4',
      map: loadGameTexture('/assets/concrete-wall.webp', { repeat: [2, 1] }),
      roughness: 0.88,
      metalness: 0.04,
    });
    const seatMat = new THREE.MeshStandardMaterial({
      color: '#6a8ccc',
      map: loadGameTexture('/assets/grandstand.webp', { repeat: [3, 1] }),
      roughness: 0.65,
      metalness: 0.1,
    });
    const tireMats = [
      new THREE.MeshStandardMaterial({
        color: '#2a2e38',
        map: loadGameTexture('/assets/metal-rail.webp', { repeat: [0.5, 0.5] }),
        roughness: 0.9,
      }),
      new THREE.MeshStandardMaterial({ color: '#c23a3a', roughness: 0.8 }),
      new THREE.MeshStandardMaterial({
        color: '#c8cdd8',
        map: loadGameTexture('/assets/concrete-wall.webp', { repeat: [0.3, 0.3] }),
        roughness: 0.75,
      }),
    ];

    // --- Catch fences: thin vertical bars (NOT huge translucent planes) ---
    const barGeo = new THREE.BoxGeometry(0.06, 2.2, 0.06);
    const railGeo = new THREE.BoxGeometry(0.08, 0.08, 2.8);
    const barMat = new THREE.MeshStandardMaterial({
      color: '#8a94a8',
      map: loadGameTexture('/assets/metal-rail.webp', { repeat: [1, 1] }),
      roughness: 0.35,
      metalness: 0.8,
    });
    const fenceBars = new THREE.InstancedMesh(barGeo, barMat, 400);
    const fenceRails = new THREE.InstancedMesh(railGeo, barMat, 400);
    const dummy = new THREE.Object3D();
    let bi = 0;
    let ri = 0;

    for (let i = 0; i < SAMPLE_COUNT; i += 6) {
      const sample = this.samples[i];
      const next = this.samples[(i + 5) % SAMPLE_COUNT];
      for (const sign of [-1, 1] as const) {
        const offset = sign * (ROAD_HALF_WIDTH + 1.55);
        const x = sample.position.x + sample.left.x * offset;
        const z = sample.position.z + sample.left.z * offset;
        const nx = next.position.x + next.left.x * offset;
        const nz = next.position.z + next.left.z * offset;

        if (bi < fenceBars.count) {
          dummy.position.set(x, 1.15, z);
          dummy.scale.set(1, 1, 1);
          dummy.rotation.set(0, 0, 0);
          dummy.updateMatrix();
          fenceBars.setMatrixAt(bi++, dummy.matrix);
        }
        // mid + top rails
        if (ri + 1 < fenceRails.count) {
          const midX = (x + nx) / 2;
          const midZ = (z + nz) / 2;
          const len = Math.max(0.5, Math.hypot(nx - x, nz - z));
          for (const y of [0.9, 1.8]) {
            dummy.position.set(midX, y, midZ);
            dummy.scale.set(1, 1, Math.max(0.4, len / 2.8));
            dummy.lookAt(nx, y, nz);
            dummy.updateMatrix();
            fenceRails.setMatrixAt(ri++, dummy.matrix);
          }
        }
      }
    }
    fenceBars.count = bi;
    fenceRails.count = ri;
    fenceBars.instanceMatrix.needsUpdate = true;
    fenceRails.instanceMatrix.needsUpdate = true;
    this.group.add(fenceBars, fenceRails);

    // --- Tire stacks at corner exits (taller, denser wall look) ---
    const tireGeo = new THREE.CylinderGeometry(0.48, 0.48, 0.36, 14);
    const tireMeshes = tireMats.map((m) => new THREE.InstancedMesh(tireGeo, m, 120));
    const tireCounts = [0, 0, 0];
    const cornerTs = [0.1, 0.22, 0.35, 0.48, 0.6, 0.72, 0.85, 0.95];
    for (const t of cornerTs) {
      const sample = this.sampleAt(t);
      for (const sign of [-1, 1] as const) {
        const offset = sign * (ROAD_HALF_WIDTH + 1.0);
        for (let row = 0; row < 3; row += 1) {
          for (let col = 0; col < 5; col += 1) {
            const mi = (row + col + (sign > 0 ? 1 : 0)) % 3;
            if (tireCounts[mi] >= 120) continue;
            dummy.position.set(
              sample.position.x + sample.left.x * offset + sample.tangent.x * (col * 0.85 - 1.7),
              0.18 + row * 0.34,
              sample.position.z + sample.left.z * offset + sample.tangent.z * (col * 0.85 - 1.7),
            );
            dummy.rotation.set(0, 0, 0);
            dummy.scale.set(1, 1, 1);
            dummy.updateMatrix();
            tireMeshes[mi].setMatrixAt(tireCounts[mi]++, dummy.matrix);
          }
        }
      }
    }
    tireMeshes.forEach((mesh, i) => {
      mesh.count = tireCounts[i];
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      this.group.add(mesh);
    });

    // --- Grandstands (3 stands along long straights) ---
    const standSpots = [0.05, 0.35, 0.68];
    const spectatorColors = ['#ff6b6b', '#ffd166', '#6bcb77', '#4d96ff', '#c77dff', '#f8f9fa', '#ff9f1c'];
    for (const [si, t] of standSpots.entries()) {
      const sample = this.sampleAt(t);
      const side = si % 2 === 0 ? 1 : -1;
      const baseOff = side * (ROAD_HALF_WIDTH + 5.5);
      const stand = new THREE.Group();
      const standPos = new THREE.Vector3(
        sample.position.x + sample.left.x * baseOff,
        0,
        sample.position.z + sample.left.z * baseOff,
      );
      stand.position.copy(standPos);
      stand.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);

      // Platform base
      const base = new THREE.Mesh(new THREE.BoxGeometry(18, 0.6, 8), concrete);
      base.position.set(0, 0.3, side > 0 ? 0 : 0);
      base.castShadow = true;
      base.receiveShadow = true;
      stand.add(base);

      // Tiered seats
      for (let tier = 0; tier < 5; tier += 1) {
        const seat = new THREE.Mesh(
          new THREE.BoxGeometry(17, 0.45, 1.4),
          seatMat,
        );
        seat.position.set(0, 0.9 + tier * 0.85, side > 0 ? 3.2 - tier * 1.5 : -3.2 + tier * 1.5);
        seat.castShadow = true;
        stand.add(seat);
      }

      // Roof
      const roof = new THREE.Mesh(new THREE.BoxGeometry(19, 0.25, 7), steel);
      roof.position.set(0, 5.4, side > 0 ? 0.5 : -0.5);
      roof.castShadow = true;
      stand.add(roof);
      for (const px of [-8, 0, 8]) {
        const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 5, 0.3), steel);
        pillar.position.set(px, 2.8, side > 0 ? 3.2 : -3.2);
        stand.add(pillar);
      }

      // Spectators (instanced capsules)
      const bodyGeo = new THREE.CapsuleGeometry(0.22, 0.55, 3, 6);
      const headGeo = new THREE.SphereGeometry(0.18, 6, 6);
      const crowdCount = 90;
      const bodies = spectatorColors.map(
        (c) =>
          new THREE.InstancedMesh(
            bodyGeo,
            new THREE.MeshStandardMaterial({
            color: c,
            roughness: 0.75,
            emissive: c,
            emissiveIntensity: 0.18,
          }),
            Math.ceil(crowdCount / spectatorColors.length) + 2,
          ),
      );
      const heads = new THREE.InstancedMesh(
        headGeo,
        new THREE.MeshStandardMaterial({ color: '#e0b898', roughness: 0.75 }),
        crowdCount,
      );
      const bodyIdx = spectatorColors.map(() => 0);
      let headIdx = 0;

      for (let i = 0; i < crowdCount; i += 1) {
        const tier = Math.floor(rng() * 5);
        const seatX = (rng() - 0.5) * 15;
        const seatZ = side > 0 ? 3.2 - tier * 1.5 : -3.2 + tier * 1.5;
        const seatY = 0.9 + tier * 0.85 + 0.55;
        const ci = Math.floor(rng() * spectatorColors.length);
        dummy.position.set(seatX, seatY, seatZ);
        dummy.rotation.set(0, (rng() - 0.5) * 0.4, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        if (bodyIdx[ci] < bodies[ci].count) {
          bodies[ci].setMatrixAt(bodyIdx[ci]++, dummy.matrix);
        }
        dummy.position.y = seatY + 0.55;
        dummy.updateMatrix();
        if (headIdx < heads.count) {
          heads.setMatrixAt(headIdx++, dummy.matrix);
        }
      }
      bodies.forEach((b, i) => {
        b.count = bodyIdx[i];
        b.instanceMatrix.needsUpdate = true;
        stand.add(b);
      });
      heads.count = headIdx;
      heads.instanceMatrix.needsUpdate = true;
      stand.add(heads);

      this.group.add(stand);
    }

    // --- Landmark: neon tower ---
    const towerPos = new THREE.Vector3(55, 0, 55);
    const tower = new THREE.Group();
    tower.position.copy(towerPos);
    const towerBody = new THREE.Mesh(
      new THREE.CylinderGeometry(3, 5, 42, 8),
      new THREE.MeshStandardMaterial({
        color: '#1a2240',
        roughness: 0.45,
        metalness: 0.4,
        emissive: '#0a1830',
        emissiveIntensity: 0.4,
      }),
    );
    towerBody.position.y = 21;
    towerBody.castShadow = true;
    tower.add(towerBody);
    for (let i = 0; i < 8; i += 1) {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(3.2 + i * 0.15, 0.12, 6, 24),
        new THREE.MeshBasicMaterial({ color: i % 2 === 0 ? '#2de2ff' : '#ff3cac' }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 6 + i * 4.5;
      tower.add(ring);
    }
    const spire = new THREE.Mesh(
      new THREE.ConeGeometry(2, 8, 8),
      new THREE.MeshBasicMaterial({ color: '#ffd166' }),
    );
    spire.position.y = 46;
    tower.add(spire);
    this.group.add(tower);

    // --- Landmark: neon arch over a mid-track section ---
    const archSample = this.sampleAt(0.5);
    const arch = new THREE.Group();
    arch.position.copy(archSample.position);
    arch.rotation.y = Math.atan2(archSample.tangent.x, archSample.tangent.z);
    for (const sign of [-1, 1] as const) {
      const col = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 10, 0.8),
        new THREE.MeshStandardMaterial({ color: '#2a3148', roughness: 0.4, metalness: 0.5 }),
      );
      col.position.set(sign * (ROAD_HALF_WIDTH + 1.5), 5, 0);
      arch.add(col);
    }
    const archBeam = new THREE.Mesh(
      new THREE.BoxGeometry((ROAD_HALF_WIDTH + 1.5) * 2, 0.7, 0.7),
      new THREE.MeshStandardMaterial({
        color: '#1a2840',
        emissive: '#2de2ff',
        emissiveIntensity: 0.8,
        roughness: 0.35,
      }),
    );
    archBeam.position.y = 10.2;
    arch.add(archBeam);
    const archGlow = new THREE.Mesh(
      new THREE.BoxGeometry((ROAD_HALF_WIDTH + 1.2) * 2, 0.15, 0.15),
      new THREE.MeshBasicMaterial({ color: '#ff3cac' }),
    );
    archGlow.position.y = 9.6;
    arch.add(archGlow);
    this.group.add(arch);

    // --- Landmark: ferris wheel silhouette ---
    const wheelCenter = new THREE.Vector3(-70, 0, 40);
    const ferris = new THREE.Group();
    ferris.position.copy(wheelCenter);
    const wheelRing = new THREE.Mesh(
      new THREE.TorusGeometry(14, 0.5, 8, 32),
      new THREE.MeshStandardMaterial({
        color: '#2a3148',
        emissive: '#4a90c8',
        emissiveIntensity: 0.35,
        roughness: 0.4,
        metalness: 0.5,
      }),
    );
    wheelRing.position.y = 18;
    ferris.add(wheelRing);
    for (let i = 0; i < 12; i += 1) {
      const a = (i / 12) * Math.PI * 2;
      const spoke = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 14, 0.2),
        new THREE.MeshStandardMaterial({ color: '#3a4258', roughness: 0.5, metalness: 0.4 }),
      );
      spoke.position.set(Math.cos(a) * 7, 18 + Math.sin(a) * 7, 0);
      spoke.rotation.z = a - Math.PI / 2;
      ferris.add(spoke);
      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 1.4, 1.2),
        new THREE.MeshStandardMaterial({
          color: spectatorColors[i % spectatorColors.length] ?? '#ffd166',
          emissive: spectatorColors[i % spectatorColors.length] ?? '#ffd166',
          emissiveIntensity: 0.4,
          roughness: 0.4,
        }),
      );
      cabin.position.set(Math.cos(a) * 14, 18 + Math.sin(a) * 14, 0);
      ferris.add(cabin);
    }
    const support = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, 18, 1.2),
      new THREE.MeshStandardMaterial({ color: '#3a4258', roughness: 0.5, metalness: 0.4 }),
    );
    support.position.set(-3, 9, 0);
    support.rotation.z = 0.18;
    ferris.add(support);
    const support2 = support.clone();
    support2.position.x = 3;
    support2.rotation.z = -0.18;
    ferris.add(support2);
    this.group.add(ferris);

    // --- Trackside light poles with glow discs ---
    const lampGeo = new THREE.SphereGeometry(0.35, 8, 8);
    const lampMat = new THREE.MeshBasicMaterial({ color: '#fff2c8' });
    const poleGeo = new THREE.CylinderGeometry(0.14, 0.2, 7, 8);
    const poles = new THREE.InstancedMesh(poleGeo, steel, 28);
    const lamps = new THREE.InstancedMesh(lampGeo, lampMat, 28);
    let pi = 0;
    for (let i = 0; i < 28; i += 1) {
      const sample = this.samples[Math.floor((i / 28) * SAMPLE_COUNT)];
      const side = i % 2 === 0 ? -1 : 1;
      const offset = side * (ROAD_HALF_WIDTH + 3.2);
      dummy.position.set(
        sample.position.x + sample.left.x * offset,
        3.5,
        sample.position.z + sample.left.z * offset,
      );
      dummy.scale.set(1, 1, 1);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      poles.setMatrixAt(pi, dummy.matrix);
      dummy.position.y = 7.1;
      dummy.updateMatrix();
      lamps.setMatrixAt(pi, dummy.matrix);
      pi += 1;
    }
    poles.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    this.group.add(poles, lamps);

    // --- Directional chevrons on outer walls ---
    const chevronMat = new THREE.MeshBasicMaterial({
      color: '#ffd166',
      side: THREE.DoubleSide,
    });
    for (let i = 0; i < 16; i += 1) {
      const t = (i / 16 + 0.03) % 1;
      const sample = this.sampleAt(t);
      if (sample.curvature < 0.04) continue;
      const side = sample.tangent.x * sample.left.z - sample.tangent.z * sample.left.x > 0 ? 1 : -1;
      const offset = side * (ROAD_HALF_WIDTH + 2.2);
      const board = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.0), chevronMat);
      board.position.set(
        sample.position.x + sample.left.x * offset,
        1.4,
        sample.position.z + sample.left.z * offset,
      );
      board.lookAt(sample.position.x, 1.4, sample.position.z);
      this.group.add(board);
    }

    // --- Pit garages near start ---
    const pitSample = this.sampleAt(0.02);
    const pitSide = 1;
    const pitBase = new THREE.Vector3(
      pitSample.position.x + pitSample.left.x * (ROAD_HALF_WIDTH + 7),
      0,
      pitSample.position.z + pitSample.left.z * (ROAD_HALF_WIDTH + 7),
    );
    const pit = new THREE.Group();
    pit.position.copy(pitBase);
    pit.rotation.y = Math.atan2(pitSample.tangent.x, pitSample.tangent.z);
    const garageMat = new THREE.MeshStandardMaterial({
      color: '#8a94b0',
      map: loadGameTexture('/assets/pit-garage.webp', { repeat: [1, 1] }),
      roughness: 0.55,
      metalness: 0.35,
    });
    const doorMats = [
      new THREE.MeshStandardMaterial({
        color: '#6a9ccc',
        map: loadGameTexture('/assets/pit-garage.webp', { repeat: [1, 1] }),
        emissive: '#2de2ff',
        emissiveIntensity: 0.4,
        roughness: 0.4,
      }),
      new THREE.MeshStandardMaterial({
        color: '#c06a9a',
        map: loadGameTexture('/assets/pit-garage.webp', { repeat: [1, 1] }),
        emissive: '#ff3cac',
        emissiveIntensity: 0.35,
        roughness: 0.4,
      }),
      new THREE.MeshStandardMaterial({
        color: '#c0a060',
        map: loadGameTexture('/assets/pit-garage.webp', { repeat: [1, 1] }),
        emissive: '#ffd166',
        emissiveIntensity: 0.3,
        roughness: 0.4,
      }),
    ];
    for (let i = 0; i < 5; i += 1) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(4.2, 3.6, 5), garageMat);
      box.position.set(i * 4.6 - 9, 1.8, pitSide * 2);
      box.castShadow = true;
      box.receiveShadow = true;
      pit.add(box);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.6), doorMats[i % 3]);
      door.position.set(i * 4.6 - 9, 1.4, pitSide * 2 - 2.55);
      door.rotation.y = pitSide > 0 ? Math.PI : 0;
      pit.add(door);
    }
    const pitRoof = new THREE.Mesh(new THREE.BoxGeometry(24, 0.3, 6.5), steel);
    pitRoof.position.set(0, 3.8, pitSide * 2);
    pit.add(pitRoof);
    this.group.add(pit);

    // --- Victory podium ---
    const podiumSample = this.sampleAt(0.03);
    const podium = new THREE.Group();
    podium.position.set(
      podiumSample.position.x + podiumSample.left.x * (ROAD_HALF_WIDTH + 10),
      0,
      podiumSample.position.z + podiumSample.left.z * (ROAD_HALF_WIDTH + 10),
    );
    podium.rotation.y = Math.atan2(podiumSample.tangent.x, podiumSample.tangent.z);
    const blocks: Array<[number, number, string]> = [
      [0, 2.2, '#ffd166'],
      [-2.2, 1.6, '#c0c8d8'],
      [2.2, 1.2, '#c47a4a'],
    ];
    for (const [x, h, col] of blocks) {
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(1.8, h, 1.8),
        new THREE.MeshStandardMaterial({
          color: col,
          roughness: 0.4,
          metalness: 0.35,
          emissive: col,
          emissiveIntensity: 0.15,
        }),
      );
      step.position.set(x, h / 2, 0);
      step.castShadow = true;
      podium.add(step);
    }
    const podiumSign = new THREE.Mesh(
      new THREE.BoxGeometry(6.5, 0.9, 0.2),
      new THREE.MeshStandardMaterial({
        color: '#1a2238',
        emissive: '#2de2ff',
        emissiveIntensity: 0.7,
        roughness: 0.35,
      }),
    );
    podiumSign.position.set(0, 3.2, -1.2);
    podium.add(podiumSign);
    this.group.add(podium);
  }

  private buildBoostPads(): BoostPad[] {
    const padTs = this.layout.boostTs ?? [0.08, 0.22, 0.41, 0.58, 0.77];
    const padTex = loadGameTexture('/assets/boost-pad.webp', { repeat: [1, 1] });
    const geometry = new THREE.CylinderGeometry(2.1, 2.1, 0.16, 24);
    const material = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      map: padTex,
      emissive: '#2de2ff',
      emissiveMap: padTex,
      emissiveIntensity: 0.9,
      roughness: 0.3,
      metalness: 0.35,
      transparent: true,
      opacity: 0.95,
    });
    // Geometry and ring material are shared; only the pad glow material is
    // cloned because its emissiveIntensity pulses per pad.
    const ringGeometry = new THREE.RingGeometry(2.3, 2.7, 28);
    // Same reasoning as the item-box rings: #7cf6ff scores 0.825 on
    // UnrealBloomPass's Rec.601 luma, which clears the 0.72 threshold and blows
    // the ring out to white. The pad surface still carries its own emissive
    // glow, so the ring only has to read as a cyan outline.
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: '#2fd4ff',
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    });

    return padTs.map((t) => {
      const sample = this.sampleAt(t);
      const mesh = new THREE.Mesh(geometry, material.clone());
      mesh.position.copy(sample.position);
      mesh.position.y = 0.14;
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      mesh.add(ring);
      this.group.add(mesh);
      return {
        position: mesh.position.clone(),
        mesh,
        radius: 2.4,
        active: true,
        respawn: 0,
      };
    });
  }

  private buildStartLine(): THREE.Group {
    const group = new THREE.Group();
    const sample = this.sampleAt(0);
    const checkerTex = loadGameTexture('/assets/start-checker.webp', { repeat: [1, 1] });
    const geometry = new THREE.PlaneGeometry(ROAD_HALF_WIDTH * 2, 2.8);
    const material = new THREE.MeshBasicMaterial({
      map: checkerTex,
      side: THREE.DoubleSide,
    });
    const line = new THREE.Mesh(geometry, material);
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = Math.atan2(sample.tangent.x, sample.tangent.z);
    line.position.copy(sample.position);
    line.position.y = 0.04;
    group.add(line);

    // Start gantry / arch
    const archMat = new THREE.MeshStandardMaterial({
      color: '#1a2238',
      roughness: 0.4,
      metalness: 0.55,
      emissive: '#0a2038',
      emissiveIntensity: 0.3,
    });
    const neonMat = new THREE.MeshBasicMaterial({ color: '#5ef7ff' });
    const neonMat2 = new THREE.MeshBasicMaterial({ color: '#ff5fd0' });

    for (const sign of [-1, 1] as const) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.7, 9, 0.7), archMat);
      const off = sign * (ROAD_HALF_WIDTH + 1.2);
      pillar.position.set(
        sample.position.x + sample.left.x * off,
        4.5,
        sample.position.z + sample.left.z * off,
      );
      pillar.castShadow = true;
      group.add(pillar);

      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.15, 8, 0.15), sign < 0 ? neonMat : neonMat2);
      strip.position.copy(pillar.position);
      strip.position.y = 4.5;
      group.add(strip);
    }

    const beam = new THREE.Mesh(
      new THREE.BoxGeometry((ROAD_HALF_WIDTH + 1.2) * 2 + 0.7, 1.1, 0.9),
      archMat,
    );
    beam.position.set(sample.position.x, 9.2, sample.position.z);
    beam.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
    beam.castShadow = true;
    group.add(beam);

    const beamNeon = new THREE.Mesh(
      new THREE.BoxGeometry((ROAD_HALF_WIDTH + 1.2) * 2, 0.18, 0.18),
      neonMat,
    );
    beamNeon.position.set(sample.position.x, 8.7, sample.position.z);
    beamNeon.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
    group.add(beamNeon);

    const beamNeon2 = new THREE.Mesh(
      new THREE.BoxGeometry((ROAD_HALF_WIDTH + 1.2) * 2, 0.14, 0.14),
      neonMat2,
    );
    beamNeon2.position.set(sample.position.x, 9.6, sample.position.z);
    beamNeon2.rotation.y = Math.atan2(sample.tangent.x, sample.tangent.z);
    group.add(beamNeon2);

    return group;
  }
}
