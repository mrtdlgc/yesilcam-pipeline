import type { Segment, Settings } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import { config } from '../config.js';
import { addReview } from './lib/srt.js';
export { parseSrt as srtToSegments, segmentsToSrt } from './lib/srt.js';

function split(segment: Segment, settings: Settings) {
  const duration = segment.end - segment.start;
  if (
    duration <= settings.SUBTITLE_MAX_DURATION_SEC &&
    segment.text.length <= settings.SUBTITLE_MAX_CHARS
  )
    return [segment];
  const textWords = segment.text.trim().split(/\s+/u);
  const timed =
    Array.isArray(segment.words) &&
    segment.words.length === textWords.length &&
    segment.words.every(
      (word: any, i: any, words: any) =>
        Number.isFinite(word.start) &&
        Number.isFinite(word.end) &&
        word.end > word.start &&
        word.start >= segment.start &&
        word.end <= segment.end &&
        (!i || word.start >= words[i - 1].end),
    );
  const words = textWords.map((word: any, index: number) => ({
    word,
    start: timed
      ? segment.words![index].start
      : segment.start + (duration * index) / textWords.length,
    end: timed
      ? segment.words![index].end
      : segment.start + (duration * (index + 1)) / textWords.length,
  }));
  const groups = [];
  let group = [];
  for (const word of words) {
    if (
      group.length &&
      (word.end - group[0].start > settings.SUBTITLE_MAX_DURATION_SEC ||
        [...group, word].map((w) => w.word).join(' ').length > settings.SUBTITLE_MAX_CHARS)
    ) {
      groups.push(group);
      group = [];
    }
    group.push(word);
  }
  if (group.length) groups.push(group);
  return groups.map((group) => {
    let result = {
      ...segment,
      text: group.map((w) => w.word).join(' '),
      start: group[0].start,
      end: group.at(-1)!.end,
      _sourceSpan: { start: segment.start, end: segment.end },
    };
    if (timed)
      result.words = segment.words!.slice(
        words.indexOf(group[0]),
        words.indexOf(group.at(-1)!) + 1,
      );
    else {
      delete result.words;
      result = addReview(result, 'estimated_split_timing');
    }
    if (result.end - result.start > settings.SUBTITLE_MAX_DURATION_SEC && !timed) {
      result.end = result.start + settings.SUBTITLE_MAX_DURATION_SEC;
      result = addReview(result, 'duration_limited');
    }
    return result;
  });
}

export function mergeSegments(segments: Segment[], options: PipelineOptions = {}) {
  const settings = { ...config, ...options.settings };
  const merged: Segment[] = [];
  for (const input of segments) {
    const segment: Segment = { ...input, text: input.text.trim() };
    if (!segment.text) continue;
    const previous = merged.at(-1);
    const gap = previous ? segment.start - previous.end : Infinity;
    if (
      previous &&
      previous.speaker === segment.speaker &&
      previous.speakerScope === segment.speakerScope &&
      gap >= 0 &&
      gap * 1000 <= settings.MERGE_THRESHOLD_MS &&
      segment.end - previous.start <= settings.SUBTITLE_MAX_DURATION_SEC &&
      previous.text.length + segment.text.length + 1 <= settings.SUBTITLE_MAX_CHARS
    ) {
      const sources = [...(previous._sources ?? [inputMetadata(previous)]), inputMetadata(segment)];
      previous.text += ` ${segment.text}`;
      previous.end = segment.end;
      previous._sources = sources;
      previous.review = [...new Set([...(previous.review ?? []), ...(segment.review ?? [])])];
      previous._suspicious ||= segment._suspicious;
      previous._filterReasons = [
        ...new Set([...(previous._filterReasons ?? []), ...(segment._filterReasons ?? [])]),
      ];
      previous._filterScore = Math.max(previous._filterScore ?? 0, segment._filterScore ?? 0);
      if (previous.words && segment.words) previous.words = [...previous.words, ...segment.words];
      else delete previous.words;
    } else merged.push(segment);
  }
  return merged.flatMap((segment) => split(segment, settings));
}

function inputMetadata(segment: Segment) {
  const { _sources, ...metadata } = segment;
  return metadata;
}
