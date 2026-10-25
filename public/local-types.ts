// Small metadata only. The movie itself never belongs in a server-side job.
export interface LocalMedia {
  version: 1;
  name: string;
  size: number;
  fingerprint: string;
  duration: number;
  frameRate: number | null;
  audioStreamIndex: number;
  movieHash?: string;
  requiresLocalScreening?: boolean;
}
export interface LocalWaveform {
  version: 1;
  duration: number;
  binsPerSecond: number;
  peaks: string;
  rms: string;
}
