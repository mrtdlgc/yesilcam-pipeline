import type { Chunk } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import path from 'node:path';
import { config } from '../config.js';
import { at, writeJson } from './lib/files.js';
import { run, PYTHON, pythonEnv } from './lib/process.js';
import { progressLines } from './lib/progress.js';

export async function checkDemucsAvailable() {
  try {
    const { stdout } = await run(PYTHON, [at('scripts', '2.7_demucs_clean.py'), '--check'], {
      timeout: 30000,
    });
    const details = JSON.parse(stdout);
    return { available: details.installed, cuda: details.cuda_available, details };
  } catch (error) {
    return { available: false, details: { error: error.message } };
  }
}

export async function cleanWithDemucs<T extends Pick<Chunk, 'id' | 'file'> & Partial<Chunk>>(
  chunks: T[],
  id: any,
  options: PipelineOptions = {},
) {
  const settings = { ...config, ...options.settings };
  if (!settings.DEMUCS_ENABLED)
    return chunks.map((chunk) => ({ ...chunk, _review: ['separation_disabled'] }));
  const workDir = options.workDir ?? at('temp', id);
  const input = path.join(workDir, 'demucs-input.json');
  await writeJson(input, { chunks });
  const updates = progressLines(async (value) => {
    await options.onStage?.({
      id: 'demucs',
      completed: value.completed,
      total: value.total,
      unit: 'chunks',
      detail: value.detail,
    });
  });
  let stdout: string;
  try {
    ({ stdout } = await run(
      PYTHON,
      [
        at('scripts', '2.7_demucs_clean.py'),
        '--batch',
        input,
        '--output',
        path.join(workDir, 'vocals'),
        '--model',
        settings.DEMUCS_MODEL,
        '--device',
        settings.DEMUCS_DEVICE,
        '--shifts',
        String(settings.DEMUCS_SHIFTS),
        '--overlap',
        String(settings.DEMUCS_OVERLAP),
      ],
      {
        signal: options.signal,
        timeout: settings.MEDIA_TIMEOUT_MS,
        env: pythonEnv(settings),
        onStderr: (text) => {
          updates.push(text);
          options.onLog?.(text);
        },
      },
    ));
  } finally {
    await updates.finish();
  }
  const result = JSON.parse(stdout);
  if (result.chunks?.length !== chunks.length) throw new Error('Demucs did not return every chunk');
  return result.chunks; // A separation failure is retryable, never silently original audio.
}

export async function cleanSingleFile(
  file: string,
  outputDir: string,
  options: PipelineOptions = {},
) {
  const chunks = await cleanWithDemucs([{ id: 0, file }], 'single', {
    ...options,
    workDir: outputDir,
  });
  return chunks[0].file;
}
