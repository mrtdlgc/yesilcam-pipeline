import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import type { Job, QueueState } from '../../types/pipeline.js';

export function queueControl(state: QueueState) {
  return (state.control ??= {
    paused: false,
    reason: null,
    scannerEnabled: config.SCANNER_ENABLED,
    updatedAt: new Date().toISOString(),
  });
}

export function pauseQueue(state: QueueState, reason: string) {
  Object.assign(queueControl(state), {
    paused: true,
    reason,
    updatedAt: new Date().toISOString(),
  });
}

export function assertQueueCapacity(state: QueueState, maximum = config.MAX_QUEUED_JOBS) {
  if (state.jobs.filter((job) => job.status === 'queued').length >= maximum)
    throw Object.assign(
      new Error(
        `The queue has reached its ${maximum}-job waiting limit. Let it drain before adding more.`,
      ),
      { status: 429 },
    );
}

export function submissionKey(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Polling must not repeatedly transfer every film's logs, settings and speaker map.
export function jobSummary(job: Job) {
  return {
    id: job.id,
    title: job.title,
    type: job.type,
    localMedia: Boolean(job.localMedia),
    status: job.status,
    progress: job.progress,
    stages: job.stages,
    error: job.error,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    intermediatesRemoved: job.intermediatesRemoved,
    result: job.result,
    logs: job.logs?.slice(-1),
    settings: {
      PAUSE_BEFORE_TRANSCRIPTION: job.settings?.PAUSE_BEFORE_TRANSCRIPTION,
      PAUSE_AFTER_DEMUCS: job.settings?.PAUSE_AFTER_DEMUCS,
    },
  };
}
