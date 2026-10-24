import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';
import type { StageUpdate } from '../../types/pipeline.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-embedded-'));
process.env.DATA_DIR = root;
delete process.env.OPENSUBTITLES_API_KEY;
delete process.env.OPENSUBTITLES_TOKEN;
const fake = path.join(root, 'codex-fixture.cjs');
process.env.CODEX_BIN = fake;
const { config } = await import('../../config.js');
const { run, childEnvironment } = await import('../lib/process.js');
const { at, readJson } = await import('../lib/files.js');
const { embeddedTracks, extractEmbeddedSubtitles, subtitleLanguage } =
  await import('../lib/embedded-subtitles.js');
const { parseSrt } = await import('../lib/srt.js');
const { runPipeline } = await import('../pipeline.js');
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Network access is disabled for embedded subtitle fixtures');
};
after(() => {
  globalThis.fetch = originalFetch;
});
after(() => fs.rm(root, { recursive: true, force: true }));
const source =
  '1\n00:00:00,500 --> 00:00:01,500\n<i>Hello.</i>\n\n2\n00:00:04,250 --> 00:00:05,500\nCome home.\n';
const french = source.replace('Hello.', 'Bonjour.').replace('Come home.', 'Rentre chez toi.');
const translated = source.replace('Hello.', 'Merhaba.').replace('Come home.', 'Eve gel.');
const expectedTimes = (srt: string) =>
  parseSrt(srt).map((cue) => [cue.id, cue.startTime, cue.endTime]);
await fs.writeFile(
  fake,
  `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
if (args.includes('status')) { console.log('Logged in using ChatGPT'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync('fixture-calls.txt', 'exec\\n');
  fs.writeFileSync('fixture-prompt.txt', input);
  const payload = JSON.parse(input.trim().split('\\n').at(-1));
  if (payload.runs) throw new Error('Existing subtitles must use exact timing');
  let output = payload.source_srt.replaceAll('Hello.', 'Merhaba.').replaceAll('Come home.', 'Eve gel.');
  if (fs.existsSync(${JSON.stringify(path.join(root, 'fail-translation'))})) output = 'invalid output';
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], output);
  console.log(JSON.stringify({type:'turn.completed', usage:{input_tokens:20,output_tokens:20}}));
});
`,
  { mode: 0o700 },
);

const files = ['forced', 'sdh', 'normal', 'french'];
for (const name of files)
  await fs.writeFile(
    path.join(root, `${name}.srt`),
    name === 'french'
      ? french
      : name === 'forced'
        ? source.replace('Hello.', 'A road sign.')
        : name === 'sdh'
          ? source.replace('Hello.', '[MUSIC]')
          : source,
  );
const movie = path.join(root, 'multitrack.mkv');
await run(
  'ffmpeg',
  [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=black:s=64x64:r=5:d=8',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=8000:cl=mono:d=8',
    ...files.flatMap((name) => ['-i', path.join(root, `${name}.srt`)]),
    '-map',
    '0:v',
    '-map',
    '1:a',
    '-map',
    '2:s',
    '-map',
    '3:s',
    '-map',
    '4:s',
    '-map',
    '5:s',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'pcm_s16le',
    '-c:s',
    'srt',
    '-metadata:s:a:0',
    'language=eng',
    '-metadata:s:s:0',
    'language=eng',
    '-disposition:s:0',
    'forced',
    '-metadata:s:s:1',
    'language=eng',
    '-metadata:s:s:1',
    'title=English SDH',
    '-disposition:s:1',
    'default+hearing_impaired',
    '-metadata:s:s:2',
    'language=eng',
    '-metadata:s:s:2',
    'title=English Full',
    '-disposition:s:2',
    '0',
    '-metadata:s:s:3',
    'language=fra',
    '-disposition:s:3',
    '0',
    movie,
  ],
  { timeout: 10000 },
);

test('track selection recognizes language aliases and rejects bitmap, forced, signs, commentary and unknown-language tracks', () => {
  assert.equal(subtitleLanguage(' ENG '), 'en');
  assert.equal(subtitleLanguage('pt-BR'), 'pt');
  assert.equal(subtitleLanguage('fre'), 'fr');
  assert.equal(subtitleLanguage('und'), null);
  const stream = {
    index: 2,
    codec_type: 'subtitle',
    codec_name: 'subrip',
    tags: { language: 'eng' },
  };
  const tracks = embeddedTracks([
    { ...stream, disposition: { forced: 1 } },
    { ...stream, tags: { language: 'eng', title: 'Signs & Songs' } },
    { ...stream, tags: { language: 'eng', title: 'Director commentary' } },
    { ...stream, codec_name: 'hdmv_pgs_subtitle' },
    { ...stream, tags: { language: 'und' } },
    { ...stream, disposition: { hearing_impaired: 1 } },
    { ...stream, tags: { language: 'eng', title: 'Full dialogue and signs' } },
    { ...stream, tags: { language: 'eng', title: 'English - The Song of Names' } },
  ]);
  assert.ok(tracks.slice(0, 5).every((track) => track.reason));
  assert.match(tracks[3].reason!, /OCR/);
  assert.equal(tracks[5].reason, null, 'full SDH is a usable fallback');
  assert.equal(tracks[6].reason, null);
  assert.equal(tracks[7].reason, null, 'a film title is not a songs-only track');
});

test('real MKV selection prefers target then source/audio language and full dialogue over forced or SDH tracks', async () => {
  const options = { sourceLanguage: 'en', targetLanguage: 'tr' };
  const extracted = await extractEmbeddedSubtitles(movie, options);
  assert.equal(extracted.subtitle?.streamIndex, 4);
  assert.equal(extracted.subtitle?.language, 'en');
  assert.match(extracted.subtitle!.content, /<i>Hello\.<\/i>/);
  assert.deepEqual(expectedTimes(extracted.subtitle!.content), expectedTimes(source));
  assert.equal(extracted.report.tracks.filter((track) => track.selected).length, 1);
  const target = await extractEmbeddedSubtitles(movie, { ...options, targetLanguage: 'fr' });
  assert.equal(target.subtitle?.language, 'fr');
  assert.match(target.subtitle!.content, /Bonjour/);
  const auto = await extractEmbeddedSubtitles(movie, {
    sourceLanguage: 'auto',
    targetLanguage: 'uk',
  });
  assert.equal(auto.subtitle?.language, 'en');
  assert.equal(
    (await extractEmbeddedSubtitles(movie, { targetLanguage: 'eng' })).subtitle?.language,
    'eng',
  );
});

test('ASS and MP4 text tracks convert to timed SRT without audio transcription', async () => {
  for (const [extension, codec] of [
    ['mkv', 'ass'],
    ['mp4', 'mov_text'],
  ]) {
    const file = path.join(root, `converted.${extension}`);
    await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      movie,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-map',
      '0:4',
      '-c:v',
      'copy',
      '-c:a',
      extension === 'mp4' ? 'aac' : 'copy',
      '-c:s',
      codec,
      '-metadata:s:s:0',
      'language=eng',
      file,
    ]);
    const extracted = await extractEmbeddedSubtitles(file, {
      sourceLanguage: 'en',
      targetLanguage: 'tr',
    });
    assert.equal(extracted.subtitle?.codec, codec);
    assert.equal(parseSrt(extracted.subtitle!.content).length, 2);
    assert.match(extracted.subtitle!.content, /Hello/);
  }
});

const baseSettings = {
  ...config,
  TRANSLATION_ENABLED: true,
  TRANSLATION_MODE: 'editorial',
  DEFAULT_LANGUAGE: 'en',
  TARGET_LANGUAGE: 'tr',
  PAUSE_BEFORE_TRANSCRIPTION: true,
  EXPORT_TRANSLATION_CHUNKS: false,
  CODEX_TRANSLATION_TIMEOUT_MS: 3000,
};

test(
  'source subtitles go directly through fixed-timing translation, skip ASR and survive completed-job retry',
  { timeout: 10000 },
  async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('No network requests are allowed in this fixture');
    };
    try {
      const updates: StageUpdate[] = [];
      const result = await runPipeline(
        {
          id: 'from-embedded',
          type: 'video',
          input: movie,
          title: 'Embedded source',
          settings: baseSettings,
        },
        {
          onStage: (update) => {
            updates.push(update);
          },
        },
      );
      assert.equal(result.sourceLanguage, 'en');
      assert.equal(result.targetLanguage, 'tr');
      assert.equal(result.subtitleOrigin?.streamIndex, 4);
      assert.ok(result.embeddedSubtitleReportFile);
      assert.equal(result.usageFile, null);
      assert.equal(updates.find((update) => update.id === 'transcription')?.status, 'skipped');
      assert.ok(
        !updates.some(
          (update) =>
            ['chunking', 'transcription', 'alignment'].includes(update.id) &&
            update.status !== 'skipped',
        ),
      );
      const output = await fs.readFile(at(result.englishSubtitleFile.slice(1)), 'utf8');
      assert.match(output, /Merhaba/);
      assert.match(output, /Eve gel/);
      assert.deepEqual(expectedTimes(output), expectedTimes(translated));
      const manifest = await readJson(at('temp', 'from-embedded', 'manifest.json'));
      assert.equal(manifest.settings.TRANSLATION_MODE, 'fixed');
      assert.equal(manifest.chunks, undefined);
      assert.equal(manifest.sourceStat.size, (await fs.stat(movie)).size);
      assert.match(await fs.readFile(manifest.existingSubtitles.file, 'utf8'), /Hello/);
      const calls = at('temp', 'from-embedded', 'codex', 'fixture-calls.txt');
      const before = await fs.readFile(calls, 'utf8');
      assert.deepEqual(await runPipeline({ id: 'from-embedded' }), result);
      assert.equal(await fs.readFile(calls, 'utf8'), before);
      await assert.rejects(fs.access(at('output', 'raw_transcriptions', 'from-embedded')), {
        code: 'ENOENT',
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  },
);

test('target-language embedded subtitles skip translation too', async () => {
  const result = await runPipeline({
    id: 'ready-embedded',
    type: 'video',
    input: movie,
    settings: { ...baseSettings, TARGET_LANGUAGE: 'en' },
  });
  assert.equal(result.englishSubtitleFile, result.subtitleFile);
  assert.equal(result.sourceLanguage, 'en');
  await assert.rejects(fs.access(at('temp', 'ready-embedded', 'codex')), { code: 'ENOENT' });
});

test(
  'failed translation reuses the extracted track even if the original movie is no longer available',
  { timeout: 10000 },
  async () => {
    const copy = path.join(root, 'retry-movie.mkv');
    await fs.copyFile(movie, copy);
    await fs.writeFile(path.join(root, 'fail-translation'), 'fail');
    try {
      await assert.rejects(
        runPipeline({ id: 'retry-embedded', type: 'video', input: copy, settings: baseSettings }),
      );
    } finally {
      await fs.rm(path.join(root, 'fail-translation'));
    }
    const first = await readJson(at('temp', 'retry-embedded', 'manifest.json'));
    assert.ok(first.existingSubtitles?.hash);
    assert.equal(first.chunks, undefined);
    const original = await fs.readFile(first.existingSubtitles.file, 'utf8');
    await fs.appendFile(first.existingSubtitles.file, '\nchanged');
    await assert.rejects(runPipeline({ id: 'retry-embedded' }), /Saved existing subtitles changed/);
    await fs.writeFile(first.existingSubtitles.file, original);
    await fs.rm(copy);
    const stages: StageUpdate[] = [];
    const result = await runPipeline(
      { id: 'retry-embedded', codexRetry: true },
      {
        onStage: (update) => {
          stages.push(update);
        },
      },
    );
    assert.equal(result.sourceLanguage, 'en');
    assert.ok(!stages.some((update) => update.detail?.includes('Extracting embedded')));
    assert.equal(
      (await readJson(at('temp', 'retry-embedded', 'manifest.json'))).existingSubtitles.hash,
      first.existingSubtitles.hash,
    );
  },
);

test(
  'unusable or absent embedded tracks fall back to audio preparation, and changed input fails before reuse',
  { timeout: 10000 },
  async () => {
    const forced = path.join(root, 'forced-only.mkv');
    await run('ffmpeg', [
      '-v',
      'error',
      '-i',
      movie,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      '-map',
      '0:2',
      '-c',
      'copy',
      forced,
    ]);
    const warnings: string[] = [];
    assert.equal(
      (
        await extractEmbeddedSubtitles(forced, {
          onWarning: (message) => {
            warnings.push(message);
          },
        })
      ).subtitle,
      null,
    );
    assert.match(warnings.join(' '), /No usable/);
    const result = await runPipeline({
      id: 'fallback',
      type: 'video',
      input: forced,
      settings: baseSettings,
    });

    assert.equal(
      result.paused,
      true,
      'fallback stops at the existing audio-review gate before paid ASR',
    );
    assert.ok((await readJson(at('temp', 'fallback', 'manifest.json'))).chunks.length > 0);
    await assert.rejects(
      runPipeline({
        id: 'changed-input',
        type: 'video',
        input: movie,
        sourceStat: { size: 1, mtimeMs: 1 },
        settings: baseSettings,
      }),
      /Source changed/,
    );
  },
);

test(
  'HTTP uploads reuse embedded subtitles without an ASR key, while a fallback fails before audio work',
  { timeout: 20000 },
  async () => {
    const data = path.join(root, 'http');
    await fs.mkdir(path.join(data, 'data'), { recursive: true });
    await fs.writeFile(
      path.join(data, 'data', 'processing-queue.json'),
      JSON.stringify({
        version: 1,
        jobs: [],
        processed: {},
        control: { paused: false, scannerEnabled: false },
      }),
    );
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      env: {
        ...childEnvironment(),
        DATA_DIR: data,
        PORT: String(port),
        HOST: '127.0.0.1',
        PUBLIC_ORIGIN: origin,
        CODEX_BIN: fake,
        APP_PASSWORD: 'embedded-fixture-password',
        LOCAL_AUDIO_ENABLED: 'false',
        SHUTDOWN_GRACE_MS: '1000',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '',
      cookie = '';
    server.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = once(server, 'exit');
    async function until(check: () => Promise<boolean>) {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      assert.fail(`HTTP fixture did not finish: ${errors}`);
    }
    const request = (route: string, options: RequestInit = {}) =>
      originalFetch(origin + route, {
        ...options,
        headers: { Cookie: cookie, 'X-Yesilcam-Request': '1', ...options.headers },
        signal: AbortSignal.timeout(3000),
      });
    try {
      await until(() =>
        request('/health').then(
          (response) => response.ok,
          () => false,
        ),
      );
      const login = await request('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'embedded-fixture-password' }),
      });
      assert.equal(login.status, 200);
      cookie = login.headers.get('set-cookie')!.split(';')[0];
      const upload = (file: string) =>
        fs.readFile(file).then((body) =>
          request(
            '/api/upload-audio?' +
              new URLSearchParams({
                title: path.basename(file),
                sourceLanguage: 'en',
                targetLanguage: 'tr',
                provider: 'elevenlabs',
                model: 'scribe_v2',
                translateWithCodex: 'true',
                pauseBeforeTranscription: 'false',
                keepIntermediates: 'true',
              }),
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream' },
              body,
            },
          ),
        );
      const uploaded = await upload(movie);
      assert.equal(uploaded.status, 201, await uploaded.clone().text());
      const id = (await uploaded.json()).jobId;
      const job = () => request(`/api/jobs/${id}`).then((response) => response.json());
      await until(async () => ['completed', 'failed'].includes((await job()).status));
      const complete = await job();
      assert.equal(complete.status, 'completed', complete.error);
      assert.equal(complete.result.subtitleOrigin.source, 'embedded');
      assert.equal(
        complete.stages.find((stage: any) => stage.id === 'transcription').status,
        'skipped',
      );
      assert.match(await (await request(complete.result.englishSubtitleFile)).text(), /Merhaba/);
      assert.match(await (await request(complete.result.existingSubtitleFile)).text(), /Hello/);
      const without = path.join(root, 'no-subtitles.mkv');
      await run('ffmpeg', [
        '-v',
        'error',
        '-i',
        movie,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-c',
        'copy',
        without,
      ]);
      const fallback = await upload(without);
      assert.equal(fallback.status, 201);
      const failedId = (await fallback.json()).jobId;
      let failed: any;
      await until(async () => {
        failed = await (await request(`/api/jobs/${failedId}`)).json();
        return failed.status === 'failed';
      });
      assert.match(failed.error, /needs a key/);
      const manifest = JSON.parse(
        await fs.readFile(path.join(data, 'temp', failedId, 'manifest.json'), 'utf8'),
      );
      assert.equal(manifest.chunks, undefined, 'missing credentials fail before audio preparation');
      assert.equal(manifest.existingSubtitles, undefined);
    } finally {
      if (server.exitCode === null) server.kill('SIGTERM');
      const kill = setTimeout(() => server.kill('SIGKILL'), 4000);
      try {
        await exited;
      } finally {
        clearTimeout(kill);
      }
    }
  },
);
