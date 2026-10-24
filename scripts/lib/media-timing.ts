import type { PipelineOptions } from '../../types/pipeline.js';
import { probe } from './process.js';

// Container metadata only: no frame decoding or whole-film scene scan.
export async function mediaTiming(input: string, options: PipelineOptions = {}) {
  const info = await probe(input, { signal: options.signal });
  const video = info.streams.find(
    (stream: any) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  const rate = (value: unknown) => {
    const [numerator, denominator] = String(value).split('/').map(Number);
    return numerator / denominator;
  };
  const average = rate(video?.avg_frame_rate),
    nominal = rate(video?.r_frame_rate);
  const frameRate =
    Number.isFinite(average) &&
    average >= 1 &&
    average <= 240 &&
    Math.abs(average - nominal) < 0.001
      ? average
      : null;
  return { cuts: [], frameRate, duration: info.duration, shotDetection: 'not-run' as const };
}
