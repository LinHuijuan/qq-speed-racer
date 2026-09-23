import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';

export type PostPipeline = {
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  /** Solo uses cameraA only; passing cameraB switches to the split-screen pass. */
  setCameras: (cameraA: THREE.PerspectiveCamera, cameraB?: THREE.PerspectiveCamera) => void;
  resize: () => void;
  render: () => void;
  dispose: () => void;
};

/**
 * Renders the scene twice into the same buffer with scissor clipping, so split
 * screen can share the post chain (bloom etc.) instead of bypassing it.
 */
class SplitScreenRenderPass extends Pass {
  private readonly drawingSize = new THREE.Vector2();

  constructor(
    private readonly scene: THREE.Scene,
    public cameraA: THREE.PerspectiveCamera,
    public cameraB: THREE.PerspectiveCamera,
  ) {
    super();
    this.needsSwap = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime?: number,
    maskActive?: boolean,
  ): void {
    void readBuffer;
    void deltaTime;
    void maskActive;

    renderer.getDrawingBufferSize(this.drawingSize);
    const width = Math.max(2, Math.floor(this.drawingSize.x));
    const height = Math.max(1, Math.floor(this.drawingSize.y));
    const half = Math.floor(width / 2);

    const previousAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);

    // Clear the whole target with scissor off, then clip only the draws.
    // Clearing while a scissor rect is active would leave the other half's
    // depth buffer stale.
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.clear(true, true, false);

    renderer.setScissorTest(true);
    renderer.setViewport(0, 0, half, height);
    renderer.setScissor(0, 0, half, height);
    renderer.render(this.scene, this.cameraA);

    renderer.setViewport(half, 0, width - half, height);
    renderer.setScissor(half, 0, width - half, height);
    renderer.render(this.scene, this.cameraB);

    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, width, height);
    renderer.autoClear = previousAutoClear;
  }
}

export function createRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: 'high-performance',
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.98;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

export function createPostPipeline(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
): PostPipeline {
  const composer = new EffectComposer(renderer);

  const singlePass = new RenderPass(scene, camera);
  const splitPass = new SplitScreenRenderPass(scene, camera, camera);
  splitPass.enabled = false;
  composer.addPass(singlePass);
  composer.addPass(splitPass);

  /*
   * Threshold 0.72 / radius 0.42 rather than the previous 0.85 / 0.28. At 0.85
   * almost nothing in a night scene clears the bar, so the neon liveries and
   * emissive trim never bloomed and the whole thing read as flat paint; the
   * wider radius turns what does clear it into a soft halo instead of a tight
   * rim. Strength is left to the caller — Game.ts raises it with speed.
   */
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    0.22,
    0.42,
    0.72,
  );
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  return {
    composer,
    bloom,
    setCameras: (cameraA, cameraB) => {
      singlePass.camera = cameraA;
      splitPass.cameraA = cameraA;
      splitPass.cameraB = cameraB ?? cameraA;
      const split = cameraB != null;
      singlePass.enabled = !split;
      splitPass.enabled = split;
    },
    resize: () => {
      const width = renderer.domElement.clientWidth;
      const height = renderer.domElement.clientHeight;
      const dpr = renderer.getPixelRatio();
      composer.setPixelRatio(dpr);
      composer.setSize(width, height);
      bloom.resolution.set(width * dpr, height * dpr);
    },
    render: () => {
      composer.render();
    },
    dispose: () => {
      composer.dispose();
      bloom.dispose();
    },
  };
}

export function resizeRenderer(
  renderer: THREE.WebGLRenderer,
  camera: THREE.PerspectiveCamera,
  maxDpr = 2,
): boolean {
  const canvas = renderer.domElement;
  const width = Math.max(1, Math.floor(canvas.clientWidth));
  const height = Math.max(1, Math.floor(canvas.clientHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const bufferWidth = Math.floor(width * dpr);
  const bufferHeight = Math.floor(height * dpr);
  const needsResize = canvas.width !== bufferWidth || canvas.height !== bufferHeight;

  if (needsResize) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  return needsResize;
}
