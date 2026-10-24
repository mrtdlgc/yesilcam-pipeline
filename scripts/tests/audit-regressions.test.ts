import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { after, test } from 'node:test';
import express from 'express';
import type { Job } from '../../types/pipeline.js';
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-audit-'));
process.env.DATA_DIR = root;
process.env.APP_PASSWORD = 'fixture-password-only';
process.env.OPENSUBTITLES_API_KEY = 'fixture-key';
after(() => fs.rm(root, { recursive: true, force: true }));
const { config } = await import('../../config.js');
const { at, readJson, writeJson, persistentPath } = await import('../lib/files.js');
const { normalize } = await import('../providers/normalize.js');
const { selection } = await import('../providers/catalog.js');
const { cleanSegments } = await import('../3.7_clean_srt.js');
const { buildSandwichPrompt } = await import('../3_transcribe.js');
const { filterHallucinations } = await import('../3.1_filter_hallucinations.js');
const { alignSegments } = await import('../lib/alignment.js');
const { probe, run } = await import('../lib/process.js');
const { chunkAudio } = await import('../2.5_chunk_audio.js');
const { validateYouTubeUrl } = await import('../1_download_video.js');
const { searchOpenSubtitles } = await import('../0_check_subs.js');
const { prepareSubtitleReview } = await import('../lib/review-preparation.js');
const { createSubtitleReview, readSubtitleReview, reviewExport, saveReviewPosition } =
  await import('../lib/subtitle-review.js');
const { acquireProcessLock, processLockContents } = await import('../lib/process-identity.js');
const { reconcileRequest } = await import('../lib/request-recovery.js');
const { QueueStore, progressWriter } = await import('../lib/queue-store.js');

async function audio(file: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await run('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=500:duration=1',
    '-ar',
    '48000',
    '-ac',
    '2',
    file,
  ]);
}
const srt = '7\n00:00:00,100 --> 00:00:00,900\nMerhaba.\n';

test('isolated out-of-order, negative and out-of-range words retain paid transcript with flags', async () => {
  const result = await normalize(
    {
      text: 'Bir iki üç.',
      words: [
        { word: 'Bir', start: -0.01, end: 0.2 },
        { word: 'iki', start: 0.5, end: 0.7 },
        { word: 'üç.', start: 0.49, end: 1.4 },
      ],
    },
    { id: 0, startTime: 0, endTime: 1 },
    config,
    selection(config),
  );
  const words = result.segments.flatMap((cue) => cue.words!);
  assert.equal(words.length, 3);
  assert.deepEqual(
    words.map((word) => word.start),
    [0, 0.49, 0.5],
  );
  assert.ok(words.every((word) => word.end <= 1));
  assert.ok(result.segments.some((cue) => cue.review?.includes('timestamp_repaired')));
  await assert.rejects(
    normalize(
      { text: 'Bad', words: [{ start: 0, end: 1 }] },
      { id: 0, startTime: 0, endTime: 1 },
      config,
      selection(config),
    ),
    /malformed word text/,
  );
});
test('sub-millisecond and densely overlapping cues export on a valid millisecond timeline', () => {
  const cues = cleanSegments([
    { start: 1.0001, end: 1.0004, text: 'Bir' },
    { start: 1.0002, end: 1.0003, text: 'İki' },
    { start: 1.0002, end: 1.0003, text: 'Üç' },
  ]);
  cues.forEach((cue, index) => {
    assert.ok(cue.end > cue.start);
    if (index) assert.ok(cue.start >= cues[index - 1].end);
  });
  assert.ok(cues[0].review?.includes('timestamp_repaired'));
});
test('Russian and circumflex Turkish prompts remain usable', () => {
  for (const text of ['Россия большая', 'Âşık Veysel geldi'])
    assert.equal(buildSandwichPrompt({}, text), text);
  assert.equal(buildSandwichPrompt({}, 'bad\uFFFD'), null);
});
test('Turkish repetition and quiet low-confidence dialogue are flagged without deletion', async () => {
  const file = at('temp', 'filter', 'source.wav');
  await audio(file);
  const result = await filterHallucinations(file, [
    { start: 0, end: 0.9, text: 'çok çok çok çok', avg_logprob: -2 },
  ]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.dropped.length, 0);
  assert.ok(result.kept[0]._filterReasons?.includes('repeated_words_review'));
});
test('binary alignment handles inward boundaries and no-speech intervals', () => {
  const aligned = alignSegments(
    [
      { start: 0.1, end: 1.9, text: 'Merhaba' },
      { start: 4, end: 5, text: 'Sessiz' },
    ],
    [{ start: 0.3, end: 1.7 }],
    { method: 'energy', maxShift: 0.3, padding: 0 },
  );
  assert.equal(aligned[0].start, 0.3);
  assert.equal(aligned[0].end, 1.7);
  assert.ok(aligned[1].review?.includes('no_speech_at_cue'));
});
test('new cloud chunks are mono 16kHz signed-16 FLAC', async () => {
  const file = at('temp', 'compact', 'source.wav');
  await audio(file);
  const chunks = await chunkAudio(file, 'compact', {
    settings: { ...config, TRANSCRIPTION_MODE: 'chunks' },
  });
  assert.match(chunks[0].file, /\.flac$/);
  const info = await probe(chunks[0].file);
  assert.equal(info.streams[0].sample_rate, '16000');
  assert.equal(info.streams[0].channels, 1);
  assert.equal(info.streams[0].sample_fmt, 's16');
});
test('IMDb-only results are references, machine translations excluded and popularity ranked', async () => {
  const previous = globalThis.fetch;
  let selectedId: unknown;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/subtitles?'))
      return Response.json({
        data: [
          {
            attributes: {
              language: 'en',
              ai_translated: true,
              download_count: 1000,
              files: [{ file_id: 1 }],
            },
          },
          { attributes: { language: 'en', download_count: 5, files: [{ file_id: 2 }] } },
          { attributes: { language: 'en', download_count: 10, files: [{ file_id: 3 }] } },
        ],
      });
    if (String(url).endsWith('/download')) {
      selectedId = JSON.parse(String(init?.body)).file_id;
      return Response.json({ link: 'https://fixture.invalid/sub.srt' });
    }
    return new Response(srt);
  };
  try {
    const found = await searchOpenSubtitles({ imdbId: 'tt1234567' });
    assert.equal(selectedId, 3);
    assert.equal(found?.referenceOnly, true);
  } finally {
    globalThis.fetch = previous;
  }
});
test('YouTube URL variants normalize and foreign hosts/credentials/playlists are rejected', () => {
  for (const url of [
    'https://youtu.be/abcdefghijk?t=1',
    'https://youtube.com/shorts/abcdefghijk',
    'https://www.youtube.com/embed/abcdefghijk',
    'https://m.youtube.com/watch?v=abcdefghijk',
  ])
    assert.equal(validateYouTubeUrl(url), 'https://www.youtube.com/watch?v=abcdefghijk');
  for (const url of [
    'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://user@youtube.com/watch?v=abcdefghijk',
    'file:///tmp/a',
    'https://youtube.com/playlist?list=abc',
    'https://youtube.com:444/watch?v=abcdefghijk',
  ])
    assert.throws(() => validateYouTubeUrl(url));
});
test('screening re-download is removed after preparing an already-cleaned YouTube job', async () => {
  const file = at('temp', 'fixture-source.wav');
  await audio(file);
  const downloader = path.join(root, 'fake-ytdlp.cjs');
  await fs.writeFile(
    downloader,
    `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);if(args.includes('--dump-single-json')){console.log(JSON.stringify({duration:1}));}else{const out=args[args.indexOf('-o')+1].replace('%(ext)s','wav');fs.mkdirSync(path.dirname(out),{recursive:true});fs.copyFileSync(${JSON.stringify(file)},out);console.log(out);}`,
    { mode: 0o700 },
  );
  const previous = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = downloader;
  await fs.mkdir(at('output', 'subtitles'), { recursive: true });
  await fs.writeFile(at('output', 'subtitles', 'fixture.srt'), srt);
  try {
    const job = {
      id: 'cleaned-youtube',
      title: 'Fixture',
      type: 'youtube',
      youtubeUrl: 'https://youtu.be/abcdefghijk',
      intermediatesRemoved: true,
      settings: { ...config, KEEP_INTERMEDIATES: false, MIN_FREE_DISK_BYTES: 0 },
      status: 'completed',
    } as Job;
    const result = await prepareSubtitleReview(job, {
      subtitleFile: '/output/subtitles/fixture.srt',
      sourceLanguage: 'tr',
    });
    assert.equal(result.reviewStatus, 'ready');
    await assert.rejects(fs.access(at('temp', job.id)), /ENOENT/);
    assert.ok((await readSubtitleReview(job.id)).media);
  } finally {
    if (previous === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = previous;
  }
});
test('current exports renumber cues while originals and stable review IDs survive', async () => {
  const document = await createSubtitleReview({
    id: 'numbers',
    title: 'Fixture',
    source: srt,
    sourceLanguage: 'tr',
    targetLanguage: 'en',
    duration: 1,
    media: null,
  });
  assert.match(reviewExport(document, 'tr', 'srt'), /^1\n/);
  assert.match(reviewExport(document, 'tr', 'srt', true), /^7\n/);
  assert.equal(document.cues[0].id, '7');
  assert.equal('text' in document.cues[0], false);
  const before = await fs.readFile(at('data', 'subtitle-reviews', 'numbers.json'), 'utf8');
  await saveReviewPosition('numbers', 0.5);
  assert.equal(await fs.readFile(at('data', 'subtitle-reviews', 'numbers.json'), 'utf8'), before);
  assert.equal((await readSubtitleReview('numbers')).position, 0.5);
});
test('dead request locks are reclaimed, live locks refused, archived costs retained', async () => {
  const dir = at('output', 'raw_transcriptions', 'recover');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'chunk_0.request.lock');
  await fs.writeFile(file, '99999999');
  const release = await acquireProcessLock(file);
  await release();
  await fs.writeFile(file, await processLockContents());
  await assert.rejects(acquireProcessLock(file), /live process/);
  await fs.unlink(file);
  await writeJson(path.join(dir, 'chunk_0.request.json'), {
    version: 1,
    chunkId: 0,
    provider: 'elevenlabs',
    status: 'uncertain',
    estimate: { amount: 0.1, currency: 'USD' },
  });
  await assert.rejects(
    reconcileRequest('recover', '0', { allowNewRequest: true, note: ' ' }),
    /note/,
  );
  await assert.rejects(reconcileRequest('recover', '0', { remoteId: '' }), /transcript ID/);
  await reconcileRequest('recover', '0', { remoteId: 'saved-id' });
  assert.equal((await readJson(path.join(dir, 'chunk_0.request.json'))).status, 'accepted');
  await reconcileRequest('recover', '0', {
    allowNewRequest: true,
    note: 'Provider dashboard checked; authorize another attempt.',
  });
  const archived = (await fs.readdir(dir)).find((name) => name.includes('.attempt-'))!;
  assert.equal((await readJson(path.join(dir, archived))).estimate.amount, 0.1);
});
test('queue settings and logs survive compact persistence and reload', async () => {
  const file = at('data', 'fixture-queue.json');
  const initial = { version: 1, jobs: [] as Job[], processed: {} };
  const queue = new QueueStore(file, initial);
  const job = {
    id: 'compact-queue',
    type: 'audio',
    title: 'Fixture',
    settings: { ...config, DEFAULT_LANGUAGE: 'tr' },
    status: 'completed',
    progress: 100,
    createdAt: new Date().toISOString(),
    logs: [{ time: '', message: 'Keep this warning' }],
  } as Job;
  await queue.update((state) => {
    state.jobs.push(job);
  });
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(stored.jobs[0].logs, undefined);
  assert.deepEqual(stored.jobs[0].settings, {});
  const reopened = await new QueueStore(file, initial).read();
  assert.deepEqual(reopened.jobs[0], job);
  let writes = 0;
  const writer = progressWriter(async (mutate) => {
    writes++;
    mutate(job);
  });
  for (let i = 0; i < 10; i++)
    await writer.push((item) => {
      item.progress = i;
    });
  assert.equal(writes, 1);
  await writer.flush();
  assert.equal(writes, 2);
  assert.equal(job.progress, 9);
});
test('new manifest paths are portable and reject traversal when decoded', async () => {
  const file = at('data', 'portable.json');
  await writeJson(file, {
    pathSchema: 1,
    input: at('temp', 'portable', 'source.wav'),
    chunks: [{ file: at('temp', 'portable', 'movie.flac') }],
  });
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(raw.input, '@data/temp/portable/source.wav');
  assert.equal((await readJson(file)).input, at('temp', 'portable', 'source.wav'));
  assert.equal(
    persistentPath(at('temp', 'portable', 'movie.flac')),
    '@data/temp/portable/movie.flac',
  );
  await fs.writeFile(file, JSON.stringify({ pathSchema: 1, input: '@data/../private' }));
  await assert.rejects(readJson(file), /Invalid filename/);
});
test('FFmpeg rejects network protocols in uploaded playlists', async () => {
  const playlist = at('temp', 'remote.m3u8');
  await fs.writeFile(
    playlist,
    '#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/untrusted.ts\n#EXT-X-ENDLIST\n',
  );
  await assert.rejects(probe(playlist), /Protocol.*not on whitelist/);
});
test('login failures do not globally lock out owner; successes never consume the throttle', async () => {
  const { initializePassword, installAuth } = await import('../lib/auth.js');
  await initializePassword();
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use(express.json());
  const router = express.Router();
  installAuth(router, new URL('http://localhost'), '');
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const login = (ip: string, password: string) =>
    fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ password }),
    });
  try {
    for (let i = 0; i < 31; i++)
      assert.equal((await login(`198.51.100.${i + 1}`, 'bad')).status, 401);
    for (let i = 0; i < 12; i++)
      assert.equal((await login('203.0.113.1', 'fixture-password-only')).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await login('203.0.113.2', 'bad')).status, 401);
    assert.equal((await login('203.0.113.2', 'bad')).status, 429);
    assert.equal((await login('203.0.113.1', 'fixture-password-only')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
test('shutdown drain preserves in-flight work and blocks any new paid submission', async () => {
  const { trackPaidWork, drainPaidWork, assertPaidSubmissionAllowed } =
    await import('../lib/paid-work.js');
  let finish!: () => void;
  let saved = false;
  const work = trackPaidWork(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    saved = true;
  });
  const drained = drainPaidWork(1000);
  assert.throws(assertPaidSubmissionAllowed, /cancelled/);
  assert.equal(saved, false);
  finish();
  await drained;
  await work;
  assert.equal(saved, true);
});
