import type { PipelineOptions } from '../types/pipeline.js';
import { probe } from './lib/process.js';
import { config } from '../config.js';

// Preserve the native-rate source. Chunk extraction creates lossless PCM.
export async function extractAndOptimizeAudio(
  inputFile: string,
  jobId: any,
  options: PipelineOptions = {},
) {
  const info = await probe(inputFile, { signal: options.signal });
  if (info.duration > (options.settings?.MAX_INPUT_DURATION_SEC ?? config.MAX_INPUT_DURATION_SEC))
    throw new Error('Input exceeds the configured duration limit');
  return inputFile;
}
