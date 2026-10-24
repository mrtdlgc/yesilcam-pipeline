import type { TranscriptionModel, Provider, Selection } from '../../types/providers.js';
import type { Settings, Chunk } from '../../types/pipeline.js';
import { DEFAULT_OPENROUTER_MODEL } from '../../config.js';
import { credential } from '../lib/credentials.js';
import { readFileSync } from 'node:fs';
import { fullMovie } from '../lib/transcription-mode.js';
import '../lib/environment.js';

export const PRICING_DATE = '2026-10-23';
const routerCatalog = JSON.parse(
  readFileSync(new URL('./openrouter-models.json', import.meta.url), 'utf8'),
);
const model = (
  id: string,
  perMinute: number | null,
  timing: TranscriptionModel['timing'],
  extra: Partial<TranscriptionModel> = {},
): TranscriptionModel => ({ id, perMinute, currency: 'USD', timing, ...extra });
const routerKnown: Record<string, TranscriptionModel> = {
  'openai/gpt-transcribe': model('', 0.0045, 'estimated'),
  'openai/whisper-large-v3': model('', 0.00045, 'word', { minimumSeconds: 10 }),
  'openai/whisper-large-v3-turbo': model('', 0.0001998, 'word', { minimumSeconds: 10 }),
  'openai/whisper-1': model('', 0.006, 'word'),
  'mistralai/voxtral-mini-transcribe-3-0': model('', 0.0035, 'segment'),
  'mistralai/voxtral-small-transcribe-3-0': model('', 0.004, 'segment'),
  'deepgram/nova-3': model('', 0.0043, 'word'),
  'elevenlabs/scribe-v2': model('', 0.22 / 60, 'word'),
  'google/gemini-3.5-transcribe': model('', 0.0051, 'word', { approximate: true }),
  'microsoft/mai-transcribe-2': model('', null, 'word'),
};
// The generic Models API's `prompt` price has different units across STT
// vendors. Unknown entries deliberately need an explicit rate, never a guess.
export const providers: Provider[] = [
  {
    id: 'local',
    name: 'Local faster-whisper',
    key: null,
    defaultModel: 'large-v3',
    billing: 'Local hardware; no API charge',
    models: [model('large-v3', 0, 'segment')],
  },
  {
    id: 'groq',
    name: 'Groq',
    key: 'GROQ_API_KEY',
    defaultModel: 'whisper-large-v3',
    billing: 'API usage; free developer limits may apply',
    source: 'https://console.groq.com/docs/speech-to-text',
    models: [
      model('whisper-large-v3', 0.111 / 60, 'word', { minimumSeconds: 10 }),
      model('whisper-large-v3-turbo', 0.04 / 60, 'word', { minimumSeconds: 10 }),
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    key: 'OPENROUTER_API_KEY',
    defaultModel: DEFAULT_OPENROUTER_MODEL,
    billing: 'OpenRouter credits; upstream subscriptions do not transfer',
    source: 'https://openrouter.ai/docs/guides/overview/multimodal/stt',
    models: routerCatalog.models.map((m: any) => ({
      ...model(m.id, null, 'estimated'),
      ...routerKnown[m.id],
      id: m.id,
      name: m.name,
      note: routerKnown[m.id]
        ? 'Route price estimate; actual usage.cost is retained.'
        : 'Set a quoted rate. Text output by default; verify language support.',
    })),
  },
  {
    id: 'openai',
    name: 'OpenAI',
    key: 'OPENAI_API_KEY',
    defaultModel: 'gpt-transcribe',
    billing: 'API billing is separate from ChatGPT plans',
    source: 'https://developers.openai.com/api/docs/guides/speech-to-text',
    models: [
      model('gpt-transcribe', 0.0045, 'estimated'),
      model('whisper-1', 0.006, 'word', { deprecated: '2027-02-26' }),
      model('gpt-4o-transcribe', 0.006, 'estimated', {
        approximate: true,
        deprecated: '2027-02-26',
      }),
      model('gpt-4o-mini-transcribe', 0.003, 'estimated', {
        approximate: true,
        deprecated: '2027-02-26',
      }),
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    key: 'MISTRAL_API_KEY',
    defaultModel: 'voxtral-mini-transcribe-3-0',
    billing:
      'API usage; current Pro plans advertise API credits. Confirm Studio credit eligibility; coding plan keys are different.',
    source: 'https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files',
    models: [
      model('voxtral-mini-transcribe-3-0', 0.0035, 'segment', { preview: true }),
      model('voxtral-small-transcribe-3-0', 0.004, 'segment', { preview: true }),
    ],
  },
  {
    id: 'deepgram',
    name: 'Deepgram',
    key: 'DEEPGRAM_API_KEY',
    defaultModel: 'nova-3',
    billing: 'API usage or committed credits',
    source: 'https://deepgram.com/pricing',
    models: [model('nova-3', 0.0043, 'word', { autoPerMinute: 0.0052 })],
  },
  {
    id: 'assemblyai',
    name: 'AssemblyAI',
    key: 'ASSEMBLYAI_API_KEY',
    defaultModel: 'universal-2',
    billing: 'API usage; promotional credits may apply',
    source: 'https://www.assemblyai.com/docs/billing-and-pricing',
    models: [
      model('universal-2', 0.15 / 60, 'word', { quantumSeconds: 1 }),
      model('universal-3-5-pro', 0.21 / 60, 'word', {
        quantumSeconds: 1,
        note: '18 languages; check coverage. No automatic model fallback.',
      }),
    ],
  },
  {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    key: 'ELEVENLABS_API_KEY',
    defaultModel: 'scribe_v2',
    billing:
      'Direct ElevenAPI: pay-as-you-go or included plan usage; subscription fees and overage are separate',
    source: 'https://elevenlabs.io/pricing/api',
    models: [
      model('scribe_v2', 0.22 / 60, 'word', {
        note: 'Published API rate: $0.22/hour. Your account’s credit conversion, subscription and overage can differ; use a custom price for your plan. Supports full-movie transcription and speaker labels.',
      }),
    ],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    key: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.5-transcribe',
    billing:
      'API free tier or Cloud billing; eligible Developer Program Cloud credits can offset charges',
    source: 'https://ai.google.dev/gemini-api/docs/pricing',
    models: [
      model('gemini-3.5-transcribe', 0.0051, 'word', {
        approximate: true,
        inputPerMillion: 2,
        outputPerMillion: 12,
      }),
    ],
  },
  {
    id: 'xai',
    name: 'Grok / xAI',
    key: 'XAI_API_KEY',
    defaultModel: 'grok-voice-transcribe-2.0',
    billing: 'Confirm API-key transcription eligibility in your subscription; never assumed free',
    source: 'https://docs.x.ai/developers/model-capabilities/audio/speech-to-text',
    models: [
      model('grok-voice-transcribe-2.0', 0.1 / 60, 'word', {
        note: 'REST rate; shared subscription pool eligibility needs account verification.',
      }),
    ],
  },
  {
    id: 'speechmatics',
    name: 'Speechmatics',
    key: 'SPEECHMATICS_API_KEY',
    defaultModel: 'enhanced',
    billing: 'API credits',
    source: 'https://www.speechmatics.com/pricing',
    models: [
      model('enhanced', 0.38 / 60, 'word'),
      model('standard', 0.23 / 60, 'word'),
      model('melia-1', 0.12 / 60, 'word'),
    ],
  },
  {
    id: 'gladia',
    name: 'Gladia',
    key: 'GLADIA_API_KEY',
    defaultModel: 'solaria-1',
    billing: 'API usage; currency is EUR',
    source: 'https://www.gladia.io/product/speech-to-text-api/async',
    models: [
      model('solaria-1', 0.27 / 60, 'word', { currency: 'EUR' }),
      model('solaria-3', 0.16 / 60, 'word', {
        currency: 'EUR',
        languages: ['en', 'fr', 'de', 'es', 'it'],
        note: 'Does not support Turkish.',
      }),
    ],
  },
  {
    id: 'compatible',
    name: 'Custom OpenAI-compatible endpoint',
    key: 'TRANSCRIPTION_API_KEY',
    defaultModel: '',
    billing: 'Set your model and quoted price explicitly',
    models: [],
  },
];

export function selection(settings: Settings, language = settings.DEFAULT_LANGUAGE): Selection {
  const backend = settings.TRANSCRIBE_BACKEND === 'auto' ? 'local' : settings.TRANSCRIBE_BACKEND;
  const provider = providers.find((p) => p.id === backend);
  if (!provider) throw new Error(`Unknown transcription provider: ${backend}`);
  const id =
    settings.TRANSCRIPTION_MODEL ||
    (backend === 'local'
      ? settings.LOCAL_WHISPER_MODEL
      : backend === 'groq'
        ? settings.GROQ_MODEL
        : provider.defaultModel);
  if (typeof id !== 'string' || !id || id.length > 200 || /[\x00-\x1f\x7f]/.test(id))
    throw new Error('Choose a transcription model');
  let selected = provider.models.find((m) => m.id === id);
  if (!selected && !['local', 'compatible'].includes(backend))
    throw new Error(`Model ${id} is not in the ${backend} catalog`);
  selected ??= model(
    id,
    backend === 'local' ? 0 : null,
    backend === 'local'
      ? 'segment'
      : settings.COMPATIBLE_RESPONSE_FORMAT === 'verbose_json'
        ? 'word'
        : 'estimated',
  );
  if (selected.languages && !selected.languages.includes(language))
    throw new Error(`${id} does not support ${language}; choose a supported language/model`);
  if (language === 'auto' && selected.autoPerMinute)
    selected = { ...selected, perMinute: selected.autoPerMinute };
  if (
    backend !== 'local' &&
    settings.CLOUD_PRICE_PER_MINUTE !== null &&
    settings.CLOUD_PRICE_PER_MINUTE !== undefined
  ) {
    if (
      !Number.isFinite(settings.CLOUD_PRICE_PER_MINUTE) ||
      settings.CLOUD_PRICE_PER_MINUTE < 0 ||
      !/^[A-Z]{3}$/.test(settings.CLOUD_PRICE_CURRENCY)
    )
      throw new Error('Invalid quoted price or currency');
    selected = {
      ...selected,
      perMinute: settings.CLOUD_PRICE_PER_MINUTE,
      currency: settings.CLOUD_PRICE_CURRENCY,
      overridden: true,
    };
  }
  if (backend === 'openrouter' && selected.currency !== 'USD')
    throw new Error('OpenRouter quotes must use USD to match usage.cost');
  return { provider, model: selected };
}

export async function publicCatalog(settings: Settings) {
  return {
    checkedAt: PRICING_DATE,
    defaultProvider: settings.TRANSCRIBE_BACKEND,
    defaultModel: selection(settings).model.id,
    maxEstimatedCost: settings.CLOUD_MAX_ESTIMATED_COST,
    defaultPricePerMinute: settings.CLOUD_PRICE_PER_MINUTE,
    defaultPriceCurrency: settings.CLOUD_PRICE_CURRENCY,
    localAudioAvailable: settings.LOCAL_AUDIO_ENABLED,
    providers: await Promise.all(
      providers.map(async (p) => ({
        ...p,
        available: p.id !== 'local' || settings.LOCAL_WHISPER_ENABLED,
        configured:
          p.id === 'compatible'
            ? Boolean(await credential('TRANSCRIPTION_API_URL'))
            : p.key
              ? Boolean(await credential(p.key))
              : true,
      })),
    ),
  };
}

export function estimate(chunks: Pick<Chunk, 'startTime' | 'endTime'>[], selected: Selection) {
  const { model: m } = selected;
  if (
    chunks.some(
      (c) =>
        !Number.isFinite(c.startTime) ||
        !Number.isFinite(c.endTime) ||
        c.startTime < 0 ||
        c.endTime <= c.startTime,
    )
  )
    throw new Error('Cannot price invalid chunk durations');
  const seconds = chunks.reduce((sum, c) => sum + c.endTime - c.startTime, 0);
  const billedSeconds = chunks.reduce(
    (sum, c) =>
      sum +
      Math.max(
        m.minimumSeconds ?? 0,
        m.quantumSeconds
          ? Math.ceil((c.endTime - c.startTime) / m.quantumSeconds) * m.quantumSeconds
          : c.endTime - c.startTime,
      ),
    0,
  );
  return {
    currency: m.currency,
    amount: m.perMinute === null ? null : (billedSeconds / 60) * m.perMinute,
    seconds,
    billedSeconds,
    perMinute: m.perMinute,
    approximate: true,
    pricingDate: PRICING_DATE,
    rateSource: m.overridden ? 'user quote' : (selected.provider.source ?? 'local'),
    note: 'Gross usage estimate before included credits, taxes and discounts; not a hard billing cap.',
  };
}

export function validateProviderSettings(settings: Settings) {
  if (!['auto', 'chunks', 'movie'].includes(settings.TRANSCRIPTION_MODE))
    throw new Error('Unknown transcription request mode');
  if (typeof settings.TRANSCRIPTION_DIARIZATION !== 'boolean')
    throw new Error('Invalid diarization option');
  if (
    fullMovie(settings) &&
    (settings.TRANSCRIBE_BACKEND !== 'elevenlabs' ||
      !['', 'scribe_v2'].includes(settings.TRANSCRIPTION_MODEL))
  )
    throw new Error(
      'Full-movie transcription requires direct ElevenLabs / Scribe v2; OpenRouter remains available for chunks',
    );
  for (const key of ['MOVIE_TRANSCRIPTION_TIMEOUT_MS', 'MAX_MOVIE_AUDIO_BYTES'] as const)
    if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0)
      throw new Error(`Invalid ${key}`);
  if (settings.TRANSCRIBE_BACKEND === 'auto' && settings.TRANSCRIPTION_MODEL)
    throw new Error(
      'Auto mode uses LOCAL_WHISPER_MODEL and GROQ_MODEL separately; leave TRANSCRIPTION_MODEL empty',
    );
  selection(settings);
  for (const key of [
    'CLOUD_MAX_ESTIMATED_COST',
    'CLOUD_POLL_INTERVAL_MS',
    'CLOUD_JOB_TIMEOUT_MS',
  ]) {
    if (
      !Number.isFinite(settings[key as keyof Settings]) ||
      Number(settings[key as keyof Settings]) <= 0
    )
      throw new Error(`Invalid ${key}`);
  }
  if (
    !Number.isInteger(settings.CLOUD_POLL_INTERVAL_MS) ||
    !Number.isInteger(settings.CLOUD_JOB_TIMEOUT_MS)
  )
    throw new Error('Cloud timeouts must be integer milliseconds');
  if (!['json', 'verbose_json'].includes(settings.COMPATIBLE_RESPONSE_FORMAT))
    throw new Error('Invalid compatible response format');
}

export function billingScenario(plan: any, assumptions: any) {
  if (!assumptions) return null;
  if (
    assumptions.currency !== plan.currency ||
    !Number.isFinite(assumptions.remainingCredit) ||
    assumptions.remainingCredit < 0 ||
    !Number.isFinite(assumptions.monthlyFee) ||
    assumptions.monthlyFee < 0
  )
    throw new Error(
      'Billing scenario needs matching currency, nonnegative remainingCredit and monthlyFee',
    );
  const additional =
    plan.amount === null ? null : Math.max(0, plan.amount - assumptions.remainingCredit);
  return {
    ...assumptions,
    estimatedAdditionalUsage: additional,
    costIfBuyingSubscriptionForThisRun:
      additional === null ? null : assumptions.monthlyFee + additional,
    note: 'User-entered scenario, not a checked account balance. Each row is an independent alternative; credits may be shared with other products/runs. No credits are deducted from the gross usage ledger.',
  };
}
