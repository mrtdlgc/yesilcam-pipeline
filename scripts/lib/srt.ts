import type { Segment } from '../../types/pipeline.js';
export function formatTimestamp(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('Invalid subtitle timestamp');
  const ms = Math.round(seconds * 1000);
  if (!Number.isSafeInteger(ms)) throw new Error('Subtitle timestamp is out of range');
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
export function parseTime(value: string) {
  const match = String(value).match(/^(\d{2,}):([0-5]\d):([0-5]\d)[,.](\d{3})$/);
  if (!match) throw new Error(`Invalid SRT timestamp: ${value}`);
  const seconds =
    Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
  if (!Number.isFinite(seconds) || !Number.isSafeInteger(Math.round(seconds * 1000)))
    throw new Error('Subtitle timestamp is out of range');
  return seconds;
}
export function parseSrt(content: string) {
  const normalized = String(content)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return [];
  const entries = normalized.split(/\n(?:[ \t]*\n)+/).map((block, index) => {
    const lines = block.split('\n');
    const id = lines[0].trim();
    const match = lines[1]
      ?.trim()
      .match(/^(\d{2,}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2,}:\d{2}:\d{2}[,.]\d{3})$/);
    if (
      !/^\d+$/.test(id) ||
      !Number.isSafeInteger(Number(id)) ||
      Number(id) < 1 ||
      !match ||
      lines.length < 3
    )
      throw new Error(`Malformed SRT cue ${index + 1}`);
    const start = parseTime(match[1]),
      end = parseTime(match[2]);
    const text = lines.slice(2).join('\n').trim();
    if (end <= start || !text) throw new Error(`Empty or invalid SRT cue ${id}`);
    return { id, start, end, startTime: match[1], endTime: match[2], text };
  });
  if (new Set(entries.map((e) => e.id)).size !== entries.length)
    throw new Error('Duplicate SRT cue IDs');
  return entries;
}
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
