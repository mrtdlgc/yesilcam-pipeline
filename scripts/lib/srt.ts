import type { Segment } from '../../types/pipeline.js';
export function formatTimestamp(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid subtitle timestamp');
  const ms = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(ms)) throw new Error('Subtitle timestamp is out of range');
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
import { parseSrt, parseTime } from '../../public/subtitle-text.js';
export { parseSrt, parseTime } from '../../public/subtitle-text.js';
export function validateSegments<T extends Segment>(segments: T[], { allowOverlap = false } = {}) {
  let previousEnd = 0;
  for (const seg of segments) {
    if (
      !Number.isFinite(seg.start) ||
      !Number.isFinite(seg.end) ||
      seg.start < 0 ||
      Math.round(seg.end * 1000) <= Math.round(seg.start * 1000) ||
      !String(seg.text || '').trim()
    ) {
      throw new Error('Invalid or empty subtitle segment');
    }
    if (!allowOverlap && Math.round(seg.start * 1000) < Math.round(previousEnd * 1000))
      throw new Error('Overlapping subtitle segments');
    previousEnd = seg.end;
  }
  return segments;
}
export function segmentsToSrt(
  segments: Segment[],
  { preserveIds = false, preserveTimestamps = false } = {},
) {
  validateSegments(segments, { allowOverlap: preserveTimestamps });
  return (
    segments
      .map(
        (seg, i) =>
          `${preserveIds ? seg.id : i + 1}\n${preserveTimestamps && seg.startTime ? seg.startTime : formatTimestamp(seg.start)} --> ${preserveTimestamps && seg.endTime ? seg.endTime : formatTimestamp(seg.end)}\n${String(seg.text).trim()}`,
      )
      .join('\n\n') + '\n'
  );
}
export function addReview<T extends Segment>(segment: T, reason: string) {
  return { ...segment, review: [...new Set([...(segment.review || []), reason])] };
}
