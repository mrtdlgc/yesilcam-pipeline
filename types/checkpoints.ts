import type { Chunk, Job, PipelineResult, Settings } from './pipeline.js';

export interface Cost {
  amount: number | null;
  currency: string;
  seconds: number;
  billedSeconds?: number;
  perMinute?: number | null;
}
export interface RequestState {
  version: 1;
  identity: string;
  chunkId: string | number;
  provider: string;
  model: string;
  status: 'prepared' | 'submitting' | 'accepted' | 'complete' | 'rejected' | 'uncertain';
  estimate: Cost;
  attempts: number;
  createdAt: string;
  submittedAt?: string;
  requestId?: string;
  remoteId?: string;
  uploadUrl?: string;
  // Vendor payloads stay raw; normalize() validates their structure before use.
  result?: Record<string, unknown>;
  submissionResponse?: Record<string, unknown> | null;
  error?: string | null;
  elapsedMs?: number;
  reportedCost?: { amount: number; currency: string } | null;
  usageCostEstimate?: { amount: number; currency: string } | null;
  usage?: unknown;
  reconciliation?: { at: string; note: string; newAttemptAuthorized: boolean };
}
export interface CodexReceipt {
  signature: string;
  completed: boolean;
  status: 'running' | 'failed' | 'complete';
  failurePhase?: 'execution' | 'validation';
  model: string;
  cliVersion?: string | null;
  turnFailed?: boolean;
  turnCompleted?: boolean;
  outputHash?: string;
  usage?: unknown;
}
export interface Manifest {
  version: 1;
  pathSchema?: 1;
  id: string;
  title: string;
  type: Job['type'];
  input?: string;
  youtubeUrl?: string;
  imdbId?: string;
  sourceStat?: Job['sourceStat'];
  settings: Settings;
  audioInput?: string;
  stage: string;
  warnings: string[];
  chunks?: Chunk[];
  originalChunks?: Chunk[];
  lookedUp?: boolean;
  existingSource?: string;
  partialResult?: PipelineResult;
  result?: PipelineResult;
}
