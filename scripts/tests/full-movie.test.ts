import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { after, test } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-movie-'));
process.env.DATA_DIR = root;
process.env.ELEVENLABS_API_KEY = 'test-only-fixture';
after(() => fs.rm(root, { recursive: true, force: true }));
const { config } = await import('../../config.js');
const { fullMovie, movieSettings } = await import('../lib/transcription-mode.js');
const { selection, estimate, validateProviderSettings } = await import('../providers/catalog.js');
const { normalize } = await import('../providers/normalize.js');
const { mergeSegments } = await import('../3.2_merge_sentences.js');
const { cleanSegments } = await import('../3.7_clean_srt.js');
const { transcribeCloud, cloudPlan } = await import('../providers/client.js');
const { runPipeline } = await import('../pipeline.js');
const { configurePausedAudio } = await import('../lib/source-audio.js');
const { createStages } = await import('../lib/progress.js');
const { at, readJson, writeJson } = await import('../lib/files.js');
const { speakerContext } = await import('../lib/speakers.js');
const { codexPrompt } = await import('../lib/codex-translation.js');
const settings = movieSettings({
  ...config,
  TRANSCRIBE_BACKEND: 'elevenlabs',
  TRANSCRIPTION_MODEL: 'scribe_v2',
  TRANSCRIPTION_MODE: 'movie',
  TRANSCRIPTION_DIARIZATION: true,
  LOCAL_AUDIO_ENABLED: false,
  TRANSLATION_ENABLED: false,
  CLOUD_MAX_ESTIMATED_COST: 1,
});
const response = {
  language_code: 'tr',
  text: 'Merhaba. Nasılsın?',
  words: [
    { text: 'Merhaba.', start: 0.1, end: 0.3, type: 'word', speaker_id: 'speaker_0' },
    { text: 'Nasılsın?', start: 0.4, end: 0.7, type: 'word', speaker_id: 'speaker_1' },
  ],
};

async function wav(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const b = Buffer.alloc(32044);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(32000, 40);
  await fs.writeFile(file, b);
}

test('full-film mode is explicit for ElevenLabs; estimates retain real audio duration', () => {
  assert.equal(fullMovie({ ...settings, TRANSCRIPTION_MODE: 'auto' }), true);
  assert.equal(fullMovie({ ...settings, TRANSCRIPTION_MODE: 'chunks' }), false);
  assert.equal(fullMovie({ ...settings, TRANSCRIPTION_MODE: undefined }), false);
  assert.throws(
    () =>
      validateProviderSettings({
        ...settings,
        TRANSCRIBE_BACKEND: 'openrouter',
        TRANSCRIPTION_MODEL: 'elevenlabs/scribe-v2',
      }),
    /requires direct ElevenLabs/,
  );
  assert.ok(
    Math.abs(estimate([{ startTime: 0, endTime: 5400 }], selection(settings)).amount! - 0.33) <
      1e-9,
  );
  const stages = createStages({ type: 'audio', settings });
  assert.equal(stages.find((s) => s.id === 'vad')?.status, 'skipped');
  assert.equal(stages.find((s) => s.id === 'alignment')?.status, 'skipped');
  assert.match(stages.find((s) => s.id === 'chunking')!.label, /Continuous/);
});

test('Scribe words override a whole-file segment, retain zero speaker ID, and survive cue merging', async () => {
  const result = await normalize(
    {
      text: 'Bir. Ah. İki.',
      segments: [{ start: 0, end: 600, text: 'Bir. Ah. İki.' }],
      words: [
        { word: 'Bir.', start: 12, end: 12.4, speaker: 0 },
        { word: 'Ah.', start: 13, end: 13, speaker: 1 },
        { word: 'İki.', start: 13.1, end: 13.4, speaker: 1 },
      ],
    },
    { id: 0, startTime: 0, endTime: 600 },
    settings,
    selection(settings),
  );
  assert.equal(result.segments[0].start, 12);
  assert.equal(result.segments[0].speaker, '0');
  assert.equal(result.segments[0].speakerScope, 'movie');
  const cues = cleanSegments(mergeSegments(result.segments, { settings }), { settings });
  assert.equal(cues.length, 2);
  assert.equal(cues[1].speaker, '1');
  assert.ok(cues[1].review?.includes('zero_duration_word'));
  assert.equal(cues[1].words?.[0].end, 13);
  const scoped = await normalize(
    { text: 'Bir.', words: [{ word: 'Bir.', start: 0, end: 0.5, speaker: 0 }] },
    { id: 170, startTime: 4200, endTime: 4225 },
    { ...settings, TRANSCRIPTION_MODE: 'chunks' },
    selection(settings),
  );
  assert.equal(scoped.segments[0].speakerScope, 'chunk_170');
  const separate = mergeSegments(
    [
      { start: 1, end: 2, text: 'Bir', speaker: '0', speakerScope: 'chunk_1' },
      { start: 2.1, end: 3, text: 'İki', speaker: '0', speakerScope: 'chunk_2' },
    ],
    { settings },
  );
  assert.equal(separate.length, 2);
});

test('native long-word intervals remain visible and are flagged instead of silently truncated', async () => {
  const result = await normalize(
    { text: 'Demek.', words: [{ word: 'Demek.', start: 1, end: 18.44, speaker: 0 }] },
    { id: 0, startTime: 0, endTime: 25 },
    settings,
    selection(settings),
  );
  const cue = cleanSegments(mergeSegments(result.segments, { settings }), { settings })[0];
  assert.equal(cue.end, 18.44);
  assert.ok(cue.review?.includes('unusually_long_word'));
  assert.ok(cue.review?.includes('duration_exceeds_limit'));
});

test('full-movie multipart uses a file-backed Blob above the chunk cap and caches a paid response', async () => {
  const file = path.join(root, 'large.flac');
  const handle = await fs.open(file, 'w');
  await handle.write(Buffer.from('fLaC'));
  await handle.truncate(21 * 1024 * 1024);
  await handle.close();
  const chunk = { id: 0, file, startTime: 0, endTime: 1 };
  const options = {
    rawDir: path.join(root, 'large-requests'),
    signature: 'fixture',
    plan: cloudPlan([chunk], settings),
  };
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.elevenlabs.io/v1/speech-to-text');
    calls++;
    const body = init?.body as FormData;
    assert.equal(body.get('model_id'), 'scribe_v2');
    assert.equal(body.get('diarize'), 'true');
    assert.equal(body.get('tag_audio_events'), 'true');
    const blob = body.get('file') as Blob;
    assert.equal(blob.size, 21 * 1024 * 1024);
    assert.equal(Buffer.from(await blob.slice(0, 4).arrayBuffer()).toString(), 'fLaC');
    return Response.json({
      ...response,
      words: [...response.words, { text: '(singing)', start: 0.8, end: 1, type: 'audio_event' }],
    });
  };
  try {
    const first = await transcribeCloud(chunk, 'tr', null, settings, options);
    assert.equal(first.segments[0].speaker, 'speaker_0');
    assert.deepEqual(first.audioEvents, [{ start: 0.8, end: 1, text: '(singing)' }]);
    assert.ok(first.segments.every((s) => !s.text.includes('singing')));
    const receipt = await readJson(path.join(options.rawDir, 'chunk_0.request.json'));
    assert.ok(receipt.result);
    assert.equal(receipt.submissionResponse, null);
    const second = await transcribeCloud(chunk, 'tr', null, settings, options);
    assert.equal(second._runtime.cached, true);
    assert.deepEqual(second.audioEvents, first.audioEvents);
    assert.equal(calls, 1);
    await assert.rejects(
      transcribeCloud(
        chunk,
        'tr',
        null,
        { ...settings, TRANSCRIPTION_AUDIO_EVENTS: false },
        options,
      ),
      /checkpoint does not match/,
    );
    await assert.rejects(
      transcribeCloud(
        chunk,
        'tr',
        null,
        { ...settings, TRANSCRIPTION_DIARIZATION: false },
        options,
      ),
      /checkpoint does not match/,
    );
    await assert.rejects(
      transcribeCloud(chunk, 'tr', null, { ...settings, TRANSCRIPTION_MODE: 'chunks' }, options),
      /20 MiB/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});

test('uncertain full-movie requests cannot silently submit and charge again', async () => {
  const file = path.join(root, 'uncertain.wav');
  await wav(file);
  const chunk = { id: 0, file, startTime: 0, endTime: 1 };
  const options = {
    rawDir: path.join(root, 'uncertain-requests'),
    signature: 'uncertain',
    plan: cloudPlan([chunk], settings),
  };
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(
      { error: 'fixture timeout' },
      { status: 504, headers: { 'x-request-id': 'uncertain-provider-receipt' } },
    );
  };
  try {
    await assert.rejects(transcribeCloud(chunk, 'tr', null, settings, options), /504/);
    assert.equal(
      (await readJson(path.join(options.rawDir, 'chunk_0.request.json'))).requestId,
      'uncertain-provider-receipt',
    );
    await assert.rejects(
      transcribeCloud(chunk, 'tr', null, settings, options),
      /may already have been charged/,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});

test('one-file pipeline pauses, resumes without local models, exports speakers and reuses ASR', async () => {
  const id = 'whole-film';
  const input = at('temp', id, 'source.wav');
  await wav(input);
  await writeJson(at('temp', id, 'manifest.json'), {
    version: 1,
    id,
    title: 'Fixture',
    type: 'audio',
    input,
    stage: 'new',
    lookedUp: true,
    warnings: [],
    settings: { ...settings, PAUSE_BEFORE_TRANSCRIPTION: true },
  });
  const seen: string[] = [];
  const options = {
    onStage: (s: any) => {
      if (s.status !== 'skipped') seen.push(s.id);
    },
    progress: async () => {},
  };
  const paused = await runPipeline({ id }, options);
  assert.equal(paused.paused, true);
  const manifest = await readJson(at('temp', id, 'manifest.json'));
  assert.equal(manifest.chunks.length, 1);
  assert.match(manifest.chunks[0].file, /movie\.flac$/);
  assert.equal(manifest.chunks[0].startTime, 0);
  assert.equal(seen.includes('vad'), false);
  assert.equal(seen.includes('transcription'), false);
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://api.elevenlabs.io/v1/speech-to-text');
    calls++;
    return Response.json(response);
  };
  try {
    const result = await runPipeline({ id }, { ...options, resume: true });
    assert.ok(result.speakerFile);
    assert.ok(result.subtitleAssFile);
    assert.ok(result.subtitleStyleReviewFile);
    const style = await readJson(at('output', 'reviews', `${id}-source-style.json`));
    assert.equal(style.profile.maxCharactersPerSecond, 17);
    assert.ok(style.warnings.some((w: any) => w.code === 'short_duration'));
    const speakers = await readJson(at('output', 'reviews', `${id}-speakers.json`));
    assert.deepEqual(
      speakers.cues.map((c: any) => [c.cueId, c.speaker, c.scope]),
      [
        ['1', 'speaker_0', 'movie'],
        ['2', 'speaker_1', 'movie'],
      ],
    );
    assert.equal(seen.includes('vad'), false);
    assert.equal(seen.includes('alignment'), false);
    await runPipeline({ id }, { ...options, resume: true });
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});

test('paused provider changes preserve old audio and refuse any existing ASR request evidence', async () => {
  const id = 'reconfigure';
  const file = at('temp', id, 'manifest.json');
  const original = {
    version: 1,
    id,
    stage: 'paused',
    settings: config,
    originalChunks: [{ id: 4, file: 'preserved.wav' }],
    chunks: [{ id: 4 }],
  };
  await writeJson(file, original);
  const result = await configurePausedAudio(id, settings);
  assert.equal(result.stage, 'new');
  assert.equal(result.settings.PAUSE_BEFORE_TRANSCRIPTION, true);
  assert.equal(result.chunks, undefined);
  assert.equal(result.archivedOriginalChunks[0].file, 'preserved.wav');
  assert.ok(
    (await fs.readdir(path.dirname(file))).some((f) => f.startsWith('manifest.before-options-')),
  );
  await fs.mkdir(at('output', 'raw_transcriptions', id), { recursive: true });
  await fs.writeFile(at('output', 'raw_transcriptions', id, 'chunk_0.request.lock'), 'pending');
  const before = await fs.readFile(file);
  await assert.rejects(configurePausedAudio(id, settings), /ASR checkpoints/);
  assert.deepEqual(await fs.readFile(file), before);
});

test('translation receives cue-linked speaker context without changing the source SRT', () => {
  const source = '1\n00:00:01,000 --> 00:00:02,000\nMerhaba.\n';
  const speakers = speakerContext([
    { id: '1', start: 1, end: 2, text: 'Merhaba.', speaker: '0', speakerScope: 'movie' },
  ]);
  const prompt = codexPrompt(source, { sourceLanguage: 'tr', targetLanguage: 'en', speakers });
  const data = JSON.parse(prompt.split('\n').at(-1)!);
  assert.equal(data.source_srt, source);
  assert.deepEqual(data.speakers.cues, [{ cueId: '1', speaker: '0', scope: 'movie' }]);
  assert.match(prompt, /Do not infer character names/);
});
