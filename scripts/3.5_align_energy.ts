import type { Segment } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import { config } from '../config.js';
import { energyProfile, intervalsFromProfile } from './lib/audio.js';
import { alignSegments } from './lib/alignment.js';

export async function alignToSpeechBoundaries(
  audioFile: string,
  segments: Segment[],
  options: PipelineOptions = {},
) {
  const profile = options.profile || (await energyProfile(audioFile, { signal: options.signal }));
  if (!profile.length)
    return segments.map((seg: any) => ({
      ...seg,
      review: [...(seg.review || []), 'empty_energy_profile'],
    }));
  const threshold = 10 ** ((options.noiseThreshold ?? config.SILENCE_THRESHOLD_DB) / 20);
  const intervals = intervalsFromProfile(profile, {
    startThreshold: threshold,
    endThreshold: threshold * 0.7,
    minSilence: options.minSilenceDuration ?? options.minSilence ?? config.MIN_SILENCE_DURATION,
    minSpeech: 0.08,
  });
  return alignSegments(segments, intervals, { ...options, method: 'energy' });
}
