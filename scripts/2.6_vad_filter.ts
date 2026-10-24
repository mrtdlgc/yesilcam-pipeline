import type { Chunk } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import { config } from '../config.js';
import { readJson } from './lib/files.js';
import { intervalsFromProfile } from './lib/audio.js';
import { checkSileroAlignmentAvailable } from './3.5_align_silero.js';

// Profiles are generated AFTER Demucs and reused for alignment. Default policy
// keeps uncertain chunks: a quiet one-second line must not be lost to a ratio gate.
export async function filterWithSileroVAD(chunks: Chunk[], id: any, options: PipelineOptions = {}) {
  const settings = { ...config, ...options.settings };
  const kept = [],
    discarded: Chunk[] = [];
  for (const chunk of chunks) {
    if (!settings.SILERO_VAD_ENABLED) {
      kept.push(chunk);
      continue;
    }
    const data = chunk.profileFile ? await readJson(chunk.profileFile, null) : null;
    if (!data) {
      kept.push({ ...chunk, _review: [...(chunk._review ?? []), 'vad_unavailable'] });
      continue;
    }
    const intervals = intervalsFromProfile(data.profile, {
      field: 'prob',
      startThreshold: settings.SILERO_VAD_THRESHOLD,
      endThreshold: Math.max(0, settings.SILERO_VAD_THRESHOLD - 0.2),
      minSpeech: settings.SILERO_MIN_SPEECH_MS / 1000,
      minSilence: settings.SILERO_MIN_SILENCE_MS / 1000,
      hop: 0.032,
    });
    const speechDuration = intervals.reduce(
      (sum, interval) => sum + interval.end - interval.start,
      0,
    );
    const ratio = speechDuration / data.duration;
    const uncertain = !intervals.length || ratio < settings.SILERO_MIN_SPEECH_RATIO;
    const annotated = {
      ...chunk,
      hasSpeech: Boolean(intervals.length),
      speechRatio: ratio,
      _review: [...(chunk._review ?? []), ...(uncertain ? ['vad_low_speech'] : [])],
    };
    (uncertain && settings.SILERO_DROP_NON_SPEECH ? discarded : kept).push(annotated);
  }
  return {
    kept,
    discarded,
    stats: {
      total_chunks: chunks.length,
      kept_count: kept.length,
      discarded_count: discarded.length,
    },
  };
}
