import fs from 'node:fs/promises';
import type { PipelineOptions } from '../../types/pipeline.js';
import { config } from '../../config.js';
import { checkAbort, probe, run } from './process.js';

// Optional visual evidence, never an inference request. Native frame times are
// retained; scaling reduces scene-score cost without sampling away short shots.
export async function shotBoundaries(input: string, options: PipelineOptions = {}) {
  const settings = { ...config, ...options.settings };
  const before = await fs.stat(input);
  const info = await probe(input, { signal: options.signal });
  const video = info.streams.find(
    (s: any) => s.codec_type === 'video' && !s.disposition?.attached_pic,
  );
  if (!video)
    return {
      cuts: [],
      frameRate: null,
      duration: info.duration,
      shotDetection: 'unavailable' as const,
    };
  const [numerator, denominator] = String(video.avg_frame_rate).split('/').map(Number);
  const rate = numerator / denominator;
  const [nominalNumerator, nominalDenominator] = String(video.r_frame_rate).split('/').map(Number);
  const nominal = nominalNumerator / nominalDenominator;
  const frameRate =
    Number.isFinite(rate) && rate >= 1 && rate <= 240 && Math.abs(rate - nominal) < 0.001
      ? rate
      : null;
  if (!settings.EDITORIAL_SHOT_DETECTION)
    return { cuts: [], frameRate, duration: info.duration, shotDetection: 'not-run' as const };
  await options.onStage?.({
    id: 'translation',
    percentage: null,
    detail: 'Checking scene cuts for subtitle timing (two CPU threads)',
  });
  let stderr = '',
    lastProgress = 0,
    pending = '';
  let updates = Promise.resolve();
  const { stderr: fullError } = await run(
    'ffmpeg',
    [
      '-nostdin',
      '-v',
      'info',
      '-threads',
      '2',
      '-filter_threads',
      '2',
      '-i',
      input,
      '-map',
      `0:${video.index}`,
      '-vf',
      "scale=160:-2,select='gt(scene,0.35)',showinfo",
      '-an',
      '-sn',
      '-f',
      'null',
      '-',
      '-progress',
      'pipe:1',
      '-nostats',
    ],
    {
      signal: options.signal,
      timeout: Math.min(settings.MEDIA_TIMEOUT_MS, 10 * 60 * 1000),
      maxOutput: 8 * 1024 * 1024,
      priority: 10,
      onStderr(chunk) {
        stderr += chunk;
        if (Buffer.byteLength(stderr) > 8 * 1024 * 1024)
          throw new Error('Scene analysis returned too much output');
      },
      onStdout(chunk) {
        pending += chunk.toString();
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!line.startsWith('out_time_us=') || Date.now() - lastProgress < 2000) continue;
          const seconds = Number(line.slice(12)) / 1e6;
          if (!Number.isFinite(seconds)) continue;
          lastProgress = Date.now();
          updates = updates.then(async () => {
            await options.onStage?.({
              id: 'translation',
              percentage: null,
              detail: `Checking scene cuts · ${Math.min(100, Math.round((seconds / info.duration) * 100))}%`,
            });
          });
          void updates.catch(() => {});
        }
      },
    },
  );
  await updates;
  checkAbort(options.signal);
  const after = await fs.stat(input);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error('Source changed during scene analysis');
  const cuts = [
    ...new Set(
      [...(stderr || fullError).matchAll(/pts_time:([\d.]+)/g)]
        .map((m) => Number(m[1]))
        .filter((n) => Number.isFinite(n) && n > 0 && n < info.duration),
    ),
  ].sort((a, b) => a - b);
  if (cuts.length > 20000) throw new Error('Too many scene cuts');
  return { cuts, frameRate, duration: info.duration, shotDetection: 'complete' as const };
}
