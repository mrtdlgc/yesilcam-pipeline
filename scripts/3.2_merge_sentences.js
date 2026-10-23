/**
 * Smart subtitle segmentation
 * - Respects max duration (5 seconds)
 * - Respects max character count (80 chars)
 */

import { config } from '../config.js';

const MAX_DURATION_SEC = 5;      // Max subtitle duration
const MAX_CHARS = 80;            // Max characters per subtitle
const MERGE_GAP_MS = 300;        // Merge if gap < 300ms

/**
 * Smart merge segments with duration and character limits
 */
export function mergeSegments(segments) {
  if (!segments || segments.length === 0) return [];

  const merged = [];
  let current = null;

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;

    if (!current) {
      current = {
        text: text,
        start: seg.start,
        end: seg.end
      };
      continue;
    }

    const gapMs = (seg.start - current.end) * 1000;
    const wouldBeDuration = seg.end - current.start;
    const wouldBeLength = current.text.length + 1 + text.length;

    // Check if we should merge
    const gapSmallEnough = gapMs < MERGE_GAP_MS;
    const durationOk = wouldBeDuration <= MAX_DURATION_SEC;
    const lengthOk = wouldBeLength <= MAX_CHARS;

    if (gapSmallEnough && durationOk && lengthOk) {
      // Merge
      current.text += ' ' + text;
      current.end = seg.end;
    } else {
      // Save current and start new
      merged.push(current);
      current = {
        text: text,
        start: seg.start,
        end: seg.end
      };
    }
  }

  if (current) {
    merged.push(current);
  }

  // Second pass: split any segments that are still too long
  const final = [];
  for (const seg of merged) {
    if (seg.text.length > MAX_CHARS || (seg.end - seg.start) > MAX_DURATION_SEC) {
      const splits = splitLongSegment(seg);
      final.push(...splits);
    } else {
      final.push(seg);
    }
  }

  console.log(`Segmented ${segments.length} → ${final.length} subtitles`);

  return final;
}

/**
 * Split a segment that's too long
 */
function splitLongSegment(seg) {
  const results = [];
  const words = seg.text.split(/\s+/);
  const duration = seg.end - seg.start;
  const wordsPerSecond = words.length / duration;

  let currentWords = [];
  let currentStart = seg.start;

  for (let i = 0; i < words.length; i++) {
    currentWords.push(words[i]);
    const currentText = currentWords.join(' ');

    // Check if we should split here
    const isLastWord = i === words.length - 1;
    const tooLong = currentText.length >= MAX_CHARS * 0.9; // 90% of max
    const endsWithPunctuation = /[.!?,;:]$/.test(words[i]);

    if (isLastWord || tooLong || (endsWithPunctuation && currentWords.length >= 3)) {
      // Estimate timing based on word count
      const wordCount = currentWords.length;
      const estimatedDuration = wordCount / wordsPerSecond;
      const currentEnd = Math.min(currentStart + estimatedDuration, seg.end);

      results.push({
        text: currentText,
        start: currentStart,
        end: currentEnd
      });

      currentStart = currentEnd;
      currentWords = [];
    }
  }

  return results;
}

/**
 * Parse SRT content into segments
 */
export function srtToSegments(srtContent) {
  const segments = [];
  const blocks = srtContent.trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const timeLine = lines[1];
    const text = lines.slice(2).join(' ');

    const timeMatch = timeLine.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
    if (!timeMatch) continue;

    const start = parseInt(timeMatch[1]) * 3600 +
                  parseInt(timeMatch[2]) * 60 +
                  parseInt(timeMatch[3]) +
                  parseInt(timeMatch[4]) / 1000;

    const end = parseInt(timeMatch[5]) * 3600 +
                parseInt(timeMatch[6]) * 60 +
                parseInt(timeMatch[7]) +
                parseInt(timeMatch[8]) / 1000;

    segments.push({ text: text.trim(), start, end });
  }

  return segments;
}

/**
 * Convert segments back to SRT format
 */
export function segmentsToSrt(segments) {
  return segments.map((seg, i) => {
    const start = formatTimestamp(seg.start);
    const end = formatTimestamp(seg.end);
    return `${i + 1}\n${start} --> ${end}\n${seg.text}`;
  }).join('\n\n');
}

function formatTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
