/**
 * Checks every track layout for the closed-Catmull-Rom seam artifact.
 *
 * getTangentAt(0) on a closed curve blends the incoming and outgoing legs, so on
 * a start line that sits on a turn the spawn heading can point well off the road.
 * The road mesh itself is drawn from sample positions and is unaffected, so the
 * analytic tangent is compared against the actual step direction.
 *
 * Also evaluates a chord-based heading (aim at the sample a few units ahead) and
 * reports how far a straight launch drifts from the centreline.
 */
import * as THREE from 'three';

const LAYOUTS = {
  neon: {
    tension: 0.35,
    points: [
      [0, 0, 0], [36, 0, 4], [64, 0, 18], [78, 0, 46], [70, 0, 78], [42, 0, 92],
      [8, 0, 86], [-14, 0, 62], [-12, 0, 34], [-34, 0, 16], [-62, 0, 20], [-82, 0, 46],
      [-86, 0, 78], [-62, 0, 98], [-28, 0, 104], [-2, 0, 92], [8, 0, 62], [4, 0, 34],
      [-10, 0, 12], [-8, 0, -8], [8, 0, -18], [28, 0, -12],
    ],
  },
  hairpin: {
    tension: 0.25,
    points: [
      [0, 0, 0], [40, 0, 2], [55, 0, 18], [42, 0, 34], [18, 0, 30], [8, 0, 14],
      [18, 0, -2], [42, 0, 6], [58, 0, 28], [48, 0, 52], [22, 0, 58], [4, 0, 44],
      [-8, 0, 22], [4, 0, 4], [28, 0, -8], [52, 0, 0], [70, 0, 22], [62, 0, 50],
      [36, 0, 68], [8, 0, 62], [-10, 0, 40], [-6, 0, 12], [-20, 0, -12], [-40, 0, 0],
      [-36, 0, 28], [-18, 0, 40], [-2, 0, 28], [-16, 0, 8], [-8, 0, -16], [12, 0, -20],
    ],
  },
  harbor: {
    tension: 0.4,
    points: [
      [0, 0, 0], [70, 0, 0], [110, 0, 8], [130, 0, 30], [120, 0, 55], [90, 0, 70],
      [50, 0, 68], [20, 0, 50], [8, 0, 28], [12, 0, 8], [35, 0, -5], [70, 0, -8],
      [100, 0, -20], [90, 0, -45], [55, 0, -55], [20, 0, -48], [-5, 0, -30], [-20, 0, -8],
      [-15, 0, 18], [5, 0, 35], [-10, 0, 55], [-40, 0, 58], [-60, 0, 40], [-55, 0, 12],
      [-30, 0, -2], [-10, 0, 8],
    ],
  },
  mountain: {
    tension: 0.3,
    points: [
      [0, 0, 0], [30, 0, 10], [50, 0, 35], [45, 0, 65], [20, 0, 85], [-10, 0, 90],
      [-35, 0, 75], [-45, 0, 48], [-30, 0, 25], [-5, 0, 20], [10, 0, 40], [5, 0, 65],
      [-20, 0, 72], [-45, 0, 60], [-65, 0, 35], [-70, 0, 5], [-50, 0, -15], [-20, 0, -22],
      [5, 0, -10], [25, 0, -25], [50, 0, -20], [70, 0, 5], [65, 0, 35], [40, 0, 50],
      [15, 0, 42], [18, 0, 18], [35, 0, 5], [55, 0, -5], [40, 0, -30], [10, 0, -40],
      [-25, 0, -38], [-40, 0, -15], [-25, 0, 5], [-8, 0, -5], [8, 0, -15], [22, 0, 0],
    ],
  },
};

const SAMPLES = 420;
const heading = (v) => Math.atan2(v.x, v.z);
/** Signed angle from a to b, in (-pi, pi]. */
const angleDelta = (a, b) => Math.atan2(Math.sin(b - a), Math.cos(b - a));

function analyse(name, { points, tension }) {
  const pts = points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', tension);
  curve.arcLengthDivisions = 800;
  const lapLength = curve.getLength();

  const samples = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const t = i / SAMPLES;
    samples.push({
      position: curve.getPointAt(t),
      tangent: curve.getTangentAt(t).setY(0).normalize(),
    });
  }
  const spacing = lapLength / SAMPLES;

  const analytic = heading(samples[0].tangent);
  const step = heading(samples[1].position.clone().sub(samples[0].position));

  // How far does a straight launch at `h` drift from the centreline?
  const drift = (h, distance) => {
    const probe = samples[0].position
      .clone()
      .addScaledVector(new THREE.Vector3(Math.sin(h), 0, Math.cos(h)), distance);
    let best = samples[0];
    let bestDist = Infinity;
    for (const s of samples) {
      const d = s.position.distanceToSquared(probe);
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }
    return probe.clone().sub(best.position).dot(new THREE.Vector3(-best.tangent.z, 0, best.tangent.x));
  };

  // Chord heading: aim at the sample roughly `lookahead` units down the road.
  const chordHeading = (lookaheadUnits) => {
    const k = Math.max(1, Math.round(lookaheadUnits / spacing));
    const ahead = samples[Math.min(k, SAMPLES - 1)];
    return heading(ahead.position.clone().sub(samples[0].position));
  };

  console.log(`\n=== ${name} (tension ${tension}, lap ${lapLength.toFixed(0)}u, spacing ${spacing.toFixed(2)}u) ===`);
  console.log(`  analytic tangent at seam : ${analytic.toFixed(4)}`);
  console.log(`  actual step direction    : ${step.toFixed(4)}`);
  console.log(`  mismatch                 : ${angleDelta(analytic, step).toFixed(4)} rad (${((angleDelta(analytic, step) * 180) / Math.PI).toFixed(1)} deg)`);
  console.log(`  drift at analytic heading: ${drift(analytic, 10).toFixed(2)}u after 10u, ${drift(analytic, 15).toFixed(2)}u after 15u`);

  console.log('  candidate chord headings:');
  for (const la of [1, 2, 4, 6, 8, 12]) {
    const h = chordHeading(la);
    console.log(
      `    aim ${String(la).padStart(2)}u ahead -> heading ${h.toFixed(4)}  drift ${drift(h, 10).toFixed(2)}u @10u, ${drift(h, 15).toFixed(2)}u @15u`,
    );
  }

  // Is the artifact confined to sample 0, or does it span a neighbourhood?
  const bad = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    const analyticH = heading(samples[i].tangent);
    const next = samples[(i + 1) % SAMPLES];
    const stepH = heading(next.position.clone().sub(samples[i].position));
    const delta = angleDelta(analyticH, stepH);
    if (Math.abs(delta) > 0.1) bad.push({ i, delta: Number(delta.toFixed(3)) });
  }
  console.log(`  samples where the analytic tangent disagrees with the step direction by >0.1 rad: ${bad.length}`);
  console.log(`    ${bad.slice(0, 12).map((b) => `i=${b.i}(${b.delta})`).join(' ') || '(none)'}`);
  return { name, analytic, step, mismatch: angleDelta(analytic, step) };
}

const results = Object.entries(LAYOUTS).map(([name, layout]) => analyse(name, layout));

console.log('\n=== summary: seam tangent mismatch ===');
for (const r of results) {
  const flag = Math.abs(r.mismatch) > 0.2 ? '  <-- BAD' : '';
  console.log(`  ${r.name.padEnd(9)} mismatch ${r.mismatch.toFixed(4)} rad (${((r.mismatch * 180) / Math.PI).toFixed(1)} deg)${flag}`);
}
