import type { Job, StageId, StageProgress, StageUpdate } from '../../types/pipeline.js';
import { fullMovie } from './transcription-mode.js';

const labels: Record<StageId, string> = {
  subtitles: 'Existing subtitle search',
  download: 'Source download',
  chunking: 'Lossless audio chunks',
  demucs: 'Demucs vocal separation',
  vad: 'Speech detection',
  transcription: 'ASR transcription',
  filtering: 'Cue filtering & splitting',
  alignment: 'Speech alignment',
  export: 'Subtitle export',
  translation: 'Subtitle translation',
  review: 'Prepare screening',
};
export function createStages(job: Pick<Job, 'type' | 'settings'>): StageProgress[] {
  const movie = fullMovie(job.settings);
  const ids = (Object.keys(labels) as StageId[]).filter(
    (id) =>
      (job.type !== 'translation' || ['translation', 'review'].includes(id)) &&
      (id !== 'demucs' || job.settings.DEMUCS_ENABLED),
  );
  return ids.map((id) => {
    const skipped =
      (id === 'review' && job.settings.PREPARE_REVIEW === false) ||
      (id === 'download' && job.type !== 'youtube') ||
      (id === 'demucs' && !job.settings.DEMUCS_ENABLED) ||
      (id === 'vad' &&
        (movie ||
          (!job.settings.SILERO_VAD_ENABLED &&
            !(job.settings.ALIGN_TO_SPEECH && job.settings.ALIGNMENT_METHOD === 'silero')))) ||
      (id === 'alignment' && (movie || !job.settings.ALIGN_TO_SPEECH)) ||
      (id === 'translation' && job.type !== 'translation' && !job.settings.TRANSLATION_ENABLED);
    return {
      id,
      label:
        movie && id === 'chunking'
          ? 'Continuous movie audio'
          : movie && id === 'transcription'
            ? 'Full-movie Scribe transcription'
            : labels[id],
      status: skipped ? 'skipped' : 'pending',
      percentage: null,
      ...(skipped
        ? {
            detail:
              id === 'download'
                ? 'Using the supplied local file'
                : movie && ['vad', 'alignment'].includes(id)
                  ? 'Using Scribe word timestamps; no local model'
                  : 'Not enabled for this job',
          }
        : {}),
    };
  });
}
export function applyStage(stages: StageProgress[], update: StageUpdate) {
  const stage = stages.find((s) => s.id === update.id);
  if (!stage) return;
  if (
    update.completed !== undefined &&
    (!Number.isFinite(update.completed) || update.completed < 0)
  )
    throw new Error('Invalid stage count');
  if (update.total !== undefined && (!Number.isFinite(update.total) || update.total <= 0))
    throw new Error('Invalid stage total');
  if (
    update.percentage !== undefined &&
    update.percentage !== null &&
    !Number.isFinite(update.percentage)
  )
    throw new Error('Invalid stage percentage');
  const state = update.status ?? 'running';
  Object.assign(stage, update, { status: state, updatedAt: new Date().toISOString() });
  if (state === 'completed') stage.percentage = 100;
  else if (state === 'skipped') stage.percentage = null;
  else if (update.percentage !== undefined)
    stage.percentage =
      update.percentage === null ? null : Math.max(0, Math.min(100, update.percentage));
  else if (stage.total !== undefined && stage.completed !== undefined)
    stage.percentage = Math.max(0, Math.min(100, (stage.completed / stage.total) * 100));
  if (stage.detail) stage.detail = stage.detail.slice(0, 500);
}
export function stopStages(
  stages: StageProgress[] | undefined,
  status: 'failed' | 'cancelled' | 'interrupted',
) {
  for (const stage of stages ?? [])
    if (stage.status === 'running') {
      stage.status = status;
      stage.updatedAt = new Date().toISOString();
    }
}

// Worker messages can cross pipe boundaries. Serialize asynchronous persistence
// and drain it before declaring the stage finished; ordinary logs are ignored.
export function progressLines(
  onValue: (value: Record<string, any>) => void | Promise<void>,
  prefix = 'YESILCAM_PROGRESS ',
) {
  let buffer = '',
    pending = Promise.resolve();
  const line = (text: string) => {
    if (!text.startsWith(prefix)) return;
    const value = JSON.parse(text.slice(prefix.length));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid worker progress');
    pending = pending.then(() => onValue(value));
    void pending.catch(() => {});
  };
  return {
    push(text: string) {
      buffer += text;
      let end: number;
      while ((end = buffer.search(/[\r\n]/)) >= 0) {
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 65536) throw new Error('Worker progress line is too long');
    },
    async finish() {
      if (buffer) line(buffer);
      buffer = '';
      await pending;
    },
  };
}

export function downloadProgress(value: Record<string, any>): StageUpdate {
  const done = Number(value.downloaded_bytes),
    exact = Number(value.total_bytes);
  const total = Number.isFinite(exact) && exact > 0 ? exact : Number(value.total_bytes_estimate);
  const measured = Number.isFinite(done) && done >= 0 && Number.isFinite(total) && total > 0;
  return {
    id: 'download',
    status: 'running',
    ...(measured
      ? { completed: done, total, unit: 'bytes', percentage: Math.min(100, (done / total) * 100) }
      : { percentage: null }),
    detail:
      value.status === 'finished'
        ? 'Download received; checking the audio file'
        : exact > 0
          ? 'Downloading source audio'
          : measured
            ? 'Downloading source audio (total size is estimated)'
            : 'Downloading source audio; total size is not available',
  };
}

// Recovery after a restart must still stop for review. Only resuming an actual
// review pause grants permission to proceed to speech detection and ASR.
export function needsAudioReview(
  manifest: {
    stage: string;
    settings: { PAUSE_BEFORE_TRANSCRIPTION?: boolean; PAUSE_AFTER_DEMUCS?: boolean };
  },
  resume = false,
) {
  return Boolean(
    (manifest.settings.PAUSE_BEFORE_TRANSCRIPTION || manifest.settings.PAUSE_AFTER_DEMUCS) &&
    (['prepared', 'separated'].includes(manifest.stage) ||
      (manifest.stage === 'paused' && !resume)),
  );
}
