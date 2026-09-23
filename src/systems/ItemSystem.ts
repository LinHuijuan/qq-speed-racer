import * as THREE from 'three';
import { loadGameTexture } from '../assets/textures';
import type { Track } from '../game/Track';

export type ItemType = 'turbo' | 'missile' | 'shield' | 'mine';

export type ItemBox = {
  mesh: THREE.Group;
  position: THREE.Vector3;
  active: boolean;
  respawn: number;
};

export type ActiveMine = {
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  life: number;
};

const BOX_RESPAWN = 5.5;
const MINE_LIFE = 12;

/** Shared across every box / mine — created once instead of per pickup. */
const BOX_GEOMETRY = new THREE.BoxGeometry(0.95, 0.95, 0.95);
const RING_GEOMETRY = new THREE.TorusGeometry(0.7, 0.06, 8, 24);
const MINE_GEOMETRY = new THREE.SphereGeometry(0.35, 12, 12);

export class ItemSystem {
  readonly group = new THREE.Group();
  readonly boxes: ItemBox[] = [];
  readonly mines: ActiveMine[] = [];
  private readonly rng: () => number;
  private readonly itemTypes: ItemType[] = ['turbo', 'turbo', 'missile', 'shield', 'mine'];
  private readonly boxMaterial: THREE.MeshStandardMaterial;
  /*
   * #7cf6ff scores 0.825 on UnrealBloomPass's Rec.601 luma (0.299/0.587/0.114).
   * That sat just under the old 0.85 threshold and so never bloomed; at the new
   * 0.72 it cleared the bar and the 0.06-radius tube ballooned into a fat white
   * band that hid whatever was behind it — including the player's kart driving
   * through the box. A more saturated cyan scores 0.657, staying clearly a neon
   * cyan target without clipping to white.
   */
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ color: '#2fd4ff' });
  private readonly mineMaterial = new THREE.MeshStandardMaterial({
    color: '#ff4f7a',
    emissive: '#ff2a6d',
    emissiveIntensity: 1.2,
    roughness: 0.4,
  });

  constructor(seed = 99) {
    let s = seed >>> 0;
    this.rng = () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const itemTex = loadGameTexture('/assets/item-box.webp', { repeat: [1, 1] });
    this.boxMaterial = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      map: itemTex,
      emissive: '#9b6bff',
      emissiveMap: itemTex,
      emissiveIntensity: 0.75,
      roughness: 0.25,
      metalness: 0.4,
      transparent: true,
      opacity: 0.95,
    });
  }

  build(track: Track): void {
    this.disposeMeshes();
    this.boxes.length = 0;
    this.mines.length = 0;

    const ts = [0.05, 0.15, 0.28, 0.38, 0.5, 0.62, 0.72, 0.84];
    for (const t of ts) {
      const sample = track.sampleAt(t);
      const lateral = (this.rng() - 0.5) * 6;
      const pos = sample.position
        .clone()
        .addScaledVector(sample.left, lateral);
      pos.y = 1.1;
      const mesh = this.createBoxMesh();
      mesh.position.copy(pos);
      this.group.add(mesh);
      this.boxes.push({
        mesh,
        position: pos.clone(),
        active: true,
        respawn: 0,
      });
    }
  }

  rollItem(): ItemType {
    return this.itemTypes[Math.floor(this.rng() * this.itemTypes.length)] ?? 'turbo';
  }

  collect(position: THREE.Vector3, radius = 1.8): boolean {
    for (const box of this.boxes) {
      if (!box.active) continue;
      if (box.position.distanceTo(position) < radius) {
        box.active = false;
        box.respawn = BOX_RESPAWN;
        box.mesh.visible = false;
        return true;
      }
    }
    return false;
  }

  dropMine(position: THREE.Vector3, heading: number): void {
    const back = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
    const pos = position.clone().addScaledVector(back, 2.2);
    pos.y = 0.15;
    const mesh = new THREE.Mesh(MINE_GEOMETRY, this.mineMaterial);
    mesh.position.copy(pos);
    this.group.add(mesh);
    this.mines.push({ mesh, position: pos.clone(), life: MINE_LIFE });
  }

  /** Returns true if a kart hit a mine (mine is consumed). */
  checkMineHit(position: THREE.Vector3, radius = 1.3): boolean {
    for (let i = this.mines.length - 1; i >= 0; i -= 1) {
      const mine = this.mines[i];
      if (mine.position.distanceTo(position) < radius) {
        this.group.remove(mine.mesh);
        this.mines.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  update(delta: number, elapsed: number): void {
    for (const box of this.boxes) {
      if (!box.active) {
        box.respawn -= delta;
        if (box.respawn <= 0) {
          box.active = true;
          box.mesh.visible = true;
        }
      } else {
        box.mesh.rotation.y = elapsed * 2.2;
        box.mesh.position.y = 1.1 + Math.sin(elapsed * 3 + box.position.x) * 0.15;
      }
    }
    for (let i = this.mines.length - 1; i >= 0; i -= 1) {
      const mine = this.mines[i];
      mine.life -= delta;
      if (mine.life <= 0) {
        this.group.remove(mine.mesh);
        this.mines.splice(i, 1);
      }
    }
  }

  /** Detaches every box/mine. Shared geometries and materials are kept. */
  disposeMeshes(): void {
    while (this.group.children.length) {
      this.group.remove(this.group.children[0]);
    }
  }

  dispose(): void {
    this.disposeMeshes();
    this.boxMaterial.dispose();
    this.ringMaterial.dispose();
    this.mineMaterial.dispose();
  }

  private createBoxMesh(): THREE.Group {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(BOX_GEOMETRY, this.boxMaterial));

    const ring = new THREE.Mesh(RING_GEOMETRY, this.ringMaterial);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    const ring2 = ring.clone();
    ring2.rotation.y = Math.PI / 2;
    group.add(ring2);

    return group;
  }
}
