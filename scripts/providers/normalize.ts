import type { Segment, Word } from '../../types/pipeline.js';
import type { NormalizedTranscript } from '../../types/providers.js';
import type { Interval } from '../lib/audio.js';
import type { Settings } from '../../types/pipeline.js';
import { readJson } from '../lib/files.js';
import { intervalsFromProfile } from '../lib/audio.js';
import { fullMovie, scribeDiarization } from '../lib/transcription-mode.js';

const join = (words: any) =>
  words
    .map((w: any) => w.word)
    .join(' ')
    .replace(/\s+([,.;:!?…])/gu, '$1')
    .trim();
export function segmentsFromWords(words: any, timing = 'native_word', duration = Infinity) {
  const segments: Segment[] = [];
  let current: Word[] = [];
  const flush = () => {
    if (!current.length) return;
    let start = current[0].start,
      end = Math.max(...current.map((w) => w.end));
    const review = [...new Set(current.flatMap((w) => w.review ?? []))] as string[];
    // Retain the native zero-duration word; only its display cue gets a flagged
    // 1 ms interval if no neighboring words provide a usable interval.
    if (end <= start) {
      end = Math.min(duration, start + 0.001);
      if (end <= start) start = Math.max(0, end - 0.001);
      review.push('estimated_zero_duration_cue');
    }
    segments.push({
      start,
      end,
      text: join(current),
      words: current,
      _timing: timing,
      ...(current[0].speaker !== undefined
        ? { speaker: current[0].speaker, speakerScope: current[0].speakerScope }
        : {}),
      review: [
        ...review,
        ...(timing.startsWith('estimated') ? ['estimated_timing_manual_review'] : []),
      ],
    });
    current = [];
  };
  for (const word of words) {
    if (
      current.length &&
      (word.end - current[0].start > 5 ||
        join([...current, word]).length > 80 ||
        word.start - current.at(-1)!.end > 0.7 ||
        word.speaker !== current.at(-1)!.speaker ||
        word.speakerScope !== current.at(-1)!.speakerScope)
    )
      flush();
    current.push(word);
    if (/[.!?…]["'”’»)]?$/u.test(word.word)) flush();
  }
  flush();
  return segments;
}

async function approximate(text: string, chunk: any, settings: Settings) {
  const duration = chunk.endTime - chunk.startTime;
  let intervals: Interval[] = [];
  if (chunk.profileFile) {
    const profile = await readJson(chunk.profileFile, null);
    if (profile?.profile?.length)
      intervals = intervalsFromProfile(profile.profile, {
        field: 'prob',
        startThreshold: settings.SILERO_VAD_THRESHOLD,
        endThreshold: Math.max(0, settings.SILERO_VAD_THRESHOLD - 0.2),
        minSpeech: settings.SILERO_MIN_SPEECH_MS / 1000,
        minSilence: settings.SILERO_MIN_SILENCE_MS / 1000,
        hop: 0.032,
      })
        .map((i) => ({ start: Math.max(0, i.start), end: Math.min(duration, i.end) }))
        .filter((i) => i.end > i.start);
  }
  const timing = intervals.length
    ? 'estimated_speech_distribution'
    : 'estimated_chunk_distribution';
  if (!intervals.length) intervals = [{ start: 0, end: duration }];
  const tokens = text.trim().split(/\s+/u).filter(Boolean);
  const totalWeight = tokens.reduce((n: any, t: any) => n + Math.max(1, [...t].length), 0);
  const available = intervals.reduce((n, i) => n + i.end - i.start, 0);
  const position = (offset: number, end = false) => {
    for (const i of intervals) {
      const length = i.end - i.start;
      if (offset < length || (end && offset <= length)) return i.start + offset;
      offset -= length;
    }
    return intervals.at(-1)!.end;
  };
  let weight = 0;
  const words = tokens.map((word: any) => {
    const start = position((weight / totalWeight) * available);
    weight += Math.max(1, [...word].length);
    return {
      word,
      start,
      end: position((weight / totalWeight) * available, true),
      _timing: timing,
    };
  });
  return segmentsFromWords(words, timing);
}

export async function normalize(
  result: any,
  chunk: any,
  settings: Settings,
  selected: any,
): Promise<NormalizedTranscript> {
  const duration = chunk.endTime - chunk.startTime;
  const scribe =
    (selected.model.id === 'scribe_v2' && selected.provider.id === 'elevenlabs') ||
    (selected.model.id === 'elevenlabs/scribe-v2' && selected.provider.id === 'openrouter');
  if (typeof result.text !== 'string')
    throw new Error('Provider returned no transcript text; retained response needs inspection');
  let segments;
  const words = result.words
    ?.filter((w: any) => typeof (w.word ?? w.text) === 'string' && (w.word ?? w.text).trim())
    .map((w: any) => {
      const id = w.speaker ?? w.speaker_id;
      const speaker =
        (typeof id === 'string' && id.length <= 100) ||
        (typeof id === 'number' && Number.isFinite(id))
          ? String(id)
          : undefined;
      return {
        ...w,
        word: (w.word ?? w.text).trim(),
        speaker,
        speakerScope:
          speaker === undefined ? undefined : fullMovie(settings) ? 'movie' : `chunk_${chunk.id}`,
      };
    });
  if (words?.length) {
    // Invalid native timestamps are evidence, not permission to silently charge
    // for a second inference or to replace them with invented alignment.
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (
        !Number.isFinite(w.start) ||
        !Number.isFinite(w.end) ||
        w.start < 0 ||
        (scribe ? w.end < w.start : w.end <= w.start) ||
        w.end > duration + 0.25 ||
        (i > 0 && w.start < words[i - 1].start)
      )
        throw new Error('Provider returned invalid word timestamps');
      w.end = Math.min(w.end, duration);
      if (w.end < w.start || (!scribe && w.end === w.start))
        throw new Error('Word exceeds chunk duration');
      if (scribe)
        w.review = [
          ...(w.end === w.start ? ['zero_duration_word'] : []),
          ...(w.end - w.start > 2 ? ['unusually_long_word'] : []),
          ...(scribeDiarization(settings) && w.speaker === undefined
            ? ['speaker_label_missing']
            : []),
        ];
    }
  }
  if (scribe && words?.length) {
    // A provider can wrap a whole movie in one segment. Preserve actual word
    // boundaries and speaker turns instead of splitting that wrapper by length.
    segments = segmentsFromWords(words, 'native_word', duration);
  } else if (result.segments?.length) {
    // Preserve genuine Whisper diagnostics for the existing audio-aware
    // hallucination filter. Other vendors do not get fabricated logprobs.
    segments = result.segments.map((s: any) => ({
      ...s,
      _timing: 'native_segment',
      ...(words?.length
        ? { words: words.filter((w: any) => w.start >= s.start && w.end <= s.end) }
        : {}),
    }));
  } else if (words?.length) {
    segments = segmentsFromWords(words);
  } else {
    segments = result.text.trim() ? await approximate(result.text, chunk, settings) : [];
  }
  return {
    text: result.text,
    segments,
    language: result.language,
    _usage: result.usage ?? null,
    _runtime: {
      backend: selected.provider.id,
      model: selected.model.id,
      returnedModel: result.model ?? null,
      timing: [...new Set(segments.map((s: any) => s._timing))],
    },
  };
}
