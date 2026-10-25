import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';

test(
  'hosted accounts isolate credentials, background translations, files and corrections across restarts',
  { timeout: 40000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-hosted-'));
    const socket = net.createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const fixture = path.join(root, 'provider.mjs');
    const calls = path.join(root, 'provider-calls.jsonl');
    await fs.writeFile(
      fixture,
      `
    import fs from 'node:fs/promises';
    globalThis.fetch = async (url, init) => {
      if (String(url) !== 'https://api.openai.com/v1/responses') throw new Error('Unexpected outbound network request');
      const body = JSON.parse(init.body);
      if (body.store !== false || body.stream !== true) throw new Error('Unsafe response configuration');
      await fs.appendFile(${JSON.stringify(calls)}, JSON.stringify({ key: init.headers.Authorization, model: body.model })+'\\n');
      const prompt = body.input[0].content[0].text;
      const source = JSON.parse(prompt.trim().split('\\n').at(-1)).source_srt;
      const event = { type: 'response.completed', response: { status: 'completed', output: [{ type:'message', role:'assistant', content:[{ type:'output_text', text:source.replaceAll('Merhaba.', 'Hello.').replaceAll('Eve gel.', 'Come home.') }] }], usage:{input_tokens:10,output_tokens:10} } };
      return new Response('data: '+JSON.stringify(event)+'\\n\\n', {headers:{'Content-Type':'text/event-stream'}});
    };
  `,
    );
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (/API_KEY|TOKEN|SECRET|PASSWORD|MASTER_KEY|COOKIES|CODEX_HOME|CHATGPT_/i.test(key))
        delete env[key];
    let server: ReturnType<typeof spawn> | undefined,
      logs = '';
    const start = async () => {
      server = spawn(process.execPath, ['--import', 'tsx', '--import', fixture, 'server.ts'], {
        env: {
          ...env,
          APP_MODE: 'hosted',
          DATA_DIR: root,
          HOST: '127.0.0.1',
          PORT: String(port),
          PUBLIC_ORIGIN: origin,
          BASE_PATH: '',
          SHUTDOWN_GRACE_MS: '1000',
          SCANNER_ENABLED: 'false',
          LOCAL_AUDIO_ENABLED: 'false',
          CODEX_BIN: '/not-available/owner-codex',
          OPENAI_API_KEY: 'owner-key-must-never-be-used',
          ELEVENLABS_API_KEY: 'owner-asr-key-must-never-be-used',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      server.stderr!.on('data', (chunk) => (logs += chunk));
      server.stdout!.on('data', (chunk) => (logs += chunk));
      for (let attempt = 0; attempt < 100; attempt++) {
        if (server.exitCode !== null) assert.fail(logs);
        if (
          await fetch(origin + '/health')
            .then((r) => r.ok)
            .catch(() => false)
        )
          return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(logs);
    };
    const stop = async () => {
      if (!server || server.exitCode !== null) return;
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      const timer = setTimeout(() => server?.kill('SIGKILL'), 3000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    };
    const request = (cookie: string, route: string, method = 'GET', body?: unknown) =>
      fetch(origin + route, {
        method,
        headers: { Cookie: cookie, 'X-Yesilcam-Request': '1', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
      });
    const json = async (response: Response) => (await response.json()) as any;
    const signup = async (username: string) => {
      const response = await request('', '/api/auth/signup', 'POST', {
        username,
        email: `${username}@example.com`,
        password: 'strong-fixture-password',
      });
      assert.equal(response.status, 201, await response.clone().text());
      return {
        cookie: response.headers.get('set-cookie')!.split(';')[0],
        ...(await json(response)),
      };
    };
    try {
      await start();
      assert.equal((await request('', '/api/jobs')).status, 401);
      const alice = await signup('alice'),
        bob = await signup('bob');
      assert.match(alice.recoveryCode, /^[a-f0-9]{48}$/);
      const session = await json(await request(alice.cookie, '/api/auth/session'));
      assert.equal(session.user.username, 'alice');
      assert.equal(
        (
          await request('', '/api/auth/signup', 'POST', {
            username: 'ALICE',
            email: 'new@example.com',
            password: 'strong-fixture-password',
          })
        ).status,
        409,
      );
      let fields = (await json(await request(alice.cookie, '/api/connections'))).fields;
      assert.ok(
        fields.every((field: any) => !field.configured),
        'server environment keys are never inherited',
      );
      assert.equal(
        (await json(await request(alice.cookie, '/api/codex?provider=codex-local'))).available,
        false,
      );
      assert.equal(
        (await request(alice.cookie, '/api/oauth/chatgpt/start', 'POST', {})).status,
        503,
      );
      assert.equal(
        (
          await request(alice.cookie, '/api/connections/TRANSCRIPTION_API_URL', 'PUT', {
            value: 'http://127.0.0.1/private',
          })
        ).status,
        403,
      );
      assert.equal(
        (await request(alice.cookie, '/api/queue/control', 'POST', { paused: true })).status,
        403,
      );
      for (const [account, key, storage] of [
        [alice, 'alice-test-secret-key', 'saved'],
        [bob, 'bob-test-secret-key', 'session'],
      ] as const) {
        assert.equal(
          (
            await request(account.cookie, '/api/connections/OPENAI_API_KEY', 'PUT', {
              value: key,
              storage,
            })
          ).status,
          200,
        );
        const status = await request(account.cookie, '/api/connections');
        assert.ok(!(await status.text()).includes(key));
      }
      const source =
        '1\n00:00:00,500 --> 00:00:01,500\nMerhaba.\n\n2\n00:00:04,000 --> 00:00:05,500\nEve gel.\n';
      const body = {
        title: 'Private film',
        sourceLanguage: 'tr',
        targetLanguage: 'en',
        translateWithCodex: true,
        translationProvider: 'openai-api',
        translationMode: 'fixed',
        localMedia: {
          version: 1,
          name: 'movie.mkv',
          fingerprint: 'a'.repeat(64),
          size: 100000,
          duration: 8,
          frameRate: 24,
          audioStreamIndex: 0,
        },
        subtitle: { content: source, language: 'tr', source: 'local-embedded' },
      };
      const jobs = [];
      for (const account of [alice, bob]) {
        const response = await request(account.cookie, '/api/local-subtitles', 'POST', body);
        assert.equal(response.status, 201, await response.clone().text());
        jobs.push((await json(response)).jobId);
      }
      const waitJob = async (cookie: string, id: string) => {
        for (let attempt = 0; attempt < 150; attempt++) {
          const job = await json(await request(cookie, `/api/jobs/${id}`));
          assert.notEqual(job.status, 'failed', job.error);
          if (job.status === 'completed' && job.result?.reviewStatus === 'ready') return job;
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        assert.fail('Job did not finish: ' + logs);
      };
      const a = await waitJob(alice.cookie, jobs[0]),
        b = await waitJob(bob.cookie, jobs[1]);
      assert.notEqual(a.id, b.id);
      assert.equal((await json(await request(alice.cookie, '/api/jobs'))).length, 1);
      assert.equal((await json(await request(bob.cookie, '/api/jobs'))).length, 1);
      for (const route of [
        `/api/jobs/${a.id}`,
        `/api/jobs/%${a.id.charCodeAt(0).toString(16)}${a.id.slice(1)}`,
        `/api/jobs/${a.id}/requests`,
        `/api/reviews/${a.id}`,
        `/api/reviews/${a.id}/subtitles/en.srt`,
        `/review-sessions/${a.id}/waveform.json`,
        a.result.englishSubtitleFile,
      ]) {
        assert.equal((await request(bob.cookie, route)).status, 404, route);
      }
      assert.equal((await request(bob.cookie, `/api/jobs/${a.id}/cancel`, 'POST', {})).status, 404);
      const translated = await request(alice.cookie, a.result.englishSubtitleFile);
      assert.equal(translated.status, 200);
      assert.match(await translated.text(), /Hello/);
      const review = await json(await request(alice.cookie, `/api/reviews/${a.id}`));
      assert.equal(
        (
          await request(alice.cookie, `/api/reviews/${a.id}`, 'POST', {
            revision: review.revision,
            edits: [{ id: '1', texts: { en: 'My correction' } }],
          })
        ).status,
        200,
      );
      const used = (await fs.readFile(calls, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).key);
      assert.deepEqual(used.sort(), ['Bearer alice-test-secret-key', 'Bearer bob-test-secret-key']);
      for (const filename of await fs.readdir(path.join(root, 'data', 'private')))
        if (filename.startsWith('accounts.sqlite')) {
          const content = await fs.readFile(path.join(root, 'data', 'private', filename));
          for (const value of [
            'alice-test-secret-key',
            'bob-test-secret-key',
            'strong-fixture-password',
            alice.recoveryCode,
          ])
            assert.equal(content.includes(Buffer.from(value)), false);
        }
      await stop();
      await start();
      assert.equal(
        (await json(await request(alice.cookie, '/api/auth/session'))).authenticated,
        true,
      );
      fields = (await json(await request(alice.cookie, '/api/connections'))).fields;
      assert.equal(fields.find((f: any) => f.name === 'OPENAI_API_KEY').configured, true);
      fields = (await json(await request(bob.cookie, '/api/connections'))).fields;
      assert.equal(fields.find((f: any) => f.name === 'OPENAI_API_KEY').configured, false);
      assert.match(
        await (await request(alice.cookie, `/api/reviews/${a.id}/subtitles/en.srt`)).text(),
        /My correction/,
      );
      const recovered = await request('', '/api/auth/recover', 'POST', {
        email: 'alice@example.com',
        recoveryCode: alice.recoveryCode,
        newPassword: 'new-strong-fixture-password',
      });
      assert.equal(recovered.status, 200);
      assert.equal((await request(alice.cookie, '/api/jobs')).status, 401);
      assert.equal(
        (
          await request('', '/api/auth/recover', 'POST', {
            email: 'alice@example.com',
            recoveryCode: alice.recoveryCode,
            newPassword: 'new-strong-fixture-password',
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request('', '/api/auth/login', 'POST', {
            login: 'alice',
            password: 'new-strong-fixture-password',
          })
        ).status,
        200,
      );
      assert.equal((await request(bob.cookie, '/api/auth/logout', 'POST', {})).status, 200);
      assert.equal((await request(bob.cookie, '/api/jobs')).status, 401);
      assert.equal(
        (await fs.readFile(calls, 'utf8')).trim().split('\n').length,
        2,
        'review edits and restarts never trigger inference',
      );
    } finally {
      await stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
