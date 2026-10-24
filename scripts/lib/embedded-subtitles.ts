import fs from 'node:fs/promises';
import { config } from '../../config.js';
import type { PipelineOptions } from '../../types/pipeline.js';
import { checkAbort, probe, run } from './process.js';
import { MAX_SUBTITLE_BYTES, subtitleDocument } from './codex-translation.js';

const aliases: Record<string, string> = {};
for (const group of [
  'en eng',
  'tr tur',
  'uk ukr',
  'ru rus',
  'de deu ger',
  'fr fra fre',
  'es spa',
  'it ita',
  'ar ara',
  'fa fas per',
  'el ell gre',
  'nl nld dut',
  'pt por',
  'pl pol',
  'ro ron rum',
  'zh zho chi',
  'ja jpn',
  'ko kor',
  'hi hin',
  'he heb',
  'cs ces cze',
  'sv swe',
  'da dan',
  'no nor nob nno nb nn',
  'fi fin',
  'hu hun',
  'bg bul',
  'sr srp',
  'hr hrv',
  'sk slk slo',
  'th tha',
  'vi vie',
  'id ind',
  'ms msa may',
  'ca cat',
  'eu eus baq',
  'gl glg',
  'is isl ice',
  'et est',
  'lv lav',
  'lt lit',
  'sl slv',
  'sq sqi alb',
  'mk mkd mac',
  'hy hye arm',
  'ka kat geo',
  'az aze',
  'be bel',
  'kk kaz',
  'ur urd',
  'bn ben',
  'ta tam',
  'te tel',
  'ml mal',
  'tl tgl fil',
]) {
  const codes = group.split(' ');
  for (const code of codes) aliases[code] = codes[0];
}
export function subtitleLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(code) || ['und', 'mul', 'zxx', 'mis'].includes(code)) return null;
  return aliases[code] ?? code;
}
export interface EmbeddedTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string;
  default: boolean;
  hearingImpaired: boolean;
  reason: string | null;
  selected?: boolean;
  cues?: number;
}
export interface ExistingSubtitle {
  source: string;
  language: string;
  content: string;
  streamIndex?: number;
  title?: string;
  codec?: string;
}
const textCodecs = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
export function embeddedTracks(streams: any[]): EmbeddedTrack[] {
  return streams
    .filter((stream) => stream.codec_type === 'subtitle')
    .map((stream) => {
      const language = subtitleLanguage(stream.tags?.language);
      const title = String(stream.tags?.title ?? '').slice(0, 300);
      const disposition = stream.disposition ?? {};
      const forced = disposition.forced || /\bforced\b/i.test(title);
      const commentary =
        disposition.comment || /\b(commentary|director[’']?s comments?)\b/i.test(title);
      const signsOnly =
        !/\b(full|dialogue|complete)\b/i.test(title) &&
        /\b(?:signs?|songs?|lyrics?)(?:[\s/&+_-]+(?:and\s+)?(?:signs?|songs?|lyrics?))*(?:\s+only)?\s*(?:$|[)\]])/i.test(
          title,
        );
      return {
        index: stream.index,
        codec: stream.codec_name,
        language,
        title,
        default: Boolean(disposition.default),
        hearingImpaired:
          Boolean(disposition.hearing_impaired) || /\b(sdh|cc|hearing.impaired)\b/i.test(title),
        reason: forced
          ? 'Forced subtitles are not a full dialogue track.'
          : commentary
            ? 'Commentary is not the film dialogue.'
            : signsOnly
              ? 'Signs or songs only; not a full dialogue track.'
              : !textCodecs.has(stream.codec_name)
                ? 'Image-based or unsupported subtitles need OCR before translation.'
                : !language
                  ? 'Track language is missing or undetermined.'
                  : null,
      };
    });
}

export async function extractEmbeddedSubtitles(
  input: string,
  options: PipelineOptions & { sourceStat?: { size: number; mtimeMs: number } } = {},
) {
  const settings = { ...config, ...options.settings };
  const before = await fs.stat(input);
  const unchanged = (stat: { size: number; mtimeMs: number }) =>
    stat.size === before.size && stat.mtimeMs === before.mtimeMs;
  if (options.sourceStat && !unchanged(options.sourceStat))
    throw Object.assign(new Error('Source changed since this job was submitted'), {
      code: 'SOURCE_CHANGED',
    });
  const info = await probe(input, { signal: options.signal });
  if (info.duration > settings.MAX_INPUT_DURATION_SEC)
    throw new Error('Input exceeds the configured duration limit');
  const tracks = embeddedTracks(info.streams);
  const audio = info.streams.filter((stream: any) => stream.codec_type === 'audio')[
    settings.AUDIO_STREAM_INDEX
  ];
  if (!audio) throw new Error('Selected audio stream is missing');
  const audioLanguage = subtitleLanguage(audio.tags?.language);
  const targetLanguage = options.targetLanguage ?? settings.TARGET_LANGUAGE;
  const preferred = [
    ...new Set(
      [
        subtitleLanguage(targetLanguage),
        subtitleLanguage(options.sourceLanguage ?? settings.DEFAULT_LANGUAGE),
        audioLanguage,
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
  const rank = (track: EmbeddedTrack) => {
    const match = preferred.indexOf(track.language!);
    return match >= 0
      ? match
      : preferred.length + (track.default ? 0 : track.language === 'en' ? 1 : 2);
  };
  const candidates = tracks
    .filter((track) => !track.reason)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(a.hearingImpaired) - Number(b.hearingImpaired) ||
        Number(b.default) - Number(a.default) ||
        a.index - b.index,
    );
  let subtitle: ExistingSubtitle | null = null;
  const deadline = Date.now() + 120000;
  for (const track of candidates) {
    checkAbort(options.signal);
    if (Date.now() >= deadline) {
      track.reason = 'Embedded subtitle extraction reached its two-minute deadline.';
      break;
    }
    try {
      await options.onStage?.({
        id: 'subtitles',
        percentage: null,
        detail: `Extracting embedded ${track.language} subtitles${track.title ? ` · ${track.title}` : ''}`,
      });
      const { stdout } = await run(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-i',
          input,
          '-map',
          `0:${track.index}`,
          '-c:s',
          'srt',
          '-f',
          'srt',
          'pipe:1',
        ],
        {
          signal: options.signal,
          timeout: Math.max(1, deadline - Date.now()),
          maxOutput: MAX_SUBTITLE_BYTES,
        },
      );
      const { cues } = subtitleDocument(stdout);
      if (
        cues.length > 10000 ||
        cues.some((cue) => cue.start < 0 || cue.end > info.duration + 0.25)
      )
        throw new Error('Subtitle times fall outside this film or exceed the cue limit');
      if (
        info.duration >= 600 &&
        (cues.length < 10 || Math.max(...cues.map((cue) => cue.end)) < info.duration / 2)
      )
        throw new Error('Sparse or incomplete track; cannot use it in place of the full dialogue');
      track.selected = true;
      track.cues = cues.length;
      subtitle = {
        source: 'embedded',
        language:
          track.language === subtitleLanguage(targetLanguage) ? targetLanguage : track.language!,
        content: stdout,
        streamIndex: track.index,
        title: track.title,
        codec: track.codec,
      };
      break;
    } catch (error) {
      checkAbort(options.signal);
      track.reason = `Extraction rejected: ${error.message}`;
      await options.onWarning?.(`Embedded subtitle track ${track.index}: ${error.message}`);
    }
  }
  if (!unchanged(await fs.stat(input)))
    throw Object.assign(new Error('Source changed during subtitle extraction'), {
      code: 'SOURCE_CHANGED',
    });
  if (!subtitle && tracks.length)
    await options.onWarning?.(
      'No usable full-dialogue embedded text track. Continuing with online subtitle search and transcription if needed.',
    );
  return {
    subtitle,
    sourceStat: { size: before.size, mtimeMs: before.mtimeMs },
    report: { version: 1, duration: info.duration, audioLanguage, tracks },
  };
}
