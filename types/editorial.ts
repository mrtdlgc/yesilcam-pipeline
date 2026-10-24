export interface AudioEvent {
  start: number;
  end: number;
  text: string;
  speaker?: string;
  speakerScope?: string;
}

export interface SourceAnchor {
  id: number;
  start: number;
  end: number;
  text: string;
  speaker: string | null;
  scope: string | null;
  unit: 'word' | 'cue';
  origin: string;
  singing: boolean;
  warnings: string[];
}

export interface EditorialSource {
  version: 1;
  sourceHash: string;
  anchors: SourceAnchor[];
  audioEvents: AudioEvent[];
  cuts: number[];
  frameRate: number | null;
  duration: number | null;
  shotDetection?: 'not-run' | 'unavailable' | 'complete';
}

export interface EditorialCue {
  id: string;
  start: number;
  end: number;
  source: string;
  text: string;
  parts: { from: number; to: number; text: string }[];
  kind: 'dialogue' | 'lyric' | 'uncertain';
  songUse?: 'story' | 'background' | 'uncertain';
  song?: string;
  sourceCorrection?: string;
  reason?: string;
  speaker: string;
  omitted: boolean;
  warnings: string[];
}
