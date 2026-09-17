export type GameSettings = {
  muted: boolean;
  difficulty: 'easy' | 'normal' | 'hard';
  carId: string;
};

export type TrackBests = Record<string, number>;

const SETTINGS_KEY = 'neon-rush-settings';
const BESTS_KEY = 'neon-rush-bests';

const defaults: GameSettings = {
  muted: false,
  difficulty: 'normal',
  carId: 'neon-blue',
};

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return {
      muted: !!parsed.muted,
      difficulty:
        parsed.difficulty === 'easy' || parsed.difficulty === 'hard'
          ? parsed.difficulty
          : 'normal',
      carId: typeof parsed.carId === 'string' && parsed.carId ? parsed.carId : defaults.carId,
    };
  } catch {
    return { ...defaults };
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // private mode
  }
}

export function loadBests(): TrackBests {
  try {
    const raw = localStorage.getItem(BESTS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as TrackBests;
  } catch {
    return {};
  }
}

export function saveBest(trackId: string, time: number): boolean {
  const bests = loadBests();
  const prev = bests[trackId];
  if (prev != null && prev <= time) return false;
  bests[trackId] = time;
  try {
    localStorage.setItem(BESTS_KEY, JSON.stringify(bests));
    return true;
  } catch {
    return false;
  }
}

export function getBest(trackId: string): number | null {
  const v = loadBests()[trackId];
  return v == null ? null : v;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const s = Math.floor(seconds % 60)
    .toString()
    .padStart(2, '0');
  const cs = Math.floor((seconds % 1) * 100)
    .toString()
    .padStart(2, '0');
  return `${m}:${s}.${cs}`;
}
