import type { config } from '../config.js';
import type { WhisperWorker } from '../scripts/lib/whisper-worker.js';

export type Settings = typeof config;
export type StageId =
  | 'subtitles'
  | 'download'
  | 'chunking'
  | 'demucs'
  | 'vad'
  | 'transcription'
  | 'filtering'
  | 'alignment'
  | 'export'
  | 'translation'
  | 'review';
export type StageStatus =
  'pending' | 'running' | 'completed' | 'skipped' | 'failed' | 'cancelled' | 'interrupted';
export interface StageProgress {
  id: StageId;
  label: string;
  status: StageStatus;
  percentage: number | null;
  completed?: number;
  total?: number;
  unit?: string;
  detail?: string;
  updatedAt?: string;
}
export interface StageUpdate {
  id: StageId;
  status?: StageStatus;
  percentage?: number | null;
  completed?: number;
  total?: number;
  unit?: string;
  detail?: string;
}
export interface Word {
  start: number;
  end: number;
  word: string;
  probability?: number;
  speaker?: string;
  [metadata: string]: any;
}
export interface Segment {
  start: number;
  end: number;
  text: string;
  words?: Word[];
  speaker?: string;
  speakerScope?: string;
  _timing?: string;
  review?: string[];
  translated?: string;
  _sources?: Record<string, any>[];
  _suspicious?: boolean;
  _filterReasons?: string[];
  _filterScore?: number;
  avg_logprob?: number;
  no_speech_prob?: number;
  compression_ratio?: number;
  seek?: number;
  [metadata: string]: any;
}
export interface Chunk {
  id: number | string;
  file: string;
  startTime: number;
  endTime: number;
  speechProfile?: any;
  [metadata: string]: any;
}
export interface PipelineOptions {
  settings?: Partial<Settings>;
  signal?: AbortSignal;
  workDir?: string;
  onLog?: (message: string) => void;
  onWarning?: (message: string) => void | Promise<void>;
  progress?: (progress: number, message: string) => void | Promise<void>;
  onProgress?: (completed: number, total: number) => void | Promise<void>;
  onStage?: (update: StageUpdate) => void | Promise<void>;
  worker?: WhisperWorker;
  resume?: boolean;
  [option: string]: any;
}
export interface Job {
  id: string;
  title: string;
  type: 'audio' | 'video' | 'youtube' | 'translation';
  status: 'queued' | 'processing' | 'paused' | 'interrupted' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  stages?: StageProgress[];
  logs: { time: string; message: string }[];
  createdAt: string;
  settings: Settings;
  input?: string;
  sourceStat?: { size: number; mtimeMs: number };
  youtubeUrl?: string;
  imdbId?: string;
  sourceKey?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
  resume?: boolean;
  error?: string | null;
  result?: any;
  startedAt?: string;
  finishedAt?: string;
  intermediatesRemoved?: boolean;
  submissionKey?: string;
  codexRetry?: boolean;
}
export interface QueueState {
  version: number;
  jobs: Job[];
  processed: Record<string, { filename: string; jobId: string; at: string }>;
  control?: {
    paused: boolean;
    reason: string | null;
    scannerEnabled: boolean;
    updatedAt: string;
  };
}

export interface PipelineResult {
  speakerFile?: string;
  subtitleFile: string;
  subtitleAssFile?: string;
  subtitleStyleReviewFile?: string;
  translatedAssFile?: string;
  translationStyleReviewFile?: string;
  sourceLanguage: string;
  targetLanguage: string;
  reviewFile: string | null;
  usageFile: string | null;
  englishSubtitleFile?: string;
  translationChunks?: { dir: string; jsonFiles: string[]; srtFiles: string[] };
}
