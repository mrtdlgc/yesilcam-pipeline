import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { config } from '../../config.js';
import { childEnvironment } from '../lib/process.js';
import type { QueueState } from '../../types/pipeline.js';

const source = '1\n00:00:01,000 --> 00:00:03,000\nMerhaba.\n';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  'batch controls bound work, stop after failure, retain receipts, protect review media and survive restart',
  { timeout: 30000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-batch-'));
    const fake = path.join(root, 'codex');
    await fs.writeFile(
      fake,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli fixture'); process.exit(0); }
if (args.includes('status')) { console.error('Logged in using ChatGPT'); process.exit(0); }
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync('calls.txt', 'exec\\n');
  let result = JSON.parse(prompt.split('\\n').at(-1)).source_srt.replace('Merhaba.', 'Hello.');
  if (args[args.indexOf('--model') + 1] === 'bad') result = result.replace('00:00:01,000', '00:00:01,001');
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], result);
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));
});
`,
      { mode: 0o700 },
    );
    const data = path.join(root, 'state');
    for (const dir of [
      'data',
      'output/subtitles',
      'review-sessions/fixture',
      'temp/bad',
      'temp/good',
    ])
      await fs.mkdir(path.join(data, dir), { recursive: true });
    for (const id of ['bad', 'good'])
      await fs.writeFile(path.join(data, 'temp', id, 'input.srt'), source);
    await fs.writeFile(path.join(data, 'output/subtitles/source.srt'), source);
    await fs.writeFile(path.join(data, 'review-sessions/fixture/movie.webm'), '0123456789');
    await fs.writeFile(path.join(data, 'review-sessions/fixture/session.json'), '{}');
    const outside = path.join(root, 'private.json');
    await fs.writeFile(outside, '{"private":true}');
    await fs.symlink(outside, path.join(data, 'review-sessions/fixture/escape.json'));
    const queueFile = path.join(data, 'data/processing-queue.json');
    const initial: QueueState = {
      version: 1,
      processed: {},
      control: {
        paused: true,
        reason: 'Fixture pause',
        scannerEnabled: false,
        updatedAt: new Date().toISOString(),
      },
      jobs: ['bad', 'good'].map((id) => ({
        id,
        title: id,
        type: 'translation',
        status: 'queued',
        progress: 0,
        logs: [],
        createdAt: new Date().toISOString(),
        input: path.join(data, 'temp', id, 'input.srt'),
        settings: {
          ...config,
          CODEX_MODEL: id,
          TRANSLATION_PROVIDER: 'codex-local',
          KEEP_INTERMEDIATES: false,
        },
      })),
    };
    await fs.writeFile(queueFile, JSON.stringify(initial));
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    let server: ReturnType<typeof spawn> | undefined;
    let exited: Promise<unknown> | undefined;
    let errors = '',
      cookie = '';
    const request = (route: string, body?: unknown, extra: Record<string, string> = {}) =>
      fetch(origin + route, {
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
    async function until(check: () => Promise<boolean>, message: string) {
      for (let i = 0; i < 60; i++) {
        if (await check()) return;
        await delay(50);
      }
      assert.fail(`${message}: ${errors}`);
    }
    async function start() {
      errors = '';
      cookie = '';
      server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: {
          ...childEnvironment(),
          DATA_DIR: data,
          HOST: '127.0.0.1',
          PORT: String(port),
          PUBLIC_ORIGIN: origin,
          BASE_PATH: '',
          APP_PASSWORD: 'fixture-password-123',
          CODEX_BIN: fake,
          MAX_QUEUED_JOBS: '3',
          TRANSCRIBE_BACKEND: 'elevenlabs',
          TRANSCRIPTION_MODEL: '',
          ELEVENLABS_API_KEY: '',
          TRANSLATION_ENABLED: 'false',
          PAUSE_ON_FAILURE: 'true',
          SCANNER_ENABLED: 'false',
          KEEP_INTERMEDIATES: 'false',
        },
      });
      server.stderr!.on('data', (chunk) => {
        errors = (errors + chunk).slice(-4000);
      });
      exited = once(server, 'exit');
      await until(
        () =>
          request('/health').then(
            (r) => r.ok,
            () => false,
          ),
        'Server failed to start',
      );
      assert.equal((await request('/review-sessions/fixture/movie.webm')).status, 401);
      const login = await request('/api/auth/login', { password: 'fixture-password-123' });
      assert.equal(login.status, 200);
      cookie = login.headers.get('set-cookie')!.split(';')[0];
    }
    async function stop() {
      if (!server || server.exitCode !== null) return;
      server.kill('SIGTERM');
      const timer = setTimeout(() => server?.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
        server = undefined;
      }
    }
    try {
      await start();
      const status = await (await request('/api/status')).json();
      assert.equal(status.queue.paused, true);
      assert.equal(status.scanner.active, false);
      assert.ok(status.storage.availableBytes > 0);
      assert.equal((await request('/api/queue/control', { scannerEnabled: true })).status, 400);
      const media = await request('/review-sessions/fixture/movie.webm', undefined, {
        Range: 'bytes=2-5',
      });
      assert.equal(media.status, 206);
      assert.equal(await media.text(), '2345');
      assert.equal((await request('/review-sessions/fixture/escape.json')).status, 400);
      const submission = {
        youtubeUrl: 'https://youtu.be/abcdefghijk',
        title: 'Fixture',
        pauseBeforeTranscription: true,
      };
      const added = await request('/api/jobs', submission);
      assert.equal(added.status, 201);
      const { jobId } = await added.json();
      const repeated = await (
        await request('/api/jobs', {
          ...submission,
          youtubeUrl: 'https://www.youtube.com/watch?v=abcdefghijk&t=50',
        })
      ).json();
      assert.equal(repeated.jobId, jobId);
      assert.equal(
        (await request('/api/jobs', { ...submission, youtubeUrl: 'https://youtu.be/lmnopqrstuv' }))
          .status,
        429,
      );
      const page = await (await request('/api/jobs?view=summary&limit=1')).json();
      assert.equal(page.total, 3);
      assert.equal(page.jobs.length, 1);
      assert.equal(page.jobs[0].settings.CODEX_BIN, undefined);
      assert.equal((await request('/api/jobs?limit=1000000')).status, 400);
      await assert.rejects(fs.access(path.join(data, 'temp/bad/calls.txt')));
      // Never let the YouTube fixture reach a downloader or external service.
      await request(`/api/jobs/${jobId}/cancel`, {});
      assert.equal((await request('/api/queue/control', { paused: false })).status, 200);
      await until(
        async () => (await (await request('/api/jobs/bad')).json()).status === 'failed',
        'Expected the invalid translation to fail',
      );
      assert.equal((await (await request('/api/status')).json()).queue.paused, true);
      assert.equal((await (await request('/api/jobs/good')).json()).status, 'queued');
      await assert.rejects(fs.access(path.join(data, 'temp/good/calls.txt')));
      await request('/api/queue/control', { paused: false });
      await until(
        async () => (await (await request('/api/jobs/good')).json()).intermediatesRemoved === true,
        'Successful job did not clean up',
      );
      const good = await (await request('/api/jobs/good')).json();
      assert.equal(good.status, 'completed');
      assert.match(await (await request(good.result.englishSubtitleFile)).text(), /Hello\./);
      assert.equal(
        JSON.parse(
          await fs.readFile(
            path.join(data, 'data/translation-receipts/good/codex-receipt.json'),
            'utf8',
          ),
        ).completed,
        true,
      );
      await assert.rejects(fs.access(path.join(data, 'temp/good')));
      // Simulate abrupt loss of a worker between its durable claim and completion.
      await stop();
      const saved = JSON.parse(await fs.readFile(queueFile, 'utf8'));
      saved.jobs.find((job: any) => job.id === 'bad').status = 'processing';
      saved.control.paused = false;
      await fs.writeFile(queueFile, JSON.stringify(saved));
      await start();
      assert.equal((await (await request('/api/jobs/bad')).json()).status, 'interrupted');
      assert.equal((await (await request('/api/status')).json()).queue.paused, true);
      assert.equal(await fs.readFile(path.join(data, 'temp/bad/calls.txt'), 'utf8'), 'exec\n');
    } finally {
      await stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
