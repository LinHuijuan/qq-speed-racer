export type CarStyle = {
  id: string;
  name: string;
  desc: string;
  color: string;
  accent: string;
  livery: string;
  /**
   * Per-livery dressing. One shared kart model, four distinct characters:
   * the values below are what stop the four cars from being the same mesh
   * in different paint.
   */
  /** Wheel glow-ring and ground-pool hue. */
  rimGlow: string;
  /** LED / underbody strip intensity — aggressive liveries run hotter. */
  stripIntensity: number;
  /** Clearcoat sheen on the paint. */
  gloss: number;
  /** Canopy tint; darker for the "stealth" liveries. */
  canopyTint: string;
};

export const CAR_STYLES: CarStyle[] = [
  {
    id: 'neon-blue',
    name: '霓虹蓝翼',
    desc: '均衡 · 经典蓝',
    color: '#2a6cff',
    accent: '#2de2ff',
    livery: '/assets/kart-livery.webp',
    rimGlow: '#2de2ff',
    stripIntensity: 1.2,
    gloss: 0.9,
    canopyTint: '#1e4257',
  },
  {
    id: 'crimson',
    name: '绯红疾风',
    desc: '进攻 · 热血红',
    color: '#c62828',
    accent: '#ff6b6b',
    livery: '/assets/kart-livery-red.webp',
    rimGlow: '#ff5c5c',
    stripIntensity: 1.35,
    gloss: 1.0,
    canopyTint: '#3a1420',
  },
  {
    id: 'gold',
    name: '鎏金幻影',
    desc: '尊贵 · 黑金',
    color: '#b8860b',
    accent: '#ffd166',
    livery: '/assets/kart-livery-gold.webp',
    rimGlow: '#ffd166',
    stripIntensity: 1.1,
    gloss: 1.1,
    canopyTint: '#2b2410',
  },
  {
    id: 'violet',
    name: '幽紫魅影',
    desc: '赛博 · 紫电',
    color: '#6a1b9a',
    accent: '#e040fb',
    livery: '/assets/kart-livery-purple.webp',
    rimGlow: '#e040fb',
    stripIntensity: 1.3,
    gloss: 0.95,
    canopyTint: '#241238',
  },
];

export function getCarStyle(id: string): CarStyle {
  return CAR_STYLES.find((c) => c.id === id) ?? CAR_STYLES[0];
}
