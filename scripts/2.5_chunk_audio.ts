import type { PipelineOptions } from '../types/pipeline.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { at, jobId as validateId } from './lib/files.js';
import { probe, run, checkAbort } from './lib/process.js';
import { energyProfile } from './lib/audio.js';
import { timeRange } from './lib/sorted.js';

// Energy chooses cut points; Demucs and Silero handle speech/music afterwards.
// The spectral classifier remains an explicitly separate diagnostic script.
export function calculateChunkBoundariesForRegion(
  region: any,
  profile: any,
  threshold: number,
  settings = config,
) {
  const max = settings.CHUNK_MAX_DURATION,
    min = settings.CHUNK_MIN_DURATION,
    target = settings.CHUNK_TARGET_DURATION;
  if (!(max > 0 && min > 0 && min <= target && target <= max))
    throw new Error('Invalid chunk duration settings');
  const result = [];
  let start = region.start;
  while (start < region.end - 0.0005) {
    const remaining = region.end - start;
    let end;
    if (remaining <= max) end = region.end;
    else if (remaining < max + min) end = start + remaining / 2;
    else {
      const candidates = timeRange<{ time: number; energy: number }>(
        profile,
        start + min,
        start + max,
      );
      const quiet = candidates.filter((p: any) => p.energy < threshold);
      const selected = (quiet.length ? quiet : candidates).reduce((best: any, p: any) => {
        const score = quiet.length ? Math.abs(p.time - start - target) : p.energy;
        return !best || score < best.score ? { time: p.time, score } : best;
      }, null);
      end = selected?.time || start + target;
    }
    end = Math.min(end, start + max, region.end);
    if (end <= start) throw new Error('Chunking did not advance');
    result.push({ startTime: start, endTime: end });
    start = end;
  }
  return result;
}
export async function chunkAudio(inputFile: string, id: any, options: PipelineOptions = {}) {
  validateId(id);
  const settings = { ...config, ...options.settings };
  const workDir = options.workDir || at('temp', id);
  await fs.mkdir(workDir, { recursive: true });
  const { duration, streams } = await probe(inputFile, { signal: options.signal });
  const source = streams.filter((stream: any) => stream.codec_type === 'audio')[
    settings.AUDIO_STREAM_INDEX
  ];
  if (!source) throw new Error('Configured audio stream does not exist');
  const rate = Math.min(Number(source.sample_rate) || 48000, 48000),
    channels = Math.min(source.channels || 2, 2);
  if (duration > settings.MAX_INPUT_DURATION_SEC)
    throw new Error('Input exceeds the configured duration limit');
  const profile =
    duration > settings.CHUNK_MAX_DURATION
      ? await energyProfile(inputFile, {
          signal: options.signal,
          audioStream: settings.AUDIO_STREAM_INDEX,
        })
      : [];
  const sorted = profile.map((p) => p.energy).sort((a, b) => a - b);
  const threshold = (sorted[Math.floor(sorted.length / 2)] || 0) * 0.2;
  let regions = [{ start: 0, end: duration }];
  if (settings.SKIP_LONG_SILENCE && profile.length) {
    let silentStart = null,
      last = 0;
    regions = [];
    for (const frame of [...profile, { time: duration, energy: Infinity }]) {
      if (frame.energy < threshold) {
        silentStart ??= frame.time;
        continue;
      }
      if (silentStart !== null && frame.time - silentStart >= 5) {
        if (silentStart > last) regions.push({ start: last, end: silentStart });
        last = frame.time;
      }
      silentStart = null;
    }
    if (last < duration) regions.push({ start: last, end: duration });
    if (!regions.length) regions = [{ start: 0, end: duration }];
  }
  const boundaries = regions.flatMap((region) =>
    calculateChunkBoundariesForRegion(region, profile, threshold, settings),
  );
  const chunks = [];
  // Existing manifests retain their original WAVs and request identities.
  const compact = settings.TRANSCRIBE_BACKEND !== 'local' && settings.TRANSCRIBE_BACKEND !== 'auto';
  for (const [index, bounds] of boundaries.entries()) {
    checkAbort(options.signal);
    const file = path.join(
      workDir,
      `chunk_${String(index).padStart(5, '0')}.${compact ? 'flac' : 'wav'}`,
    );
    // Accurate input seeking decodes/discards up to the cut, without repeatedly
    // decoding the entire film prefix. Resampling retains timestamped audio gaps.
    await run(
      'ffmpeg',
      [
        '-v',
        'error',
        '-nostdin',
        '-y',
        '-accurate_seek',
        '-ss',
        bounds.startTime,
        '-i',
        inputFile,
        '-t',
        bounds.endTime - bounds.startTime,
        '-map',
        `0:a:${settings.AUDIO_STREAM_INDEX}`,
        '-vn',
        '-af',
        'aresample=async=1:first_pts=0,apad',
        '-ar',
        compact ? 16000 : rate,
        '-ac',
        compact ? 1 : channels,
        '-c:a',
        compact ? 'flac' : 'pcm_f32le',
        ...(compact ? ['-sample_fmt', 's16'] : []),
        file,
      ],
      { signal: options.signal, timeout: settings.MEDIA_TIMEOUT_MS },
    );
    chunks.push({ id: index, file, ...bounds, hasSpeech: null });
    await options.onProgress?.(index + 1, boundaries.length);
  }
  return chunks;
}
