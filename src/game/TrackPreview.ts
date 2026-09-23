import * as THREE from 'three';
import { TRACK_LAYOUTS, type TrackLayoutId } from './TrackLayouts';

/**
 * A track's racing line, flattened into SVG so the menu cards can show the real
 * shape instead of a generic icon. Sampled off the same CatmullRomCurve3 the
 * world is built from, so the silhouette always matches the track you drive.
 */
export type TrackPreview = {
  /** Closed path in a `size` × `size` box. */
  path: string;
  /** Boost pad positions, in the same box. */
  boosts: Array<{ x: number; y: number }>;
  /** Start/finish position, in the same box. */
  start: { x: number; y: number };
  accentA: string;
  accentB: string;
};

const DEFAULT_ACCENTS = { accentA: '#2de2ff', accentB: '#ff3cac' } as const;
const cache = new Map<string, TrackPreview>();

const round = (value: number) => Math.round(value * 100) / 100;

export function trackPreview(id: TrackLayoutId, size = 96, pad = 12): TrackPreview {
  const key = `${id}|${size}|${pad}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const layout = TRACK_LAYOUTS.find((candidate) => candidate.id === id);
  if (!layout) {
    return { path: '', boosts: [], start: { x: size / 2, y: size / 2 }, ...DEFAULT_ACCENTS };
  }

  const points = layout.points.map(([x, , z]) => new THREE.Vector3(x, 0, z));
  const curve = new THREE.CatmullRomCurve3(points, true, 'catmullrom', layout.tension ?? 0.35);
  const samples = curve.getSpacedPoints(180);

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const point of samples) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minZ = Math.min(minZ, point.z);
    maxZ = Math.max(maxZ, point.z);
  }

  // One scale for both axes so the shape is never distorted, then centre it.
  const spanX = maxX - minX || 1;
  const spanZ = maxZ - minZ || 1;
  const scale = (size - pad * 2) / Math.max(spanX, spanZ);
  const offsetX = (size - spanX * scale) / 2 - minX * scale;
  const offsetZ = (size - spanZ * scale) / 2 - minZ * scale;
  const project = (point: THREE.Vector3) => ({
    x: round(point.x * scale + offsetX),
    // SVG y grows downward; the world's +Z should read as "up" on the card.
    y: round(size - (point.z * scale + offsetZ)),
  });

  let path = '';
  for (let i = 0; i < samples.length; i += 1) {
    const { x, y } = project(samples[i]);
    path += `${i === 0 ? 'M' : 'L'}${x} ${y}`;
  }
  path += 'Z';

  const boosts = (layout.boostTs ?? []).map((t) => project(curve.getPointAt(t % 1)));

  const preview: TrackPreview = {
    path,
    boosts,
    start: project(curve.getPointAt(0)),
    accentA: layout.accentA ?? DEFAULT_ACCENTS.accentA,
    accentB: layout.accentB ?? DEFAULT_ACCENTS.accentB,
  };
  cache.set(key, preview);
  return preview;
}
