import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

test(
  'SIGTERM drains a submitted paid response to disk and leaves the next film queued',
  { timeout: 20000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-shutdown-'));
    process.env.DATA_DIR = root;
    const { config } = await import('../../config.js');
    const { run, childEnvironment } = await import('../lib/process.js');
    const { at, writeJson, readJson } = await import('../lib/files.js');
    const { runPipeline } = await import('../pipeline.js');
    const file = at('temp', 'draining', 'source.wav');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await run('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=500:duration=1',
      '-c:a',
      'pcm_s16le',
      file,
    ]);
    let response: http.ServerResponse | undefined;
    let submitted!: () => void;
    const gotSubmission = new Promise<void>((resolve) => {
      submitted = resolve;
    });
    let posts = 0;
    const provider = http.createServer((req, res) => {
      posts++;
      req.resume();
      req.on('end', () => {
        response = res;
        submitted();
      });
    });
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const endpoint = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}/transcribe`;
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const settings = {
      ...config,
      TRANSCRIBE_BACKEND: 'compatible',
      TRANSCRIPTION_MODEL: 'fixture',
      TRANSCRIPTION_MODE: 'chunks',
      CLOUD_PRICE_PER_MINUTE: 0.01,
      CLOUD_MAX_ESTIMATED_COST: 1,
      TRANSLATION_ENABLED: false,
      PREPARE_REVIEW: false,
      ALIGN_TO_SPEECH: false,
      FILTER_HALLUCINATIONS: false,
      PAUSE_BEFORE_TRANSCRIPTION: false,
      PAUSE_AFTER_DEMUCS: false,
      KEEP_INTERMEDIATES: true,
      LOCAL_AUDIO_ENABLED: false,
    };
    const job = {
      id: 'draining',
      title: 'Fixture',
      type: 'audio',
      input: file,
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      logs: [],
      settings,
    };
    await writeJson(at('data', 'processing-queue.json'), {
      version: 1,
      jobs: [job, { ...job, id: 'waiting' }],
      processed: {},
      control: { paused: false, scannerEnabled: false, reason: null, updatedAt: '' },
    });
    const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...childEnvironment(),
        DATA_DIR: root,
        APP_PASSWORD: 'isolated-test-password',
        PORT: String(port),
        PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
        TRANSCRIPTION_API_URL: endpoint,
        LOCAL_AUDIO_ENABLED: 'false',
        SHUTDOWN_GRACE_MS: '5000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    server.stdout.on('data', (data) => {
      logs += data;
    });
    server.stderr.on('data', (data) => {
      logs += data;
    });
    let exited = false;
    const exit = once(server, 'exit').then((value) => {
      exited = true;
      return value;
    });
    try {
      await Promise.race([
        gotSubmission,
        exit.then(() => {
          throw new Error(logs);
        }),
      ]);
      server.kill('SIGTERM');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(exited, false, 'server must not abort an accepted upload immediately');
      response!.setHeader('Content-Type', 'application/json');
      response!.end(
        JSON.stringify({
          text: 'Merhaba.',
          language: 'tr',
          words: [{ word: 'Merhaba.', start: 0.1, end: 0.9 }],
        }),
      );
      const [code] = await exit;
      assert.equal(code, 0, logs);
      const state = await readJson(
        at('output', 'raw_transcriptions', 'draining', 'chunk_0.request.json'),
      );
      assert.equal(state.status, 'complete');
      assert.equal(state.result.text, 'Merhaba.');
      assert.equal(
        (await readJson(at('data', 'processing-queue.json'))).jobs.find(
          (item: { id: string }) => item.id === 'waiting',
        ).status,
        'queued',
      );
      process.env.TRANSCRIPTION_API_URL = endpoint;
      await runPipeline(job, {});
      assert.equal(posts, 1, 'retry must reuse the paid response without a second POST');
    } finally {
      delete process.env.TRANSCRIPTION_API_URL;
      if (!exited) {
        server.kill('SIGKILL');
        await exit;
      }
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
