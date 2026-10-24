import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, test } from 'node:test';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-codex-test-'));
process.env.DATA_DIR = root;
const {
  codexArgs,
  codexPrompt,
  codexStatus,
  subtitleDocument,
  translateWithCodex,
  validateCodexTranslation,
} = await import('../lib/codex-translation.js');
const { childEnvironment } = await import('../lib/process.js');
const { subtitleHash } = await import('../lib/speakers.js');
after(() => fs.rm(root, { recursive: true, force: true }));
const source =
  '\uFEFF001\r\n00:00:01,000  -->  00:00:02,500\r\n<i>Merhaba!</i>\r\n\r\n7\r\n00:00:02.000 --> 00:00:04.000\r\nNasılsın?\r\n';
const translated = source.replace('Merhaba!', 'Hello!').replace('Nasılsın?', 'How are you?');
const fake = path.join(root, 'codex');
await fs.writeFile(
  fake,
  `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex-cli test'); process.exit(0); }
if (args.includes('status')) { console.error(process.argv[1].endsWith('api-login') ? 'Logged in using an API key' : 'Logged in using ChatGPT'); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const mode = args[args.indexOf('--model') + 1];
  fs.appendFileSync('calls.txt', 'exec\\n');
  fs.writeFileSync('received-prompt.txt', input);
  fs.writeFileSync('received-args.json', JSON.stringify(args));
  if (mode === 'slow') { setInterval(() => {}, 1000); return; }
  const source = JSON.parse(input.split('\\n').at(-1)).source_srt;
  let result = source.replaceAll('Merhaba!', 'Hello!').replaceAll('Nasılsın?', 'How are you?');
  if (mode === 'retimed') result = result.replace('00:00:01,000', '00:00:01,001');
  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], result);
  if (mode === 'quota') console.log(JSON.stringify({ type:'turn.failed', error:{message:'429 usage limit exceeded'} }));
  else if (mode !== 'incomplete') console.log(JSON.stringify({ type:'turn.completed', usage:{input_tokens:30, output_tokens:40} }));
  if (mode === 'nonzero' || mode === 'quota') process.exitCode = 1;
});
`,
  { mode: 0o700 },
);

async function fixture(mode = 'ok') {
  const workDir = await fs.mkdtemp(path.join(root, 'job-'));
  const input = path.join(workDir, 'input.srt'),
    output = path.join(workDir, 'published.srt');
  await fs.writeFile(input, source);
  return {
    input,
    output,
    workDir,
    options: {
      workDir,
      settings: { CODEX_BIN: fake, CODEX_MODEL: mode, CODEX_TRANSLATION_TIMEOUT_MS: 3000 },
    },
  };
}
const context = { title: 'Test film', sourceLanguage: 'tr', targetLanguage: 'en' };

test('API-key CLI login is rejected before any translation request', async () => {
  const apiLogin = path.join(root, 'api-login');
  await fs.copyFile(fake, apiLogin);
  await fs.chmod(apiLogin, 0o700);
  const f = await fixture();
  f.options.settings.CODEX_BIN = apiLogin;
  assert.equal((await codexStatus(f.options)).available, false);
  await assert.rejects(
    () => translateWithCodex(f.input, f.output, context, null, f.options),
    /API-key login/,
  );
  await assert.rejects(fs.access(path.join(f.workDir, 'calls.txt')));
  await assert.rejects(fs.access(f.output));
});

test('preserves nonsequential IDs, leading zeros, exact timing lines, overlaps, BOM and CRLF', () => {
  const result = validateCodexTranslation(source, translated);
  assert.equal(result.srt, translated);
  assert.deepEqual(
    result.warnings.map((w) => w.code),
    ['overlap'],
  );
  assert.equal(result.cues.length, 2);
});
test('rejects dropped, duplicated, reordered, retimed, empty and malformed cues', () => {
  for (const candidate of [
    translated.split('\r\n\r\n')[0],
    translated.replace('\r\n7\r\n', '\r\n001\r\n'),
    translated.replace(/^\uFEFF001/, '2'),
    translated.replace('00:00:01,000', '00:00:01,001'),
    translated.replace('How are you?', ''),
    translated.replace('</i>', ''),
    '```srt\n' + translated + '\n```',
  ])
    assert.throws(() => validateCodexTranslation(source, candidate));
  assert.throws(() => subtitleDocument(''));
  assert.throws(() => subtitleDocument(source + '\uFFFD'));
});
test('readability is reported without retiming or silently truncating dialogue', () => {
  const result = validateCodexTranslation(
    source,
    translated.replace('How are you?', 'A'.repeat(45)),
  );
  assert.equal(result.warnings[0].id, '7');
  assert.match(result.srt, /A{45}/);
});
test('whole-film prompt retains all 1,042 cues as one task', () => {
  const full = Array.from(
    { length: 1042 },
    (_, i) => `${i + 1}\n00:00:01,000 --> 00:00:02,000\nMerhaba!`,
  ).join('\n\n');
  const prompt = codexPrompt(full, context);
  assert.match(prompt, /Return all 1042 cues/);
  assert.equal(JSON.parse(prompt.split('\n').at(-1)!).source_srt, full);
});
test('CLI invocation keeps subscription auth, disables tools, and strips API environment secrets', () => {
  const args = codexArgs(root, path.join(root, 'out.srt'), 'my-model');
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('shell_tool'));
  assert.ok(args.includes('multi_agent'));
  assert.equal(args.at(-1), '-');
  assert.equal(
    childEnvironment({ CODEX_API_KEY: 'never-pass', OPENAI_API_KEY: 'never-pass' }).CODEX_API_KEY,
    undefined,
  );
  assert.equal(childEnvironment({ OPENAI_API_KEY: 'never-pass' }).OPENAI_API_KEY, undefined);
});
test('completed output publishes once and retry reuses validated receipt without inference', async () => {
  const f = await fixture();
  assert.equal((await codexStatus(f.options)).available, true);
  const result = await translateWithCodex(f.input, f.output, context, null, f.options);
  assert.equal(await fs.readFile(f.output, 'utf8'), translated);
  assert.equal(await fs.readFile(f.input, 'utf8'), source);
  assert.equal(result.report.cues, 2);
  await translateWithCodex(f.input, f.output, context, null, f.options);
  assert.equal(await fs.readFile(path.join(f.workDir, 'calls.txt'), 'utf8'), 'exec\n');
  await assert.rejects(
    () =>
      translateWithCodex(f.input, f.output, { ...context, targetLanguage: 'de' }, null, f.options),
    /changed/,
  );
  await fs.writeFile(path.join(f.workDir, 'codex-result.srt'), translated + 'changed');
  await assert.rejects(
    () => translateWithCodex(f.input, f.output, context, null, f.options),
    /changed/,
  );
});
test('a persisted completion event recovers output after a stop without another Codex call', async () => {
  const f = await fixture();
  await translateWithCodex(f.input, f.output, context, null, f.options);
  const receiptFile = path.join(f.workDir, 'codex-receipt.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  await fs.writeFile(
    receiptFile,
    JSON.stringify({ ...receipt, completed: false, status: 'running', turnCompleted: true }),
  );
  await fs.rm(f.output);
  await translateWithCodex(f.input, f.output, context, null, f.options);
  assert.equal(await fs.readFile(f.output, 'utf8'), translated);
  assert.equal(await fs.readFile(path.join(f.workDir, 'calls.txt'), 'utf8'), 'exec\n');
});
test('an unknown interrupted Codex attempt requires an explicit retry', async () => {
  const f = await fixture();
  await translateWithCodex(f.input, f.output, context, null, f.options);
  const receiptFile = path.join(f.workDir, 'codex-receipt.json');
  const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'));
  await fs.writeFile(
    receiptFile,
    JSON.stringify({ ...receipt, completed: false, status: 'running' }),
  );
  await assert.rejects(
    translateWithCodex(f.input, f.output, context, null, f.options),
    /interrupted/,
  );
  assert.equal(await fs.readFile(path.join(f.workDir, 'calls.txt'), 'utf8'), 'exec\n');
  await translateWithCodex(f.input, f.output, context, null, { ...f.options, retryCodex: true });
  assert.equal(await fs.readFile(path.join(f.workDir, 'calls.txt'), 'utf8'), 'exec\nexec\n');
});
test('legacy receipts migrate out of temporary media and survive cleanup', async () => {
  const f = await fixture();
  await translateWithCodex(f.input, f.output, context, null, f.options);
  const receiptDir = await fs.mkdtemp(path.join(root, 'persistent-receipt-'));
  await translateWithCodex(f.input, f.output, context, null, { ...f.options, receiptDir });
  const sourceCopy = path.join(root, 'source-copy.srt');
  await fs.copyFile(f.input, sourceCopy);
  await fs.rm(f.workDir, { recursive: true });
  const newWork = await fs.mkdtemp(path.join(root, 'retry-work-'));
  const output = path.join(newWork, 'output.srt');
  await translateWithCodex(sourceCopy, output, context, null, {
    workDir: newWork,
    receiptDir,
    settings: { ...f.options.settings, CODEX_BIN: '/missing/codex' },
  });
  assert.equal(await fs.readFile(output, 'utf8'), translated);
  await assert.rejects(fs.access(path.join(newWork, 'calls.txt')));
});
for (const mode of ['incomplete', 'retimed', 'quota', 'nonzero']) {
  test(`${mode} response never publishes output or retries automatically`, async () => {
    const f = await fixture(mode);
    await assert.rejects(
      () => translateWithCodex(f.input, f.output, context, null, f.options),
      mode === 'quota' ? /allowance/ : /./,
    );
    await assert.rejects(fs.access(f.output));
    assert.equal(await fs.readFile(path.join(f.workDir, 'calls.txt'), 'utf8'), 'exec\n');
  });
}
test('cancellation kills the CLI and leaves source intact without output', async () => {
  const f = await fixture('slow'),
    controller = new AbortController();
  const job = translateWithCodex(f.input, f.output, context, null, {
    ...f.options,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 250);
  try {
    await assert.rejects(job, { name: 'AbortError' });
  } finally {
    clearTimeout(timer);
  }
  await assert.rejects(fs.access(f.output));
  assert.equal(await fs.readFile(f.input, 'utf8'), source);
});
test('deadline stops an unresponsive CLI without output', async () => {
  const f = await fixture('slow');
  f.options.settings.CODEX_TRANSLATION_TIMEOUT_MS = 150;
  await assert.rejects(
    () => translateWithCodex(f.input, f.output, context, null, f.options),
    /time limit/,
  );
  await assert.rejects(fs.access(f.output));
});

test(
  'authenticated HTTP queue translates a full upload, protects routes, and cancels a duplicate job',
  { timeout: 15000 },
  async () => {
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = (socket.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;
    const dataDir = path.join(root, 'http-state');
    await fs.mkdir(path.join(dataDir, 'data'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'output', 'subtitles'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'output', 'reviews'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'output', 'subtitles', 'speaker-source.srt'), source);
    const speakerData = {
      version: 1,
      sourceHash: subtitleHash(source),
      cues: [
        { cueId: '001', speaker: '0', scope: 'movie' },
        { cueId: '7', speaker: '1', scope: 'movie' },
      ],
    };
    await fs.writeFile(
      path.join(dataDir, 'output', 'reviews', 'speaker-origin-speakers.json'),
      JSON.stringify(speakerData),
    );
    await fs.writeFile(
      path.join(dataDir, 'data', 'processing-queue.json'),
      JSON.stringify({
        version: 1,
        processed: {},
        jobs: [
          {
            id: 'speaker-origin',
            title: 'Speaker fixture',
            type: 'audio',
            status: 'completed',
            logs: [],
            progress: 100,
            settings: { DEMUCS_ENABLED: false, TRANSCRIBE_BACKEND: 'elevenlabs' },
            result: {
              subtitleFile: '/output/subtitles/speaker-source.srt',
              speakerFile: '/output/reviews/speaker-origin-speakers.json',
            },
          },
        ],
      }),
    );
    const server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...childEnvironment(),
        DATA_DIR: dataDir,
        HOST: '127.0.0.1',
        PORT: String(port),
        PUBLIC_ORIGIN: origin,
        BASE_PATH: '',
        APP_PASSWORD: 'test-only-password-123',
        CODEX_BIN: fake,
      },
    });
    let errors = '';
    server.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-4000);
    });
    const closed = once(server, 'exit');
    const fetchLocal = (url: string, options: RequestInit = {}) =>
      fetch(origin + url, { ...options, signal: AbortSignal.timeout(2500) });
    try {
      let ready = false;
      for (let i = 0; i < 40; i++) {
        if (server.exitCode !== null) throw new Error(errors || 'Test server exited');
        ready = await fetchLocal('/health').then(
          (r) => r.ok,
          () => false,
        );
        if (ready) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(ready, errors);
      assert.equal((await fetchLocal('/api/codex')).status, 401);
      assert.equal((await fetchLocal('/api/subtitle-translations')).status, 401);
      const login = await fetchLocal('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Yesilcam-Request': '1', Origin: origin },
        body: JSON.stringify({ password: 'test-only-password-123' }),
      });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const headers = {
        Cookie: cookie,
        'Content-Type': 'application/json',
        'X-Yesilcam-Request': '1',
        Origin: origin,
      };
      const request = (url: string, body?: unknown) =>
        fetchLocal(url, {
          method: body ? 'POST' : 'GET',
          headers,
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      assert.equal((await (await request('/api/codex')).json()).available, true);
      assert.equal(
        (
          await fetchLocal('/api/subtitle-translations', {
            method: 'POST',
            headers: { Cookie: cookie },
            body: '{}',
          })
        ).status,
        403,
      );
      const base = { ...context, model: 'ok' };
      assert.equal(
        (
          await request('/api/subtitle-translations', {
            ...base,
            filename: '../private/password.json',
          })
        ).status,
        400,
      );
      assert.equal(
        (await request('/api/subtitle-translations', { ...base, content: 'invalid SRT' })).status,
        400,
      );
      const submitted = await request('/api/subtitle-translations', { ...base, content: source });
      assert.equal(submitted.status, 201);
      const { jobId } = await submitted.json();
      let job: any;
      for (let i = 0; i < 40; i++) {
        job = await (await request(`/api/jobs/${jobId}`)).json();
        if (['completed', 'failed'].includes(job.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(job.status, 'completed', job.error);
      assert.equal(
        await (await request(job.result.englishSubtitleFile)).text(),
        translated.replace(/^\uFEFF/, ''),
      );
      assert.equal(
        (await (await request(job.result.translationReviewFile)).json()).timestampsIdentical,
        true,
      );
      const assResponse = await request(job.result.translatedAssFile);
      assert.equal(assResponse.status, 200);
      assert.match(assResponse.headers.get('content-disposition') ?? '', /attachment/);
      assert.match(await assResponse.text(), /Style: Netflix,Arial/);
      assert.equal((await fetchLocal(job.result.translatedAssFile)).status, 401);
      const style = await (await request(job.result.translationStyleReviewFile)).json();
      assert.equal(style.profile.maxCharactersPerLine, 42);
      assert.equal(style.timingChanged, false);
      const chunks = await fs.readdir(path.join(dataDir, 'output', 'translation_chunks'));
      assert.equal(chunks.length, 0);
      const catalog = await (await request('/api/subtitle-translations')).json();
      assert.equal(catalog.files.length, 3);
      for (const changed of [false, true]) {
        if (changed)
          await fs.writeFile(
            path.join(dataDir, 'output', 'subtitles', 'speaker-source.srt'),
            source.replace('Nasılsın?', 'Nasılsın bugün?'),
          );
        const added = await request('/api/subtitle-translations', {
          ...base,
          filename: 'speaker-source.srt',
        });
        assert.equal(added.status, 201);
        const { jobId: annotatedId } = await added.json();
        let annotated;
        for (let i = 0; i < 40; i++) {
          annotated = await (await request(`/api/jobs/${annotatedId}`)).json();
          if (['completed', 'failed'].includes(annotated.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal(annotated.status, 'completed', annotated.error);
        const prompt = await fs.readFile(
          path.join(dataDir, 'temp', annotatedId, 'received-prompt.txt'),
          'utf8',
        );
        const promptData = JSON.parse(prompt.split('\n').at(-1)!);
        assert.deepEqual(promptData.speakers, changed ? undefined : speakerData);
      }
      const filename = decodeURIComponent(job.result.subtitleFile.split('/').at(-1));
      const second = await (
        await request('/api/subtitle-translations', { ...base, filename, model: 'slow' })
      ).json();
      const duplicate = await (
        await request('/api/subtitle-translations', { ...base, filename, model: 'slow' })
      ).json();
      assert.equal(second.jobId, duplicate.jobId);
      await request(`/api/jobs/${second.jobId}/cancel`, {});
      for (let i = 0; i < 30; i++) {
        job = await (await request(`/api/jobs/${second.jobId}`)).json();
        if (job.status === 'cancelled') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(job.status, 'cancelled');
    } finally {
      server.kill('SIGTERM');
      const kill = setTimeout(() => server.kill('SIGKILL'), 3000);
      await closed;
      clearTimeout(kill);
    }
  },
);
