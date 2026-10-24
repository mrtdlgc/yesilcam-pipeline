import type { Chunk, Segment } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import path from 'node:path';
import { config } from '../config.js';
import { at, readJson, writeJson } from './lib/files.js';
import { run, PYTHON } from './lib/process.js';
import { intervalsFromProfile } from './lib/audio.js';
import { alignSegments } from './lib/alignment.js';
import { alignToSpeechBoundaries as alignEnergy } from './3.5_align_energy.js';
import { progressLines } from './lib/progress.js';

export async function checkSileroAlignmentAvailable() {
  try {
    await run(PYTHON, [at('scripts', '3.5_align_silero.py'), '--check'], { timeout: 30000 });
    return true;
  } catch {
    return false;
  }
}
export async function prepareSpeechProfiles(
  chunks: Chunk[],
  workDir: any,
  options: PipelineOptions = {},
) {
  const settings = { ...config, ...options.settings };
  const input = path.join(workDir, 'alignment-input.json');
  await writeJson(input, { chunks });
  const updates = progressLines(async (value) => {
    await options.onStage?.({
      id: 'vad',
      completed: value.completed,
      total: value.total,
      unit: 'chunks',
      detail: value.detail,
    });
  });
  try {
    await run(
      PYTHON,
      [at('scripts', '3.5_align_silero.py'), '--batch', input, '--output', workDir],
      {
        signal: options.signal,
        timeout: settings.MEDIA_TIMEOUT_MS,
        onStderr: (text) => {
          updates.push(text);
          options.onLog?.(text);
        },
        env: { OMP_NUM_THREADS: String(settings.LOCAL_WHISPER_CPU_THREADS || 2) },
      },
    );
    return true;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    await options.onWarning?.(`Silero alignment unavailable: ${error.message}`);
    return false;
  } finally {
    await updates.finish();
  }
}
export async function alignToSpeechBoundaries(
  audioFile: string,
  segments: Segment[],
  options: PipelineOptions = {},
) {
  const settings = { ...config, ...options.settings };
  let profile = options.profile;
  if (!profile && options.profileFile) {
    try {
      profile = (await readJson(options.profileFile)).profile;
    } catch {
      /* explicit fallback below */
    }
  }
  if (!profile?.length) {
    const aligned = await alignEnergy(audioFile, segments, { ...options, profile: undefined });
    return aligned.map((seg: any) => ({
      ...seg,
      review: [...(seg.review || []), 'silero_alignment_fallback'],
    }));
  }
  const threshold = options.threshold ?? settings.SILERO_VAD_THRESHOLD;
  const intervals = intervalsFromProfile(profile, {
    field: 'prob',
    startThreshold: threshold,
    endThreshold: Math.max(0, threshold - 0.2),
    minSpeech: settings.SILERO_MIN_SPEECH_MS / 1000,
    minSilence: settings.SILERO_MIN_SILENCE_MS / 1000,
    hop: 0.032,
  });
  return alignSegments(segments, intervals, { ...options, method: 'silero_vad' });
}
