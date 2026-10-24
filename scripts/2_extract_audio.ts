import type { PipelineOptions } from '../types/pipeline.js';
import { probe } from './lib/process.js';
import { config } from '../config.js';

// Validate source duration without modifying the media.
export async function validateSourceMedia(
  inputFile: string,
  jobId: any,
  options: PipelineOptions = {},
) {
  const info = await probe(inputFile, { signal: options.signal });
  if (info.duration > (options.settings?.MAX_INPUT_DURATION_SEC ?? config.MAX_INPUT_DURATION_SEC))
    throw new Error('Input exceeds the configured duration limit');
  return inputFile;
}
