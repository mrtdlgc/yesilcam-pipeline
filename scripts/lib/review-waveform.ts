import fs from 'node:fs/promises';
import { config } from '../../config.js';
import { at, contained, readJson, serialized, writeJson } from './files.js';
import { run } from './process.js';
import { subtitleHash } from './speakers.js';
import { readSubtitleReview } from './subtitle-review.js';

export interface ReviewWaveform {
  version: 1;
  duration: number;
  binsPerSecond: number;
  // Unsigned 8-bit amplitude, encoded compactly rather than shipping decoded movie audio.
  peaks: string;
  rms: string;
}
const sampleRate = 8000;
const binsPerSecond = 100;
const samplesPerBin = sampleRate / binsPerSecond;
const pending = new Map<string, Promise<ReviewWaveform>>();

async function source(id: string) {
  const review = await readSubtitleReview(id);
  if (!review.media)
    throw Object.assign(new Error('Prepare screening media in the studio to see its waveform.'), {
      status: 409,
    });
  if (
    !Number.isFinite(review.duration) ||
    review.duration <= 0 ||
    review.duration > config.MAX_INPUT_DURATION_SEC
  )
    throw Object.assign(new Error('Waveform duration exceeds the media limit'), { status: 400 });
  const directory = await contained(at('review-sessions'), id);
  const input = await contained(directory, review.media);
  const stat = await fs.stat(input);
  const identity = subtitleHash(
    JSON.stringify([1, review.media, stat.size, stat.mtimeMs, review.duration, binsPerSecond]),
  );
  return {
    input,
    duration: review.duration,
    identity,
    cache: await contained(directory, 'waveform.json'),
  };
}

async function cached(info: Awaited<ReturnType<typeof source>>) {
  const saved = await readJson<{ identity: string; waveform: ReviewWaveform } | null>(
    info.cache,
    null,
  );
  return saved?.identity === info.identity ? saved.waveform : null;
}

// A single low-priority audio decoder, shared across tabs. Never enters the inference pipeline.
export async function prepareReviewWaveform(id: string): Promise<ReviewWaveform> {
  const info = await source(id);
  const saved = await cached(info);
  if (saved) return saved;
  const existing = pending.get(id);
  if (existing) return existing;
  if (pending.size >= 4)
    throw Object.assign(new Error('Other waveforms are being prepared. Try again shortly.'), {
      status: 503,
    });
  const work = serialized('review-waveform-decoder', async () => {
    const current = await source(id);
    const saved = await cached(current);
    if (saved) return saved;
    const bins = Math.ceil(current.duration * binsPerSecond);
    const peaks = Buffer.alloc(bins),
      rms = Buffer.alloc(bins);
    let sampleCount = 0,
      count = 0,
      bin = 0,
      peak = 0,
      squares = 0,
      trailing = Buffer.alloc(0);
    const finishBin = () => {
      if (!count) return;
      if (bin >= bins) throw new Error('Waveform audio exceeds its duration limit');
      peaks[bin] = Math.min(255, Math.round((peak / 32768) * 255));
      rms[bin++] = Math.min(255, Math.round((Math.sqrt(squares / count) / 32768) * 255));
      count = peak = squares = 0;
    };
    await run(
      'ffmpeg',
      [
        '-nostdin',
        '-v',
        'error',
        '-threads',
        '1',
        '-filter_threads',
        '1',
        '-i',
        current.input,
        '-map',
        '0:a:0',
        '-vn',
        '-sn',
        '-dn',
        // Retain silence/delays on the playback timeline, including a late audio stream.
        '-af',
        `aresample=${sampleRate}:async=1:first_pts=0,apad`,
        '-ac',
        '1',
        '-ar',
        sampleRate,
        '-t',
        current.duration,
        '-c:a',
        'pcm_s16le',
        '-f',
        's16le',
        'pipe:1',
      ],
      {
        timeout: 180000,
        priority: 10,
        onStdout(chunk) {
          const data = trailing.length ? Buffer.concat([trailing, chunk]) : chunk;
          const end = data.length - (data.length % 2);
          for (let offset = 0; offset < end; offset += 2) {
            const sample = data.readInt16LE(offset);
            peak = Math.max(peak, Math.abs(sample));
            squares += sample * sample;
            count++;
            sampleCount++;
            if (count === samplesPerBin) finishBin();
          }
          trailing = Buffer.from(data.subarray(end));
        },
      },
    );
    finishBin();
    if (trailing.length || Math.abs(sampleCount / sampleRate - current.duration) > 0.1)
      throw new Error('Waveform audio is incomplete');
    if ((await source(id)).identity !== current.identity)
      throw new Error('Screening media changed while preparing its waveform. Try again.');
    const waveform: ReviewWaveform = {
      version: 1,
      duration: current.duration,
      binsPerSecond,
      peaks: peaks.toString('base64'),
      rms: rms.toString('base64'),
    };
    await writeJson(current.cache, { identity: current.identity, waveform });
    return waveform;
  });
  pending.set(id, work);
  try {
    return await work;
  } finally {
    pending.delete(id);
  }
}
