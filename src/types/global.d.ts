export {};

type TestStateName = 'menu' | 'active-play' | 'complete';

declare global {
  interface Window {
    __THREE_GAME_TEST_HOOKS__?: {
      seed: (value: number) => void;
      setMode?: (mode: string) => { mode: string };
      setTrack?: (id: string) => { track: string };
      forceRace?: () => { phase: string; mode: string };
      setState: (name: string) => { state: string };
      setPausedForScreenshot: (paused: boolean) => void;
      setReducedMotion: (enabled: boolean) => void;
      hideDebugUi: (hidden: boolean) => void;
    };
    __THREE_GAME_DIAGNOSTICS__?: {
      frame: number;
      elapsed: number;
      raceTime?: number;
      phase?: string;
      mode?: string;
      track?: string;
      lap?: number;
      rank?: number;
      bestLap?: number | null;
      complete?: boolean;
      score?: number;
      targetScore?: number;
      player?: {
        position: { x: number; y: number; z: number };
        speed: number;
        heading?: number;
        nitro?: number;
        progress?: number;
        totalProgress?: number;
        drifting?: boolean;
        boosting?: boolean;
        offTrack?: boolean;
      };
      player2?: {
        position: { x: number; y: number; z: number };
        speed: number;
        nitro?: number;
        progress?: number;
      };
      renderer?: {
        calls: number;
        triangles: number;
        geometries: number;
        textures: number;
      };
      canvas?: {
        clientWidth: number;
        clientHeight: number;
        width: number;
        height: number;
        dpr: number;
      };
    };
  }
}

export type { TestStateName };
