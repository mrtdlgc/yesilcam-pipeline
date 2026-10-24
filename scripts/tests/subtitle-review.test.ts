import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-review-'));
process.env.DATA_DIR = root;
after(() => fs.rm(root, { recursive: true, force: true }));
const { config } = await import('../../config.js');
const { at, writeJson } = await import('../lib/files.js');
const {
  createSubtitleReview,
  editSubtitleReview,
  readSubtitleReview,
  reviewExport,
  reviewView,
  saveReviewPosition,
} = await import('../lib/subtitle-review.js');
const { prepareReviewMedia, prepareSubtitleReview } = await import('../lib/review-preparation.js');
const { parseSrt } = await import('../lib/srt.js');
const { run, childEnvironment, probe } = await import('../lib/process.js');
const source =
  '1\n00:00:00,100 --> 00:00:01,000\nAnacığım!\n\n2\n00:00:02,000 --> 00:00:03,000\nGeliyorum.\n';
const target = source.replace('Anacığım!', 'Uncle!').replace('Geliyorum.', 'I am coming.');
const fixture = (id: string) =>
  createSubtitleReview({
    id,
    title: 'Test film',
    source,
    target,
    sourceLanguage: 'tr',
    targetLanguage: 'en',
    duration: 4,
    media: null,
  });

test('exports are usable immediately; corrections update paired timing and retain generated originals', async () => {
  const initial = await fixture('corrections');
  assert.match(reviewExport(initial, 'en', 'srt'), /Uncle!/);
  const edited = await editSubtitleReview(initial.id, {
    revision: 0,
    edits: [
      { id: '1', texts: { en: 'Mother!' }, start: 0.25, end: 1.25, note: 'Corrected kinship term' },
    ],
  });
  assert.equal(edited.revision, 1);
  const tr = parseSrt(reviewExport(edited, 'tr', 'srt')),
    en = parseSrt(reviewExport(edited, 'en', 'srt'));
  assert.equal(en[0].text, 'Mother!');
  assert.equal(tr[0].text, 'Anacığım!');
  assert.deepEqual(
    tr.map((cue) => [cue.id, cue.startTime, cue.endTime]),
    en.map((cue) => [cue.id, cue.startTime, cue.endTime]),
  );
  assert.equal(en[1].startTime, '00:00:02,000');
  assert.equal(parseSrt(reviewExport(edited, 'en', 'srt', true))[0].text, 'Uncle!');
  assert.match(reviewExport(edited, 'en', 'vtt'), /00:00:00.250 --> 00:00:01.250/);
  assert.match(reviewExport(edited, 'en', 'ass'), /Mother!/);
  assert.ok(reviewView(edited).cues[0].changed);
  assert.equal(
    (await fixture(initial.id)).revision,
    1,
    're-preparation preserves human corrections',
  );
  await saveReviewPosition(initial.id, 2.5);
  const reopened = await readSubtitleReview(initial.id);
  assert.equal(reopened.revision, 1);
  assert.equal(reopened.position, 2.5);
});
test('concurrent editors cannot silently replace each other or partially save a bad batch', async () => {
  await fixture('concurrent');
  const writes = await Promise.allSettled([
    editSubtitleReview('concurrent', {
      revision: 0,
      edits: [{ id: '1', texts: { en: 'Mother!' } }],
    }),
    editSubtitleReview('concurrent', {
      revision: 0,
      edits: [{ id: '2', texts: { en: 'Coming!' } }],
    }),
  ]);
  assert.equal(writes.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(writes.find((entry) => entry.status === 'rejected')!.reason.status, 409);
  const before = await readSubtitleReview('concurrent');
  await assert.rejects(
    editSubtitleReview('concurrent', {
      revision: 1,
      edits: [
        { id: '1', texts: { en: 'Would be lost.' } },
        { id: '2', start: 3.5, end: 2 },
      ],
    }),
    /end must be after/,
  );
  assert.deepEqual(await readSubtitleReview('concurrent'), before);
  for (const edit of [
    { id: '1', start: -1 },
    { id: '1', end: 10 },
    { id: '1', texts: { en: '' } },
    { id: '1', texts: { en: '<script>bad</script>' } },
    { id: '1', texts: { fr: 'wrong track' } },
    { id: 'missing', note: 'bad' },
  ])
    await assert.rejects(editSubtitleReview('concurrent', { revision: 1, edits: [edit] }));
  assert.deepEqual(await readSubtitleReview('concurrent'), before);
});
test('passage offsets, overlap warnings, missing dialogue, omission and restoration stay explicit', async () => {
  await fixture('passages');
  let document = await editSubtitleReview('passages', {
    revision: 0,
    shift: { fromId: '1', toId: '1', seconds: 1.5 },
  });
  assert.equal(document.cues[0].start, 1.6);
  assert.equal(document.cues[1].start, 2);
  assert.ok(
    reviewView(document).cues.some((cue) =>
      cue.warnings.some((warning) => warning.includes('overlap')),
    ),
  );
  await assert.rejects(
    editSubtitleReview('passages', {
      revision: 1,
      shift: { fromId: '1', toId: '2', seconds: -10 },
    }),
    /within the film/,
  );
  document = await editSubtitleReview('passages', {
    revision: 1,
    add: { start: 3.1, end: 3.9, texts: { tr: 'Bekle!', en: 'Wait!' } },
  });
  assert.equal(document.cues.length, 3);
  document = await editSubtitleReview('passages', {
    revision: 2,
    edits: [{ id: '1', omitted: true }],
  });
  assert.equal(parseSrt(reviewExport(document, 'en', 'srt')).length, 2);
  document = await editSubtitleReview('passages', {
    revision: 3,
    edits: [{ id: '1', reset: true }],
  });
  assert.equal(document.cues[0].start, 0.1);
  assert.equal(document.cues[0].omitted, false);
  assert.deepEqual(
    parseSrt(reviewExport(document, 'tr', 'srt')).map((cue) => cue.id),
    ['1', '2', '3'],
  );
  await assert.rejects(
    editSubtitleReview('passages', {
      revision: 4,
      edits: document.cues.map((cue) => ({ id: cue.id, omitted: true })),
    }),
    /at least one/,
  );
  await assert.rejects(
    createSubtitleReview({
      id: 'mismatch',
      title: 'Bad',
      source,
      target: target.replace('00:00:02,000', '00:00:02,001'),
      sourceLanguage: 'tr',
      targetLanguage: 'en',
      duration: 4,
      media: null,
    }),
    /matching cue/,
  );
});

const clip = at('temp', 'media-source', 'film.mkv');
async function makeClip() {
  await fs.mkdir(path.dirname(clip), { recursive: true });
  await run(
    'ffmpeg',
    [
      '-nostdin',
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=96x64:r=5:d=4',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=16000:cl=mono',
      '-t',
      '4',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      clip,
    ],
    { timeout: 10000 },
  );
}
test(
  'screening preparation remuxes real media, survives source cleanup and reuses completed work',
  { timeout: 15000 },
  async () => {
    await makeClip();
    const prepared = await prepareReviewMedia(clip, 'media-ready');
    assert.equal(prepared.media, 'screening.mp4');
    assert.ok(Math.abs(prepared.duration - 4) < 0.2);
    const output = at('review-sessions', 'media-ready', prepared.media);
    const before = await fs.stat(output);
    const repeated = await prepareReviewMedia(clip, 'media-ready');
    assert.deepEqual(repeated, prepared);
    assert.equal((await fs.stat(output)).mtimeMs, before.mtimeMs);
    assert.equal(
      (await probe(output)).streams.find((stream: any) => stream.codec_type === 'video').codec_name,
      'h264',
    );
    const unsupported = at('temp', 'media-source', 'legacy.avi');
    await run(
      'ffmpeg',
      [
        '-nostdin',
        '-y',
        '-v',
        'error',
        '-i',
        clip,
        '-c:v',
        'mpeg4',
        '-threads',
        '1',
        '-c:a',
        'pcm_s16le',
        unsupported,
      ],
      { timeout: 10000 },
    );
    const fallback = await prepareReviewMedia(unsupported, 'converted-media');
    const converted = await probe(at('review-sessions', 'converted-media', fallback.media));
    assert.equal(
      converted.streams.find((stream: any) => stream.codec_type === 'video').codec_name,
      'h264',
    );
    assert.equal(
      converted.streams.find((stream: any) => stream.codec_type === 'audio').codec_name,
      'aac',
    );
    const audio = at('temp', 'media-source', 'audio.wav');
    await run(
      'ffmpeg',
      ['-nostdin', '-y', '-v', 'error', '-i', clip, '-vn', '-c:a', 'pcm_s16le', audio],
      { timeout: 10000 },
    );
    const audioOnly = await prepareReviewMedia(audio, 'audio-review');
    assert.ok(
      (await probe(at('review-sessions', 'audio-review', audioOnly.media))).streams.every(
        (stream: any) => stream.codec_type === 'audio',
      ),
    );
  },
);
test('review preparation is independent of inference and rejects a changed source', async () => {
  await fs.mkdir(at('output', 'subtitles'), { recursive: true });
  await fs.writeFile(at('output', 'subtitles', 'tr.srt'), source);
  await fs.writeFile(at('output', 'subtitles', 'en.srt'), target);
  const result = {
    subtitleFile: '/output/subtitles/tr.srt',
    englishSubtitleFile: '/output/subtitles/en.srt',
    sourceLanguage: 'tr',
    targetLanguage: 'en',
  };
  const job: any = {
    id: 'pinned-source',
    title: 'Changed film',
    type: 'video',
    input: clip,
    sourceStat: { size: 1, mtimeMs: 1 },
    settings: config,
  };
  await assert.rejects(prepareSubtitleReview(job, result), /no longer matches/);
  const subtitlesOnly: any = { ...job, id: 'text-only', type: 'translation' };
  const links = await prepareSubtitleReview(subtitlesOnly, result);
  assert.equal(links.reviewStatus, 'ready');
  assert.equal((await readSubtitleReview('text-only')).media, null);
  await createSubtitleReview({
    id: 'media-ready',
    title: 'Source film',
    source,
    target,
    sourceLanguage: 'tr',
    targetLanguage: 'en',
    duration: 4,
    media: 'screening.mp4',
  });
  const linked = await prepareSubtitleReview(
    { ...subtitlesOnly, id: 'linked-translation', settings: { ...config, AUDIO_STREAM_INDEX: 1 } },
    result,
    {},
    { ...job, id: 'media-ready' },
  );
  assert.equal(
    linked.reviewStatus,
    'ready',
    'linked translations reuse the already selected audio track',
  );
  assert.equal((await readSubtitleReview('linked-translation')).media, 'screening.mp4');
  await assert.rejects(
    prepareSubtitleReview(
      { ...subtitlesOnly, id: 'wrong-parent-track' },
      result,
      {},
      {
        ...job,
        id: 'parent-without-screening',
        sourceStat: undefined,
        settings: { ...config, AUDIO_STREAM_INDEX: 7 },
      },
    ),
    /Review audio stream is missing/,
  );
});

test(
  'automatic job handoff, authenticated correction/export/range routes and persistence work under a subpath',
  { timeout: 25000 },
  async () => {
    const data = path.join(root, 'http');
    for (const dir of ['data', 'temp/queued', 'temp/recovered', 'output/subtitles'])
      await fs.mkdir(path.join(data, dir), { recursive: true });
    const input = path.join(data, 'temp/queued/movie.mkv');
    await fs.copyFile(clip, input);
    await fs.writeFile(path.join(data, 'output/subtitles/tr.srt'), source);
    await fs.writeFile(path.join(data, 'output/subtitles/en.srt'), target);
    const stat = await fs.stat(input);
    const result = {
      subtitleFile: '/output/subtitles/tr.srt',
      englishSubtitleFile: '/output/subtitles/en.srt',
      sourceLanguage: 'tr',
      targetLanguage: 'en',
    };
    const settings = { ...config, PREPARE_REVIEW: true, KEEP_INTERMEDIATES: false };
    const recoveryInput = path.join(data, 'temp/recovered/movie.mkv');
    await fs.copyFile(clip, recoveryInput);
    await writeJson(path.join(data, 'temp/queued/manifest.json'), {
      version: 1,
      id: 'queued',
      stage: 'completed',
      input,
      settings,
      sourceStat: { size: stat.size, mtimeMs: stat.mtimeMs },
      result,
    });
    await writeJson(path.join(data, 'data/processing-queue.json'), {
      version: 1,
      processed: {},
      jobs: [
        {
          id: 'queued',
          title: 'Queued fixture',
          type: 'video',
          input,
          settings,
          status: 'queued',
          progress: 100,
          logs: [],
          createdAt: new Date().toISOString(),
        },
        {
          id: 'recovered',
          title: 'Screening retry fixture',
          type: 'video',
          input: recoveryInput,
          settings,
          status: 'completed',
          progress: 100,
          logs: [],
          createdAt: new Date().toISOString(),
          result: { ...result, reviewStatus: 'failed' },
        },
      ],
    });
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`,
      base = `${origin}/studio`;
    let server: ReturnType<typeof spawn> | undefined, exited: Promise<unknown> | undefined;
    let cookie = '',
      errors = '';
    const request = (route: string, body?: unknown, extra: Record<string, string> = {}) =>
      fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          'X-Yesilcam-Request': '1',
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(2500),
      });
    async function until(check: () => Promise<boolean>) {
      for (let i = 0; i < 70; i++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      assert.fail(`Server/job did not become ready: ${errors}`);
    }
    async function start() {
      cookie = '';
      errors = '';
      server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...childEnvironment(),
          DATA_DIR: data,
          HOST: '127.0.0.1',
          PORT: String(port),
          PUBLIC_ORIGIN: origin,
          BASE_PATH: '/studio',
          APP_PASSWORD: 'review-fixture-password',
          SCANNER_ENABLED: 'false',
          TRANSLATION_ENABLED: 'false',
        },
      });
      server.stderr!.on('data', (chunk) => {
        errors = (errors + chunk).slice(-3000);
      });
      exited = once(server, 'exit');
      await until(() =>
        fetch(origin + '/health').then(
          (response) => response.ok,
          () => false,
        ),
      );
      assert.equal((await request('/api/reviews/queued')).status, 401);
      assert.equal((await request('/api/reviews/queued/subtitles/en.srt')).status, 401);
      assert.equal((await request('/api/reviews/queued/waveform', {})).status, 401);
      const login = await request('/api/auth/login', { password: 'review-fixture-password' });
      assert.equal(login.status, 200);
      cookie = login.headers.get('set-cookie')!.split(';')[0];
    }
    async function stop() {
      if (!server || server.exitCode !== null) return;
      server.kill('SIGTERM');
      const kill = setTimeout(() => server!.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(kill);
        server = undefined;
      }
    }
    try {
      await start();
      await until(
        async () =>
          (await (await request('/api/jobs/queued')).json()).intermediatesRemoved === true,
      );
      const job = await (await request('/api/jobs/queued')).json();
      assert.equal(job.status, 'completed');
      assert.equal(job.result.reviewStatus, 'ready');
      assert.equal(job.stages.find((stage: any) => stage.id === 'review').status, 'completed');
      await assert.rejects(fs.access(path.join(data, 'temp/queued')));
      const document = await (await request('/api/reviews/queued')).json();
      const media = await request(`/review-sessions/queued/${document.media}`, undefined, {
        Range: 'bytes=0-31',
      });
      assert.equal(media.status, 206);
      assert.equal((await media.arrayBuffer()).byteLength, 32);
      assert.equal(
        (await request('/api/reviews/queued/waveform', {}, { 'X-Yesilcam-Request': '' })).status,
        403,
      );
      const waveform = await request('/api/reviews/queued/waveform', {});
      assert.equal(waveform.status, 200);
      const energy = await waveform.json();
      assert.equal(energy.version, 1);
      assert.equal(Buffer.from(energy.peaks, 'base64').length, Math.ceil(document.duration * 100));
      assert.match(await (await request(job.result.currentSubtitleFile)).text(), /Uncle!/);
      const edit = {
        revision: 0,
        edits: [{ id: '1', texts: { en: 'Mother!' }, start: 0.2, end: 1.2 }],
      };
      assert.equal(
        (await request('/api/reviews/queued', edit, { 'X-Yesilcam-Request': '' })).status,
        403,
      );
      assert.equal(
        (await request('/api/reviews/queued', edit, { Origin: 'https://unrelated.example' }))
          .status,
        403,
      );
      assert.equal((await request('/api/reviews/queued', edit)).status, 200);
      assert.equal((await request('/api/reviews/queued', edit)).status, 409);
      assert.match(await (await request('/api/reviews/queued/subtitles/en.srt')).text(), /Mother!/);
      assert.match(
        await (await request('/api/reviews/queued/subtitles/en.srt?original=1')).text(),
        /Uncle!/,
      );
      assert.match(await fs.readFile(path.join(data, 'output/subtitles/en.srt'), 'utf8'), /Uncle!/);
      assert.equal((await request('/api/reviews/queued/position', { position: 2.5 })).status, 200);
      // Review-only retry works even though audio/intermediates have already been removed.
      assert.equal((await request('/api/jobs/queued/prepare-review', {})).status, 202);
      await until(
        async () =>
          (await (await request('/api/jobs/queued')).json()).result.reviewStatus === 'ready',
      );
      assert.equal((await request('/api/jobs/recovered/prepare-review', {})).status, 202);
      await until(
        async () =>
          (await (await request('/api/jobs/recovered')).json()).intermediatesRemoved === true,
      );
      assert.equal(
        (await (await request('/api/jobs/recovered')).json()).result.reviewStatus,
        'ready',
      );
      await assert.rejects(fs.access(recoveryInput));
      await stop();
      await start();
      const reopened = await (await request('/api/reviews/queued')).json();
      assert.equal(reopened.revision, 1);
      assert.equal(reopened.position, 2.5);
      assert.equal(reopened.cues[0].texts.en, 'Mother!');
      const privateFile = path.join(root, 'private.json');
      await fs.writeFile(privateFile, '{"private":true}');
      await fs.symlink(privateFile, path.join(data, 'data/subtitle-reviews/escape.json'));
      assert.equal((await request('/api/reviews/escape')).status, 400);
    } finally {
      await stop();
    }
  },
);
