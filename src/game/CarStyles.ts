export type CarStyle = {
  id: string;
  name: string;
  desc: string;
  color: string;
  accent: string;
  livery: string;
};

export const CAR_STYLES: CarStyle[] = [
  {
    id: 'neon-blue',
    name: '霓虹蓝翼',
    desc: '均衡 · 经典蓝',
    color: '#2a6cff',
    accent: '#2de2ff',
    livery: '/assets/kart-livery.webp',
  },
  {
    id: 'crimson',
    name: '绯红疾风',
    desc: '进攻 · 热血红',
    color: '#c62828',
    accent: '#ff6b6b',
    livery: '/assets/kart-livery-red.webp',
  },
  {
    id: 'gold',
    name: '鎏金幻影',
    desc: '尊贵 · 黑金',
    color: '#b8860b',
    accent: '#ffd166',
    livery: '/assets/kart-livery-gold.webp',
  },
  {
    id: 'violet',
    name: '幽紫魅影',
    desc: '赛博 · 紫电',
    color: '#6a1b9a',
    accent: '#e040fb',
    livery: '/assets/kart-livery-purple.webp',
  },
];

export function getCarStyle(id: string): CarStyle {
  return CAR_STYLES.find((c) => c.id === id) ?? CAR_STYLES[0];
}
