import { lowerBound } from './sorted.js';
import type { Segment } from '../../types/pipeline.js';
import type { Interval } from './audio.js';
import { config } from '../../config.js';
import { addReview } from './srt.js';

export function alignSegments(
  segments: Segment[],
  intervals: Interval[],
  {
    method,
    maxShift = config.ALIGNMENT_MAX_SHIFT_SEC,
    padding = config.ALIGNMENT_PADDING_SEC,
    duration = Infinity,
  }: { method: string; maxShift?: number; padding?: number; duration?: number },
) {
  const starts = intervals.map((s) => s.start),
    ends = intervals.map((s) => s.end);
  starts.sort((a, b) => a - b);
  ends.sort((a, b) => a - b);
  const ordered = [...intervals].sort((a, b) => a.start - b.start);
  const prefixEnd: number[] = [];
  ordered.forEach((interval, index) =>
    prefixEnd.push(Math.max(interval.end, prefixEnd[index - 1] ?? 0)),
  );
  const nearest = (points: number[], value: number) => {
    const index = lowerBound(points, value, (point) => point);
    return [points[index - 1], points[index]]
      .filter((point) => point !== undefined && Math.abs(point - value) <= maxShift)
      .sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0];
  };
  return segments.map((seg) => {
    // Search both directions: early starts and late ends need inward adjustment.
    const start = nearest(starts, seg.start),
      end = nearest(ends, seg.end);
    let candidate = {
      ...seg,
      start: start === undefined ? seg.start : Math.max(0, start - padding),
      end: end === undefined ? seg.end : Math.min(duration, end + padding),
    };
    let coverage = 0;
    for (
      let i = lowerBound(prefixEnd, seg.start, (value) => value);
      i < ordered.length && ordered[i].start < seg.end;
      i++
    ) {
      const interval = ordered[i];
      coverage += Math.max(
        0,
        Math.min(seg.end, interval.end) - Math.max(seg.start, interval.start),
      );
    }
    if (candidate.end - candidate.start < 0.001) {
      candidate = addReview({ ...seg }, 'alignment_conflict');
    }
    if (coverage === 0) candidate = addReview(candidate, 'no_speech_at_cue');
    if (start === undefined || end === undefined)
      candidate = addReview(candidate, 'boundary_unconfirmed');
    return {
      ...candidate,
      _alignment: {
        method,
        originalStart: seg.start,
        originalEnd: seg.end,
        startMatched: start !== undefined,
        endMatched: end !== undefined,
        speechCoverage: coverage / Math.max(0.001, seg.end - seg.start),
      },
    };
  });
}
