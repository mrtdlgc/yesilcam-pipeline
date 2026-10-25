import type { config } from '../config.js';
import type { WhisperWorker } from '../scripts/lib/whisper-worker.js';
import type { LocalMedia } from '../public/local-types.js';

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
  speakerScope?: string;
  review?: string[];
  _timing?: string;
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
  id?: string | number;
  startTime?: string;
  endTime?: string;
  _chunkId?: string | number;
  _filmOffset?: number;
  _sourceSpan?: { start: number; end: number };
  _alignment?: Record<string, unknown>;
}
export interface Chunk {
  id: number | string;
  file: string;
  startTime: number;
  endTime: number;
  speechProfile?: { time: number; prob: number }[];
  profileFile?: string;
  audioStat?: { size: number; mtimeMs: number };
  _review?: string[];
  _original_file?: string;
  hasSpeech?: boolean | null;
  audioFormat?: string;
}
export interface PipelineOptions {
  movie?: { hash: string; size: number };
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
  checkpoint?: string;
  receiptDir?: string;
  retryCodex?: boolean;
  sourceLanguage?: string;
  targetLanguage?: string;
  input?: string;
  includeVideo?: boolean;
  returnChunks?: boolean;
  profileFile?: string;
  dropThreshold?: number;
  markThreshold?: number;
  fftReportPath?: string | null;
  speakers?: ReturnType<typeof import('../scripts/lib/speakers.js').speakerContext>;
  duration?: number;
  maxShift?: number;
  padding?: number;
  profile?: ({ time: number } & Record<string, number>)[];
  noiseThreshold?: number;
  minSilenceDuration?: number;
  minSilence?: number;
  threshold?: number;
}
export interface Job {
  localMedia?: LocalMedia;
  localSubtitle?: {
    file: string;
    hash: string;
    language: string;
    source: string;
    title?: string;
    streamIndex?: number;
  };
  pathSchema?: 1;
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
  existingSubtitleFile?: string;
  embeddedSubtitleReportFile?: string;
  subtitleOrigin?: {
    source: string;
    language: string;
    streamIndex?: number;
    title?: string;
    codec?: string;
  };
  speakerFile?: string;
  editorialSourceFile?: string;
  reviewSourceFile?: string;
  reviewTargetFile?: string;
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
