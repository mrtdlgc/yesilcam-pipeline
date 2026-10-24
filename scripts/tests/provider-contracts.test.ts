import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';
import type { CloudContext } from '../../types/providers.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-contracts-'));
process.env.DATA_DIR = root;
after(() => fs.rm(root, { recursive: true, force: true }));
const { config } = await import('../../config.js');
const { adapters } = await import('../providers/adapters.js');
const { selection } = await import('../providers/catalog.js');
const { normalize } = await import('../providers/normalize.js');
// Small synthetic response fixtures, kept independent of adapter implementation.
// These prove our wire contract, not live provider/model availability or billing.
const generic = {
  text: 'Merhaba.',
  language: 'tr',
  words: [{ word: 'Merhaba.', start: 0.1, end: 0.9 }],
};
const fixtures: Record<string, unknown[]> = {
  openai: [generic],
  groq: [generic],
  mistral: [
    { text: 'Merhaba.', language: 'tr', segments: [{ text: 'Merhaba.', start: 0.1, end: 0.9 }] },
  ],
  compatible: [generic],
  openrouter: [generic],
  xai: [generic],
  elevenlabs: [
    {
      text: 'Merhaba.',
      language_code: 'tr',
      transcription_id: 'saved-id',
      words: [{ text: 'Merhaba.', start: 0.1, end: 0.9, type: 'word', speaker_id: 'speaker_0' }],
    },
  ],
  deepgram: [
    {
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'Merhaba.',
                words: [{ word: 'merhaba', punctuated_word: 'Merhaba.', start: 0.1, end: 0.9 }],
              },
            ],
          },
        ],
      },
      metadata: { duration: 1 },
    },
  ],
  assemblyai: [
    { upload_url: 'https://fixture.invalid/audio' },
    { id: 'saved-id' },
    {
      status: 'completed',
      text: 'Merhaba.',
      language_code: 'tr',
      audio_duration: 1,
      words: [{ text: 'Merhaba.', start: 100, end: 900 }],
    },
  ],
  speechmatics: [
    { id: 'saved-id' },
    { job: { status: 'done' } },
    {
      metadata: { transcription_config: { language: 'tr' } },
      results: [
        {
          type: 'word',
          start_time: 0.1,
          end_time: 0.9,
          alternatives: [{ content: 'Merhaba', confidence: 0.99 }],
        },
        { type: 'punctuation', alternatives: [{ content: '.' }] },
      ],
    },
  ],
  gladia: [
    { audio_url: 'https://fixture.invalid/audio' },
    { id: 'saved-id' },
    {
      status: 'done',
      result: {
        transcription: {
          full_transcript: 'Merhaba.',
          languages: ['tr'],
          utterances: [{ words: [{ word: 'Merhaba.', start: 0.1, end: 0.9 }] }],
        },
      },
    },
  ],
  gemini: [
    {
      status: 'completed',
      outputs: [
        {
          type: 'text',
          text: 'Merhaba.',
          annotations: [
            { type: 'word_info', text: 'Merhaba.', start_offset: '0.1s', end_offset: '0.9s' },
          ],
        },
      ],
    },
  ],
};
const urls: Record<string, string[]> = {
  openai: ['https://api.openai.com/v1/audio/transcriptions'],
  groq: ['https://api.groq.com/openai/v1/audio/transcriptions'],
  mistral: ['https://api.mistral.ai/v1/audio/transcriptions'],
  compatible: ['https://fixture.invalid/v1/audio/transcriptions'],
  openrouter: ['https://openrouter.ai/api/v1/audio/transcriptions'],
  elevenlabs: ['https://api.elevenlabs.io/v1/speech-to-text'],
  gemini: ['https://generativelanguage.googleapis.com/v1beta/interactions'],
  xai: ['https://api.x.ai/v1/stt'],
  deepgram: [
    'https://api.deepgram.com/v1/listen?model=nova-3&smart_format=false&punctuate=true&language=tr',
  ],
  assemblyai: [
    'https://api.assemblyai.com/v2/upload',
    'https://api.assemblyai.com/v2/transcript',
    'https://api.assemblyai.com/v2/transcript/saved-id',
  ],
  speechmatics: [
    'https://eu1.asr.api.speechmatics.com/v2/jobs/',
    'https://eu1.asr.api.speechmatics.com/v2/jobs/saved-id',
    'https://eu1.asr.api.speechmatics.com/v2/jobs/saved-id/transcript?format=json-v2',
  ],
  gladia: [
    'https://api.gladia.io/v2/upload',
    'https://api.gladia.io/v2/pre-recorded',
    'https://api.gladia.io/v2/pre-recorded/saved-id',
  ],
};
for (const id of Object.keys(adapters)) {
  test(`${id}: request URL, authentication, audio fields and normalized timestamps`, async () => {
    const settings = {
      ...config,
      TRANSCRIBE_BACKEND: id,
      TRANSCRIPTION_MODEL:
        id === 'compatible' ? 'fixture-model' : id === 'openai' ? 'whisper-1' : '',
      TRANSCRIPTION_MODE: 'chunks',
      CLOUD_PRICE_PER_MINUTE: 0.01,
    };
    const selected = selection(settings, 'tr');
    const seen: { url: string; init: RequestInit; paid: boolean }[] = [];
    const state: Record<string, any> = {};
    const invoke = async (url: string, init: RequestInit = {}, paid = false) => {
      seen.push({ url, init, paid });
      assert.equal(url, urls[id][seen.length - 1]);
      const headers = new Headers(init.headers);
      const header =
        id === 'elevenlabs'
          ? 'xi-api-key'
          : id === 'gemini'
            ? 'x-goog-api-key'
            : id === 'gladia'
              ? 'x-gladia-key'
              : 'authorization';
      const expected =
        id === 'deepgram'
          ? 'Token fixture-key'
          : ['elevenlabs', 'gemini', 'gladia', 'assemblyai'].includes(id)
            ? 'fixture-key'
            : 'Bearer fixture-key';
      assert.equal(headers.get(header), expected);
      const result = fixtures[id][seen.length - 1];
      assert.ok(result, 'unexpected extra request');
      return structuredClone(result);
    };
    const context: CloudContext = {
      selected,
      settings,
      audio: Buffer.from('fLaCfixture'),
      format: 'flac',
      mime: 'audio/flac',
      language: 'tr',
      prompt: null,
      key: 'fixture-key',
      region: 'eu1',
      endpoint: 'https://fixture.invalid/v1/audio/transcriptions',
      signal: new AbortController().signal,
      state,
      save: async (patch) => {
        Object.assign(state, patch);
      },
      request: (url, init) => invoke(url, init),
      submit: (url, init) => invoke(url, init, true),
    };
    const result = await adapters[id](context);
    assert.equal(seen.length, urls[id].length);
    const paid = seen.filter((call) => call.paid);
    assert.equal(paid.length, 1);
    const body = paid[0].init.body;
    if (body instanceof FormData) {
      const fileName = id === 'speechmatics' ? 'data_file' : 'file';
      assert.equal((body.get(fileName) as File).name, 'audio.flac');
      assert.equal((body.get(fileName) as File).type, 'audio/flac');
      assert.equal(
        Buffer.from(await (body.get(fileName) as File).arrayBuffer()).toString(),
        'fLaCfixture',
      );
      if (id === 'mistral') {
        assert.equal(body.get('timestamp_granularities'), 'segment');
        assert.equal(body.get('language'), 'tr');
      } else if (id === 'elevenlabs') {
        assert.equal(body.get('language_code'), 'tr');
        assert.equal(body.get('timestamps_granularity'), 'word');
        assert.equal(body.get('tag_audio_events'), 'true');
      } else if (id === 'speechmatics')
        assert.equal(JSON.parse(String(body.get('config'))).transcription_config.language, 'tr');
      else if (id === 'xai') {
        assert.equal(body.get('vad_threshold'), '0');
        assert.equal([...body.keys()].at(-1), 'file');
      } else {
        assert.equal(body.get('response_format'), 'verbose_json');
        assert.deepEqual(body.getAll('timestamp_granularities[]'), ['segment', 'word']);
      }
    } else if (id === 'deepgram') assert.deepEqual(body, context.audio);
    else {
      const json = JSON.parse(String(body));
      if (id === 'openrouter') {
        assert.equal(json.input_audio.format, 'flac');
        assert.equal(json.input_audio.data, context.audio.toString('base64'));
      } else if (id === 'gemini') {
        assert.equal(json.store, false);
        assert.equal(json.input[0].mime_type, 'audio/flac');
        assert.deepEqual(json.generation_config.transcription_config.mode.timestamp_granularities, [
          'word',
        ]);
      } else if (id === 'assemblyai') {
        assert.deepEqual(json.speech_models, [selected.model.id]);
        assert.equal(json.language_code, 'tr');
      } else if (id === 'gladia')
        assert.deepEqual(json.language_config, { languages: ['tr'], code_switching: false });
    }
    const normalized = await normalize(
      result,
      { id: 0, startTime: 0, endTime: 1 },
      settings,
      selected,
    );
    assert.equal(normalized.text, 'Merhaba.');
    assert.equal(normalized.segments[0].text, 'Merhaba.');
    assert.equal(normalized.segments[0].start, 0.1);
    assert.equal(normalized.segments[0].end, 0.9);
  });
}
test('ElevenLabs remote recovery retrieves a saved transcript without a paid POST', async () => {
  let gets = 0;
  const ctx = {
    selected: selection(config),
    settings: config,
    state: { remoteId: 'existing-id' },
    key: 'fixture-key',
    request: async (url: string) => {
      gets++;
      assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text/transcripts/existing-id');
      return fixtures.elevenlabs[0];
    },
    submit: async () => {
      throw new Error('Unexpected paid POST');
    },
    save: async () => {},
  } as unknown as CloudContext;
  assert.equal((await adapters.elevenlabs(ctx)).text, 'Merhaba.');
  assert.equal(gets, 1);
});
