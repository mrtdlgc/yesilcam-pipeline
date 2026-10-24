import type { RunOptions } from './process.js';
export interface EnergyFrame {
  time: number;
  energy: number;
  [field: string]: number;
}
export interface Interval {
  start: number;
  end: number;
}
import { run } from './process.js';

// Decode incrementally: a full feature film's PCM is never retained in RAM.
export async function energyProfile(
  file: string,
  options: RunOptions & { audioStream?: number } = {},
) {
  const sampleRate = 16000,
    window = 400,
    hop = 200;
  let carry = Buffer.alloc(0),
    position = 0;
  const profile: EnergyFrame[] = [];
  await run(
    'ffmpeg',
    [
      '-v',
      'error',
      '-nostdin',
      '-i',
      file,
      '-map',
      `0:a:${options.audioStream ?? 0}`,
      '-vn',
      '-af',
      'aresample=async=1:first_pts=0',
      '-ac',
      '1',
      '-ar',
      sampleRate,
      '-f',
      'f32le',
      'pipe:1',
    ],
    {
      timeout: 3600000,
      ...options,
      onStdout(chunk) {
        const data = Buffer.concat([carry, chunk]);
        let offset = 0;
        while (offset + window * 4 <= data.length) {
          let sum = 0;
          for (let j = 0; j < window; j++) {
            const value = data.readFloatLE(offset + j * 4);
            if (!Number.isFinite(value))
              throw new Error('Decoded audio contains non-finite samples');
            sum += value * value;
          }
          profile.push({ time: position / sampleRate, energy: Math.sqrt(sum / window) });
          offset += hop * 4;
          position += hop;
        }
        carry = Buffer.from(data.subarray(offset));
      },
    },
  );
  return profile;
}
export function intervalsFromProfile(
  profile: EnergyFrame[],
  {
    field = 'energy',
    startThreshold,
    endThreshold = startThreshold,
    minSpeech = 0.1,
    minSilence = 0.1,
    hop = 0.0125,
  }: {
    field?: string;
    startThreshold: number;
    endThreshold?: number;
    minSpeech?: number;
    minSilence?: number;
    hop?: number;
  },
) {
  const intervals: Interval[] = [];
  let start: number | null = null,
    lastActive = 0;
  for (const frame of profile) {
    if (start === null) {
      if (frame[field] >= startThreshold) {
        start = frame.time;
        lastActive = frame.time;
      }
    } else if (frame[field] >= endThreshold) lastActive = frame.time;
    else if (frame.time - lastActive >= minSilence) {
      if (lastActive + hop - start >= minSpeech) intervals.push({ start, end: lastActive + hop });
      start = null;
      lastActive = 0;
    }
  }
  if (start !== null && lastActive + hop - start >= minSpeech)
    intervals.push({ start, end: lastActive + hop });
  return intervals;
}
