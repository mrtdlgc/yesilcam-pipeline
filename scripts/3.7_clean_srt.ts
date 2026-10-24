import type { Segment } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import { config } from '../config.js';
import { addReview, validateSegments } from './lib/srt.js';
export { segmentsToSrt } from './lib/srt.js';

export function cleanSegments(segments: Segment[], options: PipelineOptions = {}) {
  const settings = { ...config, ...options.settings };
  const result = segments
    .map((segment: Segment) => ({
      ...segment,
      text: segment.text.trim(),
      start: Math.max(0, Math.round(segment.start * 1000)),
      end: Math.round(segment.end * 1000),
    }))
    .filter((segment: Segment) => segment.text)
    .sort((a: any, b: any) => a.start - b.start || a.end - b.end);
  for (let index = 0; index < result.length; index++) {
    let segment = result[index];
    if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)) {
      throw new Error('Cannot export invalid subtitle timing; inspect raw transcription');
    }
    if (segment.end <= segment.start)
      segment = addReview({ ...segment, end: segment.start + 1 }, 'timestamp_repaired');
    const previous = result[index - 1];
    if (previous && previous.end > segment.start) {
      // Split the overlap once, never stretch later cues and create a second overlap.
      const earliest = previous.start + 1,
        latest = segment.end - 1;
      if (earliest > latest) {
        segment.end = earliest + 1;
        segment = addReview(segment, 'timestamp_repaired');
      }
      const boundary = Math.min(
        Math.max(latest, earliest),
        Math.max(earliest, Math.round((previous.end + segment.start) / 2)),
      );
      previous.end = boundary;
      segment.start = boundary;
      result[index - 1] = addReview(previous, 'overlap_repaired');
      segment = addReview(segment, 'overlap_repaired');
    }
    if (segment.end - segment.start > settings.SUBTITLE_MAX_DURATION_SEC * 1000) {
      if (segment.words?.length && segment._timing === 'native_word') {
        segment = addReview(segment, 'duration_exceeds_limit');
      } else {
        segment.end = segment.start + settings.SUBTITLE_MAX_DURATION_SEC * 1000;
        segment = addReview(segment, 'duration_limited');
      }
    }
    result[index] = segment;
  }
  const seconds = result.map((segment: Segment) => {
    let cue = { ...segment, start: segment.start / 1000, end: segment.end / 1000 };
    if (
      cue.text.length > settings.SUBTITLE_MAX_CHARS ||
      cue.text.length / (cue.end - cue.start) > settings.SUBTITLE_MAX_CHARS_PER_SEC
    ) {
      cue = addReview(cue, 'reading_speed');
    }
    return cue;
  });
  validateSegments(seconds);
  return seconds;
}
