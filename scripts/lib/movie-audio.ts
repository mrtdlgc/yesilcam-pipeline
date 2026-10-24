import fs from 'node:fs/promises';
import path from 'node:path';
import type { Chunk, PipelineOptions } from '../../types/pipeline.js';
import { config } from '../../config.js';
import { probe, run } from './process.js';

// One continuous signal, including silence/music. Small local analysis batches
// are independent of this provider request and remain available in chunked mode.
export async function prepareMovieAudio(
  input: string,
  workDir: string,
  options: PipelineOptions = {},
): Promise<Chunk[]> {
  const settings = { ...config, ...options.settings };
  const source = await fs.stat(input);
  const info = await probe(input, { signal: options.signal });
  if (!(info.duration > 0) || info.duration > Math.min(settings.MAX_INPUT_DURATION_SEC, 10 * 3600))
    throw new Error('Full-movie audio exceeds the supported duration');
  if (!info.streams.filter((s: any) => s.codec_type === 'audio')[settings.AUDIO_STREAM_INDEX])
    throw new Error('Configured audio stream does not exist');
  await fs.mkdir(workDir, { recursive: true });
  const file = path.join(workDir, 'movie.flac');
  const partial = path.join(workDir, 'movie.partial.flac');
  let pending = Promise.resolve(),
    buffer = '';
  try {
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-threads',
        '1',
        '-i',
        input,
        '-map',
        `0:a:${settings.AUDIO_STREAM_INDEX}`,
        '-vn',
        '-af',
        'aresample=async=1:first_pts=0,apad',
        '-t',
        info.duration,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-sample_fmt',
        's16',
        '-c:a',
        'flac',
        '-compression_level',
        '3',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-progress',
        'pipe:1',
        '-stats_period',
        '2',
        partial,
      ],
      {
        signal: options.signal,
        timeout: settings.MEDIA_TIMEOUT_MS,
        onStdout: (chunk) => {
          buffer += chunk.toString();
          let end: number;
          while ((end = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, end).trim();
            buffer = buffer.slice(end + 1);
            if (!line.startsWith('out_time_us=')) continue;
            const seconds = Number(line.slice(12)) / 1e6;
            if (!Number.isFinite(seconds) || seconds < 0) continue;
            pending = pending.then(async () => {
              await options.onStage?.({
                id: 'chunking',
                percentage: Math.min(99, (seconds / info.duration) * 100),
                detail: 'Preparing one continuous 16 kHz mono FLAC for ElevenLabs',
              });
            });
            void pending.catch(() => {});
          }
        },
      },
    );
    await pending;
    const current = await fs.stat(input),
      prepared = await fs.stat(partial);
    if (source.size !== current.size || source.mtimeMs !== current.mtimeMs)
      throw new Error('Source changed while preparing the movie audio');
    if (prepared.size > settings.MAX_MOVIE_AUDIO_BYTES)
      throw new Error('Prepared movie exceeds the full-movie upload limit');
    const output = await probe(partial, { signal: options.signal });
    if (Math.abs(output.duration - info.duration) > 0.05)
      throw new Error('Prepared movie duration differs from its source');
    await fs.rename(partial, file);
    const stat = await fs.stat(file);
    return [
      {
        id: 0,
        file,
        startTime: 0,
        endTime: output.duration,
        hasSpeech: null,
        audioStat: { size: stat.size, mtimeMs: stat.mtimeMs },
        audioFormat: '16kHz-mono-s16-flac',
      },
    ];
  } finally {
    await pending.catch(() => {});
    await fs.rm(partial, { force: true });
  }
}
