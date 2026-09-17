import * as THREE from 'three';

export class CameraRig {
  private readonly desiredPosition = new THREE.Vector3();
  private readonly lookTarget = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly smoothForward = new THREE.Vector3(0, 0, 1);
  private trauma = 0;
  private shakeTime = 0;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly distance = 7.2,
    private readonly height = 2.35,
  ) {}

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  snapTo(position: THREE.Vector3, heading: number, speed: number): void {
    this.forward.set(Math.sin(heading), 0, Math.cos(heading));
    this.smoothForward.copy(this.forward);
    this.desiredPosition.copy(position).addScaledVector(this.smoothForward, -this.distance);
    this.desiredPosition.y += this.height;
    this.camera.position.copy(this.desiredPosition);
    this.lookTarget.copy(position).addScaledVector(this.forward, 4.5 + speed * 0.05);
    this.lookTarget.y += 0.9;
    this.camera.lookAt(this.lookTarget);
    this.trauma = 0;
  }

  update(delta: number, position: THREE.Vector3, heading: number, speed: number, boosting: boolean): void {
    this.forward.set(Math.sin(heading), 0, Math.cos(heading));
    const follow = 1 - Math.exp(-delta * (boosting ? 7.5 : 5.5));
    this.smoothForward.lerp(this.forward, follow).normalize();

    const dynamicDistance = this.distance + THREE.MathUtils.clamp(speed * 0.06, 0, 2.4);
    const dynamicHeight = this.height + THREE.MathUtils.clamp(speed * 0.01, 0, 0.5);

    this.desiredPosition.copy(position).addScaledVector(this.smoothForward, -dynamicDistance);
    this.desiredPosition.y += dynamicHeight;

    const camFactor = 1 - Math.exp(-delta / 0.055);
    this.camera.position.lerp(this.desiredPosition, camFactor);

    this.lookTarget.copy(position).addScaledVector(this.smoothForward, 4.2 + speed * 0.08);
    this.lookTarget.y += 0.85;
    this.camera.lookAt(this.lookTarget);

    // Speed FOV punch — stronger at arcade top speed
    const targetFov = 58 + THREE.MathUtils.clamp((speed - 8) * 0.22, 0, 12) + (boosting ? 6 : 0);
    this.camera.fov = THREE.MathUtils.damp(this.camera.fov, targetFov, 5, delta);
    this.camera.updateProjectionMatrix();

    this.shake(delta);
  }

  private shake(delta: number): void {
    this.shakeTime += delta;
    this.trauma = Math.max(0, this.trauma - delta * 1.6);
    if (this.trauma <= 0.001) return;
    const shake = this.trauma * this.trauma;
    const t = this.shakeTime * 28;
    this.camera.position.x += Math.sin(t * 1.13) * 0.28 * shake;
    this.camera.position.y += Math.cos(t * 1.71) * 0.2 * shake;
    this.camera.rotation.z += Math.sin(t * 0.97) * 0.025 * shake;
  }
}
