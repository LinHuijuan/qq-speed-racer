import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const cache = new Map<string, THREE.Texture>();

export function loadGameTexture(
  url: string,
  opts: {
    repeat?: [number, number];
    srgb?: boolean;
    wrap?: THREE.Wrapping;
  } = {},
): THREE.Texture {
  const key = `${url}|${opts.repeat?.join('x') ?? ''}|${opts.wrap ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;

  // 将根绝对路径（/assets/...）转为相对 base，兼容 GitHub Pages 子路径
  const resolvedUrl = url.replace(/^\//, import.meta.env.BASE_URL);
  const tex = loader.load(resolvedUrl);
  tex.colorSpace = opts.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
  if (opts.wrap) {
    tex.wrapS = opts.wrap;
    tex.wrapT = opts.wrap;
  } else {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
  }
  if (opts.repeat) tex.repeat.set(opts.repeat[0], opts.repeat[1]);
  tex.anisotropy = 8;
  cache.set(key, tex);
  return tex;
}
