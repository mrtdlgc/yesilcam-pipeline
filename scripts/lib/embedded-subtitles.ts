import fs from 'node:fs/promises';
import { config } from '../../config.js';
import type { PipelineOptions } from '../../types/pipeline.js';
import { checkAbort, probe, run } from './process.js';
import { MAX_SUBTITLE_BYTES, subtitleDocument } from './codex-translation.js';

import {
  embeddedTracks,
  rankedSubtitleTracks,
  subtitleLanguage,
} from '../../public/subtitle-tracks.js';
export { embeddedTracks, subtitleLanguage } from '../../public/subtitle-tracks.js';
export interface ExistingSubtitle {
  source: string;
  language: string;
  content: string;
  streamIndex?: number;
  title?: string;
  codec?: string;
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
  const candidates = rankedSubtitleTracks(
    tracks,
    targetLanguage,
    options.sourceLanguage ?? settings.DEFAULT_LANGUAGE,
    audioLanguage,
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
