import { config } from '../../config.js';
import type { Settings } from '../../types/pipeline.js';
import { selection } from '../providers/catalog.js';
import { credential } from './credentials.js';
import { codexStatus } from './codex-translation.js';

// Check only once subtitle discovery establishes that audio processing is needed.
export async function assertPipelineProviders(settings: Settings) {
  if (settings.TRANSLATION_ENABLED) {
    const status = await codexStatus({ settings });
    if (!status.available) throw new Error(status.message);
  }
  const { provider, model } = selection(settings);
  if (provider.id === 'local' && !config.LOCAL_WHISPER_ENABLED)
    throw new Error('Local Whisper is not installed in this cloud image; choose a cloud provider');
  if (provider.id !== 'local' && model.perMinute === null)
    throw new Error('Enter a quoted price per minute for this model');
  if (provider.id === 'compatible' && !(await credential('TRANSCRIPTION_API_URL')))
    throw new Error('Save a custom transcription URL in Connections');
  if (
    provider.key &&
    !(await credential(provider.key)) &&
    provider.id !== 'compatible' &&
    !settings.PAUSE_BEFORE_TRANSCRIPTION
  )
    throw new Error(`${provider.name} needs a key in Connections`);
}
