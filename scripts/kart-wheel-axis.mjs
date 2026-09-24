/**
 * Which way does each wheel part actually point?
 *
 * The wheel is a Mesh with `rotation.z = pi/2` carrying four child meshes. That
 * means every child's geometry is authored in a frame where the axle is +Y, and
 * the wheel's own rotation is what carries +Y onto the car's lateral axis.
 *
 * A cylinder authored with `rot: [0, 0, pi/2]` has its axis on X *in that same
 * frame* — so it cannot be parallel to the tyre's axle. This reproduces the
 * exact composition offline and prints the world-space bounding box of each
 * part, which is decisive: a part on the axle is ROUND in the YZ cross-section
 * (|Y - Z| ~ 0), because YZ is the plane the wheel spins in.
 *
 *   node scripts/kart-wheel-axis.mjs
 *
 * Caveat, and it is a real one: this script restates the wheel's construction
 * rather than reading it, so it can drift from `buildWheelGeometries`. Treat it
 * as a diagnostic you reach for when a wheel looks wrong, not as a regression
 * test. If it disagrees with the source, the source is right.
 */
import * as THREE from '../node_modules/three/build/three.module.js';

const radius = 0.3;

function worldBox(geometry, wheelRotationZ) {
  const mesh = new THREE.Mesh(geometry);
  mesh.rotation.z = wheelRotationZ;
  mesh.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(mesh);
  const size = new THREE.Vector3();
  box.getSize(size);
  return [size.x, size.y, size.z].map((v) => Math.round(v * 1000) / 1000);
}

const wheel = Math.PI / 2;

const cases = [
  ['tyre  (lathe, axis +Y)', new THREE.LatheGeometry([], 0), null],
  [
    'barrel  rot [0,0,pi/2]  <- current',
    new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, 0.16, 18).rotateZ(Math.PI / 2),
    wheel,
  ],
  [
    'barrel  no rot         <- proposed',
    new THREE.CylinderGeometry(radius * 0.5, radius * 0.5, 0.16, 18),
    wheel,
  ],
  [
    'hub     rot [0,0,pi/2]  <- current',
    new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, 0.24, 12).rotateZ(Math.PI / 2),
    wheel,
  ],
  [
    'hub     no rot         <- proposed',
    new THREE.CylinderGeometry(radius * 0.18, radius * 0.18, 0.24, 12),
    wheel,
  ],
];

console.log('world-space bounding box of each part (kart local axes)');
console.log('  X = lateral (the axle)   Y = up   Z = fore/aft');
console.log('');
for (const [name, geo, rot] of cases) {
  if (rot === null) {
    // LatheGeometry with an empty profile is not useful; build the real one.
    const pts = [
      new THREE.Vector2(radius * 0.5, -0.1),
      new THREE.Vector2(radius * 0.78, -0.12),
      new THREE.Vector2(radius * 0.96, -0.08),
      new THREE.Vector2(radius, 0),
      new THREE.Vector2(radius * 0.96, 0.08),
      new THREE.Vector2(radius * 0.78, 0.12),
      new THREE.Vector2(radius * 0.5, 0.1),
    ];
    const size = worldBox(new THREE.LatheGeometry(pts, 20), wheel);
    console.log(`  ${name.padEnd(34)} X ${String(size[0]).padStart(6)}  Y ${String(size[1]).padStart(6)}  Z ${String(size[2]).padStart(6)}`);
    continue;
  }
  const size = worldBox(geo, rot);
  /*
   * The test is roundness in the YZ cross-section, NOT "X is the smallest
   * extent". The barrel is 0.16 long and 0.30 across, so its axis is its
   * smallest dimension; the hub is 0.24 long and 0.108 across, so its axis is
   * its largest. Testing "X is smallest" called the correct hub a failure.
   * A part is on the axle iff its YZ cross-section is circular.
   */
  const round = Math.abs(size[1] - size[2]) < 0.01;
  console.log(
    `  ${name.padEnd(34)} X ${String(size[0]).padStart(6)}  Y ${String(size[1]).padStart(6)}  Z ${String(size[2]).padStart(6)}   ${round ? 'on the axle' : 'OFF the axle'}`,
  );
}
