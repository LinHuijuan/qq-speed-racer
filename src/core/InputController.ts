import * as THREE from 'three';

export type RaceInputFrame = {
  throttle: number;
  brake: number;
  steer: number;
  drift: boolean;
  nitro: boolean;
  useItem: boolean;
  reset: boolean;
};

export type PlayerBindings = {
  throttle: string[];
  brake: string[];
  left: string[];
  right: string[];
  drift: string[];
  nitro: string[];
  item: string[];
};

export const P1_BINDINGS: PlayerBindings = {
  throttle: ['KeyW'],
  brake: ['KeyS'],
  left: ['KeyA'],
  right: ['KeyD'],
  drift: ['ShiftLeft', 'KeyZ'],
  nitro: ['Space'],
  item: ['KeyE', 'KeyX'],
};

export const P2_BINDINGS: PlayerBindings = {
  throttle: ['ArrowUp'],
  brake: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  drift: ['ShiftRight', 'Period'],
  nitro: ['Numpad0', 'Enter', 'NumpadEnter'],
  item: ['Slash', 'NumpadDecimal', 'Comma'],
};

export type DualMode = 'solo' | 'duo';

type PointerState = {
  active: boolean;
  id: number | null;
  centerX: number;
  centerY: number;
  radius: number;
};

export class InputController {
  private readonly keys = new Set<string>();
  private readonly pointer = new THREE.Vector2();
  private readonly pointerState: PointerState = {
    active: false,
    id: null,
    centerX: 0,
    centerY: 0,
    radius: 1,
  };

  private mode: DualMode = 'solo';

  // Touch (P1 only)
  private touchDrift = false;
  private touchNitro = false;
  private touchItemEdge = false;
  private stickThrottle = 0;
  private stickBrake = 0;
  private stickSteer = 0;

  // Edge-triggered items
  private p1ItemWasDown = false;
  private p2ItemWasDown = false;
  private p1ResetWasDown = false;
  private p2ResetWasDown = false;
  private touchResetEdge = false;

  private readonly onKeyDown = (event: KeyboardEvent) => {
    this.keys.add(event.code);
    if (event.code === 'Space') event.preventDefault();
    if (this.mode === 'duo' && event.code.startsWith('Arrow')) event.preventDefault();
    if (this.mode === 'duo' && event.code === 'Enter') event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
  };

  private readonly onStickDown = (event: PointerEvent) => {
    event.preventDefault();
    const rect = this.stick.getBoundingClientRect();
    this.pointerState.active = true;
    this.pointerState.id = event.pointerId;
    this.pointerState.centerX = rect.left + rect.width / 2;
    this.pointerState.centerY = rect.top + rect.height / 2;
    this.pointerState.radius = rect.width * 0.42;
    try {
      this.stick.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    this.updatePointer(event.clientX, event.clientY);
  };

  private readonly onStickMove = (event: PointerEvent) => {
    if (!this.pointerState.active || event.pointerId !== this.pointerState.id) return;
    event.preventDefault();
    this.updatePointer(event.clientX, event.clientY);
  };

  private readonly onStickUp = (event: PointerEvent) => {
    if (event.pointerId !== this.pointerState.id) return;
    event.preventDefault();
    this.pointerState.active = false;
    this.pointerState.id = null;
    this.pointer.set(0, 0);
    this.stickThrottle = 0;
    this.stickBrake = 0;
    this.stickSteer = 0;
    this.updateKnob();
  };

  private readonly onDriftDown = (event: PointerEvent) => {
    event.preventDefault();
    this.touchDrift = true;
  };

  private readonly onDriftUp = (event: PointerEvent) => {
    event.preventDefault();
    this.touchDrift = false;
  };

  private readonly onNitroDown = (event: PointerEvent) => {
    event.preventDefault();
    this.touchNitro = true;
  };

  private readonly onNitroUp = (event: PointerEvent) => {
    event.preventDefault();
    this.touchNitro = false;
  };

  private readonly onItemDown = (event: PointerEvent) => {
    event.preventDefault();
    this.touchItemEdge = true;
  };

  private readonly onItemUp = (event: PointerEvent) => {
    event.preventDefault();
  };

  private readonly onResetDown = (event: PointerEvent) => {
    event.preventDefault();
    this.touchResetEdge = true;
  };

  private readonly onResetUp = (event: PointerEvent) => {
    event.preventDefault();
  };

  constructor(
    private readonly stick: HTMLElement,
    private readonly knob: HTMLElement,
    private readonly driftButton: HTMLElement,
    private readonly nitroButton: HTMLElement,
    private readonly itemButton: HTMLElement,
    private readonly resetButton: HTMLElement,
  ) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    this.stick.addEventListener('pointerdown', this.onStickDown);
    this.stick.addEventListener('pointermove', this.onStickMove);
    this.stick.addEventListener('pointerup', this.onStickUp);
    this.stick.addEventListener('pointercancel', this.onStickUp);
    this.driftButton.addEventListener('pointerdown', this.onDriftDown);
    this.driftButton.addEventListener('pointerup', this.onDriftUp);
    this.driftButton.addEventListener('pointercancel', this.onDriftUp);
    this.driftButton.addEventListener('pointerleave', this.onDriftUp);
    this.nitroButton.addEventListener('pointerdown', this.onNitroDown);
    this.nitroButton.addEventListener('pointerup', this.onNitroUp);
    this.nitroButton.addEventListener('pointercancel', this.onNitroUp);
    this.nitroButton.addEventListener('pointerleave', this.onNitroUp);
    this.itemButton.addEventListener('pointerdown', this.onItemDown);
    this.itemButton.addEventListener('pointerup', this.onItemUp);
    this.itemButton.addEventListener('pointercancel', this.onItemUp);
    this.resetButton.addEventListener('pointerdown', this.onResetDown);
    this.resetButton.addEventListener('pointerup', this.onResetUp);
    this.resetButton.addEventListener('pointercancel', this.onResetUp);
  }

  setMode(mode: DualMode): void {
    this.mode = mode;
  }

  getMode(): DualMode {
    return this.mode;
  }

  readPlayer1(target: RaceInputFrame): RaceInputFrame {
    const b = P1_BINDINGS;
    let throttle = this.anyDown(b.throttle) ? 1 : 0;
    let brake = this.anyDown(b.brake) ? 1 : 0;
    let steer = 0;
    if (this.anyDown(b.left)) steer -= 1;
    if (this.anyDown(b.right)) steer += 1;

    if (this.mode === 'solo') {
      throttle = Math.max(throttle, this.anyDown(['ArrowUp']) ? 1 : 0);
      brake = Math.max(brake, this.anyDown(['ArrowDown']) ? 1 : 0);
      if (this.anyDown(['ArrowLeft'])) steer -= 1;
      if (this.anyDown(['ArrowRight'])) steer += 1;
    }

    throttle = Math.max(throttle, this.stickThrottle);
    brake = Math.max(brake, this.stickBrake);
    if (Math.abs(this.stickSteer) > Math.abs(steer)) steer = this.stickSteer;

    const itemDown = this.anyDown(b.item) || this.touchItemEdge;
    let useItem = false;
    if (itemDown && !this.p1ItemWasDown) useItem = true;
    this.p1ItemWasDown = itemDown;
    if (this.touchItemEdge) this.touchItemEdge = false;

    const resetDown = this.anyDown(['KeyR']) || this.touchResetEdge;
    let reset = false;
    if (resetDown && !this.p1ResetWasDown) reset = true;
    this.p1ResetWasDown = resetDown;
    if (this.touchResetEdge) this.touchResetEdge = false;

    target.throttle = THREE.MathUtils.clamp(throttle, 0, 1);
    target.brake = THREE.MathUtils.clamp(brake, 0, 1);
    target.steer = THREE.MathUtils.clamp(steer, -1, 1);
    target.drift = this.anyDown(b.drift) || this.touchDrift;
    target.nitro = this.anyDown(b.nitro) || this.touchNitro;
    target.useItem = useItem;
    target.reset = reset;
    return target;
  }

  readPlayer2(target: RaceInputFrame): RaceInputFrame {
    if (this.mode !== 'duo') {
      target.throttle = 0;
      target.brake = 0;
      target.steer = 0;
      target.drift = false;
      target.nitro = false;
      target.useItem = false;
      target.reset = false;
      return target;
    }

    const b = P2_BINDINGS;
    let throttle = this.anyDown(b.throttle) ? 1 : 0;
    let brake = this.anyDown(b.brake) ? 1 : 0;
    let steer = 0;
    if (this.anyDown(b.left)) steer -= 1;
    if (this.anyDown(b.right)) steer += 1;

    const itemDown = this.anyDown(b.item);
    let useItem = false;
    if (itemDown && !this.p2ItemWasDown) useItem = true;
    this.p2ItemWasDown = itemDown;

    const resetDown = this.anyDown(['Backslash', 'Backspace']);
    let reset = false;
    if (resetDown && !this.p2ResetWasDown) reset = true;
    this.p2ResetWasDown = resetDown;

    target.throttle = THREE.MathUtils.clamp(throttle, 0, 1);
    target.brake = THREE.MathUtils.clamp(brake, 0, 1);
    target.steer = THREE.MathUtils.clamp(steer, -1, 1);
    target.drift = this.anyDown(b.drift);
    target.nitro = this.anyDown(b.nitro);
    target.useItem = useItem;
    target.reset = reset;
    return target;
  }

  read(target: RaceInputFrame): RaceInputFrame {
    return this.readPlayer1(target);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.stick.removeEventListener('pointerdown', this.onStickDown);
    this.stick.removeEventListener('pointermove', this.onStickMove);
    this.stick.removeEventListener('pointerup', this.onStickUp);
    this.stick.removeEventListener('pointercancel', this.onStickUp);
    this.driftButton.removeEventListener('pointerdown', this.onDriftDown);
    this.driftButton.removeEventListener('pointerup', this.onDriftUp);
    this.driftButton.removeEventListener('pointercancel', this.onDriftUp);
    this.driftButton.removeEventListener('pointerleave', this.onDriftUp);
    this.nitroButton.removeEventListener('pointerdown', this.onNitroDown);
    this.nitroButton.removeEventListener('pointerup', this.onNitroUp);
    this.nitroButton.removeEventListener('pointercancel', this.onNitroUp);
    this.nitroButton.removeEventListener('pointerleave', this.onNitroUp);
    this.itemButton.removeEventListener('pointerdown', this.onItemDown);
    this.itemButton.removeEventListener('pointerup', this.onItemUp);
    this.itemButton.removeEventListener('pointercancel', this.onItemUp);
    this.resetButton.removeEventListener('pointerdown', this.onResetDown);
    this.resetButton.removeEventListener('pointerup', this.onResetUp);
    this.resetButton.removeEventListener('pointercancel', this.onResetUp);
  }

  private anyDown(codes: readonly string[]): boolean {
    return codes.some((code) => this.keys.has(code));
  }

  private updatePointer(clientX: number, clientY: number): void {
    const dx = clientX - this.pointerState.centerX;
    const dy = clientY - this.pointerState.centerY;
    this.pointer.set(dx / this.pointerState.radius, dy / this.pointerState.radius);
    if (this.pointer.lengthSq() > 1) this.pointer.normalize();

    this.stickSteer = this.pointer.x;
    const forward = -this.pointer.y;
    this.stickThrottle = Math.max(0, forward);
    this.stickBrake = Math.max(0, -forward);
    this.updateKnob();
  }

  private updateKnob(): void {
    const distance = 38;
    this.knob.style.transform = `translate(calc(-50% + ${this.pointer.x * distance}px), calc(-50% + ${this.pointer.y * distance}px))`;
  }
}
