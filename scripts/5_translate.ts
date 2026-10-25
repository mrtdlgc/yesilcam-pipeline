import type { PipelineOptions } from '../types/pipeline.js';
import { config } from '../config.js';
import { codexStatus, translateWithCodex } from './lib/codex-translation.js';

export async function checkTranslationAvailable(options: PipelineOptions = {}) {
  const status = await codexStatus(options);
  return {
    available: status.available,
    model: status.model,
    error: status.available ? null : status.message,
  };
}

export async function translateSrtFile(
  input: any,
  outputPath: string,
  movieContext: Record<string, any> = {},
  progressCallback: ((progress: number, message: string) => void | Promise<void>) | null = null,
  options: PipelineOptions = {},
) {
  const settings = { ...config, ...options.settings };
  if (!['codex-local', 'openai-api', 'chatgpt-oauth'].includes(settings.TRANSLATION_PROVIDER))
    throw new Error('Choose a supported translation connection');
  return translateWithCodex(
    input,
    outputPath,
    {
      ...movieContext,
      sourceLanguage: movieContext.sourceLanguage ?? settings.DEFAULT_LANGUAGE,
      targetLanguage: movieContext.targetLanguage ?? settings.TARGET_LANGUAGE,
    },
    progressCallback,
    options,
  );
}
