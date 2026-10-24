import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';

const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-progress-'));
process.env.DATA_DIR = fixtureRoot;
after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
const { config } = await import('../../config.js');
const { createStages, applyStage, stopStages, progressLines, downloadProgress, needsAudioReview } =
  await import('../lib/progress.js');
const { audioReview, audioReviewFile } = await import('../lib/audio-review.js');
const { runPipeline } = await import('../pipeline.js');
const { migratePreparedAudio } = await import('../lib/source-audio.js');
const { at, writeJson, readJson } = await import('../lib/files.js');
const { childEnvironment } = await import('../lib/process.js');

test('stage plans label skipped local/disabled work and isolate standalone translation', () => {
  const stages = createStages({
    type: 'audio',
    settings: {
      ...config,
      DEMUCS_ENABLED: false,
      ALIGN_TO_SPEECH: false,
      SILERO_VAD_ENABLED: false,
    },
  });
  assert.equal(stages.length, 10);
  assert.equal(
    stages.find((s) => s.id === 'demucs'),
    undefined,
  );
  for (const id of ['download', 'vad', 'alignment', 'translation'])
    assert.equal(stages.find((s) => s.id === id)?.status, 'skipped');
  assert.deepEqual(
    createStages({ type: 'translation', settings: config }).map((s) => s.id),
    ['translation', 'review'],
  );
  assert.equal(stages.find((stage) => stage.id === 'review')?.status, 'pending');
  assert.equal(
    createStages({ type: 'translation', settings: { ...config, PREPARE_REVIEW: false } }).find(
      (stage) => stage.id === 'review',
    )?.status,
    'skipped',
  );
});
test('completed chunk counts drive progress; interruptions retain the last measured amount', () => {
  const stages = createStages({ type: 'youtube', settings: config });
  applyStage(stages, { id: 'chunking', completed: 63, total: 219, unit: 'chunks' });
  const stage = stages.find((s) => s.id === 'chunking')!;
  assert.equal(stage.percentage, (63 / 219) * 100);
  stopStages(stages, 'interrupted');
  assert.equal(stage.status, 'interrupted');
  assert.equal(stage.completed, 63);
  assert.equal(stages.find((s) => s.id === 'transcription')?.status, 'pending');
  applyStage(stages, { id: 'chunking', completed: 219, total: 219, status: 'completed' });
  assert.equal(stage.percentage, 100);
  assert.throws(() => applyStage(stages, { id: 'chunking', completed: NaN }));
  assert.throws(() => applyStage(stages, { id: 'chunking', total: 0 }));
});
test('unknown percentages stay indeterminate; exact and estimated download totals are handled', () => {
  const stages = createStages({ type: 'youtube', settings: config });
  applyStage(stages, { id: 'subtitles', percentage: null });
  assert.equal(stages[0].percentage, null);
  assert.equal(downloadProgress({ downloaded_bytes: 50, total_bytes: 100 }).percentage, 50);
  const estimated = downloadProgress({
    downloaded_bytes: 50,
    total_bytes: 'NA',
    total_bytes_estimate: 200,
  });
  assert.equal(estimated.percentage, 25);
  assert.match(estimated.detail!, /estimated/);
  assert.equal(downloadProgress({ downloaded_bytes: 50, total_bytes: 'NA' }).percentage, null);
});
test('worker progress survives split lines and awaits ordered persistence before completion', async () => {
  const values: number[] = [];
  const reader = progressLines(async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value.completed === 1 ? 10 : 0));
    values.push(value.completed);
  });
  reader.push('ordinary log\nYESILCAM_PRO');
  reader.push('GRESS {"completed":1,"total":2}\r\nYESILCAM_PROGRESS {"completed":');
  reader.push('2,"total":2}');
  await reader.finish();
  assert.deepEqual(values, [1, 2]);
  const failed = progressLines(async () => {
    throw new Error('disk full');
  });
  failed.push('YESILCAM_PROGRESS {}\n');
  await assert.rejects(failed.finish(), /disk full/);
});
test('retrying preparation cannot bypass review; legacy review pauses still work', () => {
  const current = { PAUSE_BEFORE_TRANSCRIPTION: true };
  assert.equal(needsAudioReview({ stage: 'prepared', settings: current }, true), true);
  assert.equal(needsAudioReview({ stage: 'paused', settings: current }, false), true);
  assert.equal(needsAudioReview({ stage: 'paused', settings: current }, true), false);
  const settings = { PAUSE_AFTER_DEMUCS: true };
  assert.equal(needsAudioReview({ stage: 'separated', settings }, true), true);
  assert.equal(needsAudioReview({ stage: 'paused', settings }, false), true);
  assert.equal(needsAudioReview({ stage: 'paused', settings }, true), false);
  assert.equal(needsAudioReview({ stage: 'ready', settings }, false), false);
});
test('pipeline recovery actually stops before any audio or ASR process is launched', async () => {
  const id = 'pause-recovery';
  const chunks = [
    { id: 0, file: '/nonexistent/audio-must-not-be-opened.wav', startTime: 0, endTime: 10 },
  ];
  await writeJson(at('temp', id, 'manifest.json'), {
    version: 1,
    id,
    title: 'Review',
    type: 'audio',
    stage: 'prepared',
    settings: { ...config, PAUSE_BEFORE_TRANSCRIPTION: true },
    chunks,
    originalChunks: chunks,
  });
  const seen: string[] = [];
  const result = await runPipeline(
    { id },
    {
      resume: true,
      onStage: (update) => {
        seen.push(update.id);
      },
    },
  );
  assert.equal(result.paused, true);
  assert.equal((await readJson(at('temp', id, 'manifest.json'))).stage, 'paused');
  assert.ok(!seen.includes('vad') && !seen.includes('transcription'));
  assert.ok(!seen.includes('demucs'));
});

async function audioFixture(id: string, dataRoot = fixtureRoot) {
  const work = path.join(dataRoot, 'temp', id);
  await fs.mkdir(path.join(work, 'vocals'), { recursive: true });
  const original = path.join(work, 'chunk_00000.wav');
  const vocals = path.join(work, 'vocals', 'chunk_00000_vocals.wav');
  await fs.writeFile(original, Buffer.alloc(128, 1));
  await fs.writeFile(vocals, Buffer.alloc(256, 2));
  const settings = {
    ...config,
    DEMUCS_ENABLED: true,
    PAUSE_AFTER_DEMUCS: true,
    TRANSCRIBE_BACKEND: 'local',
    TRANSCRIPTION_MODEL: 'large-v3',
  };
  const manifest = {
    version: 1,
    id,
    title: 'Audio review fixture',
    type: 'audio',
    stage: 'paused',
    settings,
    chunks: [{ id: 0, file: vocals, startTime: 123.25, endTime: 148.25 }],
    originalChunks: [{ id: 0, file: original, startTime: 123.25, endTime: 148.25 }],
  };
  await writeJson(path.join(work, 'manifest.json'), manifest);
  const metadata = path.join(work, 'vocals', 'chunk_00000_vocals.json');
  await writeJson(metadata, {
    size: 256,
    identity: {
      model: settings.DEMUCS_MODEL,
      shifts: settings.DEMUCS_SHIFTS,
      overlap: settings.DEMUCS_OVERLAP,
      source_sha256: 'a'.repeat(64),
    },
  });
  return { work, original, vocals, metadata, manifest };
}

test('source preparation creates original chunks and pauses without separation or ASR', async () => {
  const id = 'original-preparation';
  const input = at('temp', id, 'source.wav');
  await fs.mkdir(path.dirname(input), { recursive: true });
  // One second of PCM silence exercises the real, bounded FFmpeg chunker.
  const wav = Buffer.alloc(44 + 32000);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(32000, 40);
  await fs.writeFile(input, wav);
  await writeJson(at('temp', id, 'manifest.json'), {
    version: 1,
    id,
    title: 'Original preparation',
    type: 'audio',
    stage: 'new',
    input,
    lookedUp: true,
    warnings: [],
    settings: { ...config, PAUSE_BEFORE_TRANSCRIPTION: true },
  });
  const stages: string[] = [];
  const result = await runPipeline(
    { id },
    {
      onStage: (update) => {
        stages.push(update.id);
      },
    },
  );
  const manifest = await readJson(at('temp', id, 'manifest.json'));
  assert.equal(result.paused, true);
  assert.equal(manifest.audioInput, 'original');
  assert.equal(manifest.chunks.length, 1);
  assert.equal(manifest.chunks[0].file, manifest.originalChunks[0].file);
  assert.ok(manifest.chunks[0].audioStat.size > 44);
  assert.ok(stages.includes('chunking'));
  assert.ok(!stages.includes('demucs') && !stages.includes('transcription'));
  await assert.rejects(fs.access(at('temp', id, 'vocals')), /ENOENT/);
  const review = await audioReview(id);
  assert.equal(review.originalsReady, 1);
  assert.equal(review.hasVocalComparison, false);
});
test('audio review exposes paired offsets only after the vocal file is committed', async () => {
  const f = await audioFixture('review-files');
  const ready = await audioReview('review-files');
  assert.equal(ready.ready, 1);
  assert.equal(ready.chunks[0].start, 123.25);
  assert.equal(await audioReviewFile('review-files', '0', 'vocals'), f.vocals);
  await fs.truncate(f.vocals, 100);
  assert.equal((await audioReview('review-files')).ready, 0);
  await assert.rejects(audioReviewFile('review-files', '0', 'vocals'), /not finished/);
  await assert.rejects(audioReviewFile('review-files', '../0', 'original'), /not found/);
});
test('audio routes cannot follow a manifest or vocal symlink outside the job folder', async () => {
  const f = await audioFixture('review-symlink');
  const outside = path.join(fixtureRoot, 'private.wav');
  await fs.writeFile(outside, Buffer.alloc(256));
  await fs.unlink(f.vocals);
  await fs.symlink(outside, f.vocals);
  await assert.rejects(audioReviewFile('review-symlink', '0', 'vocals'), /escapes/);
  f.manifest.originalChunks[0].file = outside;
  await writeJson(path.join(f.work, 'manifest.json'), f.manifest);
  await assert.rejects(audioReviewFile('review-symlink', '0', 'original'), /Invalid filename/);
});

test('pre-ASR migration selects original audio and Scribe, preserves pause and archived vocals', async () => {
  const f = await audioFixture('migrate-review');
  const before = await fs.readFile(path.join(f.work, 'manifest.json'), 'utf8');
  const migrated = await migratePreparedAudio('migrate-review');
  assert.equal(migrated.stage, 'paused');
  assert.equal(migrated.settings.TRANSCRIBE_BACKEND, 'openrouter');
  assert.equal(migrated.settings.TRANSCRIPTION_MODEL, 'elevenlabs/scribe-v2');
  assert.equal(migrated.settings.DEMUCS_ENABLED, false);
  assert.equal(migrated.settings.PAUSE_BEFORE_TRANSCRIPTION, true);
  assert.equal(migrated.chunks[0].file, f.original);
  assert.equal(migrated.chunks[0].audioStat.size, 128);
  assert.equal(migrated.profilesPrepared, false);
  assert.equal(await fs.readFile(migrated.originalAudioMigration.backup, 'utf8'), before);
  assert.equal(await audioReviewFile('migrate-review', '0', 'vocals'), f.vocals);
  const review = await audioReview('migrate-review');
  assert.equal(review.archivedVocals, true);
  assert.equal(review.ready, 1);
  const second = await migratePreparedAudio('migrate-review');
  assert.equal(second.originalAudioMigration.at, migrated.originalAudioMigration.at);
  assert.equal(await fs.readFile(migrated.originalAudioMigration.backup, 'utf8'), before);
});

test('ASR request checkpoints prevent migration and duplicate inference identities', async () => {
  const f = await audioFixture('migrate-paid');
  const before = await fs.readFile(path.join(f.work, 'manifest.json'), 'utf8');
  await writeJson(at('output', 'raw_transcriptions', 'migrate-paid', 'chunk_0.request.json'), {
    status: 'uncertain',
    requestId: 'already-submitted',
  });
  assert.equal(await migratePreparedAudio('migrate-paid'), null);
  assert.equal(await fs.readFile(path.join(f.work, 'manifest.json'), 'utf8'), before);
});

test('missing original audio leaves a legacy manifest unchanged', async () => {
  const f = await audioFixture('migrate-missing');
  const before = await fs.readFile(path.join(f.work, 'manifest.json'), 'utf8');
  await fs.unlink(f.original);
  await assert.rejects(migratePreparedAudio('migrate-missing'), /ENOENT/);
  assert.equal(await fs.readFile(path.join(f.work, 'manifest.json'), 'utf8'), before);
});

test(
  'audio HTTP routes require login and support range requests without exposing arbitrary files',
  { timeout: 12000 },
  async () => {
    const dataRoot = path.join(fixtureRoot, 'http');
    const fixture = await audioFixture('review-http', dataRoot);
    await writeJson(path.join(dataRoot, 'data', 'processing-queue.json'), {
      version: 1,
      processed: {},
      jobs: [
        {
          id: 'review-http',
          type: 'audio',
          title: 'Review',
          status: 'paused',
          progress: 25,
          settings: fixture.manifest.settings,
          logs: [],
        },
      ],
    });
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...childEnvironment(),
        DATA_DIR: dataRoot,
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        BASE_PATH: '',
        APP_PASSWORD: 'progress-test-password-123',
      },
    });
    let error = '';
    server.stderr.on('data', (chunk) => {
      error = (error + chunk).slice(-4000);
    });
    const closed = once(server, 'exit');
    const get = (url: string, options: RequestInit = {}) =>
      fetch(origin + url, { ...options, signal: AbortSignal.timeout(2000) });
    try {
      let ready = false;
      for (let i = 0; i < 40; i++) {
        ready = await get('/health').then(
          (r) => r.ok,
          () => false,
        );
        if (ready) break;
        if (server.exitCode !== null) throw new Error(error);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, error);
      assert.equal((await get('/api/jobs/review-http/audio-review')).status, 401);
      assert.equal((await get('/api/jobs/review-http/audio/0/vocals')).status, 401);
      const login = await get('/api/auth/login', {
        method: 'POST',
        headers: { 'X-Yesilcam-Request': '1', Origin: origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'progress-test-password-123' }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const paused = await (
        await get('/api/jobs/review-http', { headers: { Cookie: cookie } })
      ).json();
      assert.equal(paused.status, 'paused');
      assert.equal(paused.settings.TRANSCRIPTION_MODEL, 'elevenlabs/scribe-v2');
      assert.equal(paused.settings.DEMUCS_ENABLED, false);
      assert.equal(
        paused.stages.find((stage: any) => stage.id === 'demucs'),
        undefined,
      );
      assert.equal(paused.stages.find((stage: any) => stage.id === 'chunking').status, 'completed');
      assert.equal(
        paused.stages.find((stage: any) => stage.id === 'transcription').status,
        'pending',
      );
      const review = await (
        await get('/api/jobs/review-http/audio-review', { headers: { Cookie: cookie } })
      ).json();
      assert.equal(review.ready, 1);
      const ranged = await get(review.chunks[0].vocalsUrl, {
        headers: { Cookie: cookie, Range: 'bytes=0-15' },
      });
      assert.equal(ranged.status, 206);
      assert.equal((await ranged.arrayBuffer()).byteLength, 16);
      assert.match(ranged.headers.get('content-type')!, /audio\/wav/);
      assert.equal(
        (await get('/api/jobs/review-http/audio/0/private', { headers: { Cookie: cookie } }))
          .status,
        404,
      );
      assert.equal(
        (await get('/api/jobs/not-a-job/audio/0/original', { headers: { Cookie: cookie } })).status,
        404,
      );
    } finally {
      server.kill('SIGTERM');
      const kill = setTimeout(() => server.kill('SIGKILL'), 3000);
      await closed;
      clearTimeout(kill);
    }
  },
);
