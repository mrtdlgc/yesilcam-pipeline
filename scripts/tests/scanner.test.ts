import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { childEnvironment } from '../lib/process.js';

test(
  'one manual scan accepts stable files and defers files still changing with watching off',
  { timeout: 12000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-scanner-'));
    await fs.mkdir(path.join(root, 'movies'), { recursive: true });
    await fs.mkdir(path.join(root, 'data'), { recursive: true });
    const processed: Record<string, { filename: string; at: string; jobId: string }> = {};
    for (const name of ['stable.mp4', 'growing.mp4']) {
      const file = path.join(root, 'movies', name);
      await fs.writeFile(file, 'fixture');
      const stat = await fs.stat(file);
      processed[`${name}:${stat.size}:${stat.mtimeMs}`] = {
        filename: name,
        at: '',
        jobId: 'archived',
      };
    }
    await fs.writeFile(
      path.join(root, 'data', 'processing-queue.json'),
      JSON.stringify({
        version: 1,
        jobs: [],
        processed,
        control: { paused: false, scannerEnabled: false, reason: null, updatedAt: '' },
      }),
    );
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = (listener.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env: {
        ...childEnvironment(),
        DATA_DIR: root,
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        APP_PASSWORD: 'scanner-fixture-password',
        SCANNER_ENABLED: 'false',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = '';
    server.stderr.on('data', (chunk) => {
      errors += chunk;
    });
    const exited = once(server, 'exit');
    const request = (route: string, body?: unknown, cookie = '') =>
      fetch(origin + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Yesilcam-Request': '1' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(4000),
      });
    try {
      for (let i = 0; i < 60; i++) {
        if (
          await request('/health').then(
            (r) => r.ok,
            () => false,
          )
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const login = await request('/api/auth/login', { password: 'scanner-fixture-password' });
      assert.equal(login.status, 200, errors);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const scanning = request('/api/movies/scan', {}, cookie);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fs.appendFile(path.join(root, 'movies', 'growing.mp4'), '-still-copying');
      assert.equal((await scanning).status, 200);
      const status = await (await request('/api/status', undefined, cookie)).json();
      assert.equal(status.scanner.active, false);
      assert.deepEqual(status.skippedFiles, [
        { filename: 'growing.mp4', reason: 'Waiting for file to stop changing' },
        { filename: 'stable.mp4', reason: 'Completed output saved' },
      ]);
      assert.equal(status.queue.pendingJobs, 0);
    } finally {
      if (server.exitCode === null) server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
