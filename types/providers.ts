import type { Settings, Segment } from './pipeline.js';
export interface TranscriptionModel {
  id: string;
  perMinute: number | null;
  currency: string;
  timing: 'word' | 'segment' | 'estimated';
  minimumSeconds?: number;
  quantumSeconds?: number;
  autoPerMinute?: number;
  approximate?: boolean;
  overridden?: boolean;
  name?: string;
  note?: string;
  preview?: boolean;
  deprecated?: string;
  languages?: string[];
  inputPerMillion?: number;
  outputPerMillion?: number;
}
export interface Provider {
  id: string;
  name: string;
  key: string | null;
  defaultModel: string;
  billing: string;
  source?: string;
  models: TranscriptionModel[];
}
export interface Selection {
  provider: Provider;
  model: TranscriptionModel;
}
export interface CloudContext {
  key?: string;
  endpoint?: string;
  region: string;
  audio: Buffer<ArrayBuffer>;
  audioFile?: Blob;
  mime: string;
  format: string;
  language: string;
  prompt: string | null;
  selected: Selection;
  settings: Settings;
  signal: AbortSignal;
  // Raw vendor responses and checkpoints retain vendor-specific fields.
  state: Record<string, any>;
  save: (patch: Record<string, unknown>) => Promise<void>;
  request: (url: string, init?: RequestInit) => Promise<any>;
  submit: (url: string, init: RequestInit) => Promise<any>;
}
export interface NormalizedTranscript {
  text: string;
  language?: string;
  segments: Segment[];
  [metadata: string]: any;
}
