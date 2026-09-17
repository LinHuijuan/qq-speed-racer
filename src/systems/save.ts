export type KartSave = {
  x: number;
  y: number;
  z: number;
  heading: number;
  speed: number;
  progress: number;
  totalProgress: number;
  lap: number;
  nitro: number;
  item: string | null;
  finished: boolean;
  finishTime: number;
};

export type RaceSave = {
  v: 1;
  mode: 'solo' | 'duo';
  trackId: string;
  phase: 'countdown' | 'racing';
  raceTime: number;
  countdownTimer: number;
  currentLapStart: number;
  bestLap: number | null;
  lapTimes: number[];
  player1: KartSave;
  player2: KartSave | null;
  ais: KartSave[];
  savedAt: number;
};

const SAVE_KEY = 'neon-rush-race-save';

export function saveRace(data: RaceSave): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  } catch {
    // ignore quota / private mode
  }
}

export function loadRace(): RaceSave | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RaceSave;
    if (parsed?.v !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearRaceSave(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch {
    // ignore
  }
}
