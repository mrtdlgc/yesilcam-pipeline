import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-hybrid-browser-'));
process.env.DATA_DIR = root;
const { run, childEnvironment } = await import(`${repo}/build/scripts/lib/process.js`);
const source =
  '1\n00:00:00,500 --> 00:00:01,500\n<i>Hello.</i>\n\n2\n00:00:04,250 --> 00:00:05,500\nCome home.\n';
const fake = path.join(root, 'codex-fixture.cjs');
await fs.writeFile(
  fake,
  `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(args.includes('--version')){console.log('codex-cli fixture');process.exit(0);}if(args.includes('status')){console.log('Logged in using ChatGPT');process.exit(0);}let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const payload=JSON.parse(input.trim().split('\\n').at(-1));fs.writeFileSync(args[args.indexOf('--output-last-message')+1],payload.source_srt.replaceAll('Hello.','Merhaba.').replaceAll('Come home.','Eve gel.'));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:20}}));});\n`,
  { mode: 0o700 },
);
await fs.mkdir(path.join(root, 'data'), { recursive: true });
await fs.writeFile(
  path.join(root, 'data/processing-queue.json'),
  JSON.stringify({
    version: 1,
    jobs: [],
    processed: {},
    control: { paused: false, scannerEnabled: false },
  }),
);
await fs.writeFile(path.join(root, 'english.srt'), source);
const movie = path.join(root, 'hybrid.mkv'),
  bare = path.join(root, 'without-subtitles.mp4'),
  unsupported = path.join(root, 'unsupported.mkv');
await run('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=160x90:r=24:d=8',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=500:duration=8',
  '-i',
  path.join(root, 'english.srt'),
  '-map',
  '0:v',
  '-map',
  '1:a',
  '-map',
  '2:s',
  '-c:v',
  'libx264',
  '-threads',
  '1',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  '-c:s',
  'srt',
  '-metadata:s:s:0',
  'language=eng',
  movie,
]);
await run('ffmpeg', [
  '-v',
  'error',
  '-i',
  movie,
  '-map',
  '0:v',
  '-map',
  '0:a',
  '-c',
  'copy',
  '-movflags',
  '+faststart',
  bare,
]);
await run('ffmpeg', [
  '-v',
  'error',
  '-i',
  movie,
  '-map',
  '0:v',
  '-map',
  '0:a',
  '-c:v',
  'ffv1',
  '-threads',
  '1',
  '-c:a',
  'pcm_s16le',
  unsupported,
]);
const delayed = path.join(root, 'delayed.mkv');
await run('ffmpeg', [
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=c=black:s=64x64:r=1:d=132',
  '-itsoffset',
  '1',
  '-f',
  'lavfi',
  '-i',
  "aevalsrc='if(between(t,0.2,0.6)+between(t,119.2,119.6),0.6*sin(2*PI*440*t),0)':s=8000:d=128",
  '-c:v',
  'ffv1',
  '-threads',
  '1',
  '-c:a',
  'pcm_s16le',
  delayed,
]);
const socket = net.createServer().listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['build/server.js'], {
  cwd: repo,
  env: {
    ...childEnvironment(),
    DATA_DIR: root,
    CODEX_BIN: fake,
    APP_PASSWORD: 'hybrid-fixture-password',
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_ORIGIN: origin,
    TRANSCRIBE_BACKEND: 'elevenlabs',
    TRANSCRIPTION_MODEL: 'scribe_v2',
    TRANSLATION_ENABLED: 'true',
    LOCAL_AUDIO_ENABLED: 'false',
    SHUTDOWN_GRACE_MS: '1000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '',
  exited = false;
server.stdout.on('data', (x) => (logs += x));
server.stderr.on('data', (x) => (logs += x));
const exit = once(server, 'exit').then((x) => {
  exited = true;
  return x;
});
let browser;
const errors = [],
  transfers = [];
try {
  for (let i = 0; i < 70; i++) {
    if (exited) throw Error(logs);
    if (
      await fetch(`${origin}/health`)
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((r) => setTimeout(r, 100));
  }
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/brave-browser',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)));
  page.on('pageerror', (e) => errors.push(e.message));
  context.on('request', (req) => {
    if (req.method() === 'POST' && /upload-audio|local-subtitles/.test(req.url()))
      transfers.push({ url: new URL(req.url()).pathname, bytes: req.postDataBuffer()?.length });
  });
  await page.goto(origin);
  await page.locator('#password').fill('hybrid-fixture-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL(`${origin}/`);
  await page.waitForFunction(
    () =>
      document.querySelector('#transcriptionProvider').value === 'elevenlabs' &&
      !document.querySelector('#providerDetails').textContent.includes('Loading'),
  );
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('CONSOLE', msg.text());
  });
  await page.locator('#sourceLanguage').fill('en');
  await page.locator('#targetLanguage').fill('tr');
  await page.locator('#uploadTitle').fill('Browser hybrid fixture');
  await page.locator('#audioFileInput').setInputFiles(movie);
  await page.waitForFunction(
    () =>
      document.querySelector('#notice').textContent.includes('Subtitle track sent') ||
      !document.querySelector('#cancelLocalPreparation').hidden === false,
    {},
    { timeout: 30000 },
  );
  assert.match(await page.locator('#notice').textContent(), /Subtitle track sent/);
  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].url, '/api/local-subtitles');
  assert.ok(transfers[0].bytes < 10000);
  let jobs;
  for (let i = 0; i < 80; i++) {
    jobs = await (await page.request.get(`${origin}/api/jobs`)).json();
    if (jobs[0]?.status === 'completed' && jobs[0]?.result?.reviewStatus === 'ready') break;
    if (jobs[0]?.status === 'failed') throw Error(jobs[0].error);
    await page.waitForTimeout(100);
  }
  assert.equal(jobs[0].status, 'completed');
  assert.equal(jobs[0].result.reviewStatus, 'ready');
  const editor = await context.newPage();
  editor.setDefaultTimeout(15000);
  await editor.goto(`${origin}/review-player.html?job=${jobs[0].id}`);
  await editor.waitForFunction(() => document.querySelector('#film').src.startsWith('blob:'));
  await editor
    .locator('#waveformStatus')
    .filter({ hasText: 'Audio energy' })
    .waitFor({ timeout: 60000 });
  assert.equal(await editor.evaluate(() => document.querySelector('#film').duration > 7), true);
  await editor.evaluate(() => {
    document.querySelector('#film').muted = true;
  });
  await editor.locator('#playPause').click();
  await editor.waitForFunction(
    () => document.querySelector('#film').currentTime > 1 && !document.querySelector('#film').error,
  );
  await editor.locator('#playPause').click();
  assert.equal(
    await editor.evaluate(() => document.querySelector('#prepareLocalScreening').hidden),
    true,
  );
  await editor.locator('#targetText').fill('Saved in the VPS');
  await editor.locator('#targetText').dispatchEvent('input');
  await editor.waitForFunction(async (id) => {
    const response = await fetch(`api/reviews/${id}`);
    const review = await response.json();
    return review.cues.some((cue) => cue.texts.tr === 'Saved in the VPS');
  }, jobs[0].id);
  await editor.reload();
  await editor.waitForFunction(() => document.querySelector('#film').src.startsWith('blob:'));
  await editor.locator('#localMedia').setInputFiles(bare);
  await editor
    .locator('#localPreparationStatus')
    .filter({ hasText: 'different movie' })
    .waitFor({ timeout: 30000 });
  assert.ok(
    await editor.evaluate(() => document.querySelector('#targetText').value === 'Saved in the VPS'),
  );
  console.log(
    'PASS: embedded extraction, server translation, automatic local playback, local waveform and wrong-file protection',
  );
  await editor.locator('#workspace').screenshot({ path: '/tmp/yesilcam-hybrid-editor-brave.png' });
  await page.locator('#pauseBeforeTranscription').check();
  await page.locator('#uploadTitle').fill('Browser audio fixture');
  await page.locator('#audioFileInput').setInputFiles(bare);
  await page.locator('#notice').filter({ hasText: 'Audio sent' }).waitFor({ timeout: 60000 });
  jobs = await (await page.request.get(`${origin}/api/jobs`)).json();
  const audioJob = jobs.find((j) => j.title === 'Browser audio fixture');
  assert.ok(audioJob);
  assert.equal(transfers.at(-1).url, '/api/upload-audio');
  transfers.at(-1).bytes = (
    await fs.stat(path.join(root, 'temp', audioJob.id, 'uploaded-audio'))
  ).size;
  assert.ok(transfers.at(-1).bytes > 0 && transfers.at(-1).bytes < 1000000);
  console.log('PASS: local extraction uploads audio only', JSON.stringify(transfers));
  await page.route('**/vendor/ffmpeg-core-0.12.10/ffmpeg-core.wasm', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue().catch(() => {});
  });
  const beforeCancel = transfers.length;
  await page.locator('#uploadTitle').fill('Cancelled local preparation');
  await page.locator('#audioFileInput').setInputFiles(unsupported);
  await page.locator('#cancelLocalPreparation').click();
  await page.locator('#notice').filter({ hasText: 'Local preparation cancelled' }).waitFor();
  assert.equal(transfers.length, beforeCancel);
  console.log('PASS: cancellation stops local work before media transfer');
  await page.unroute('**/vendor/ffmpeg-core-0.12.10/ffmpeg-core.wasm');
  // Incompatible source can be made browser-playable entirely locally.
  await page.locator('#audioFileInput').setInputFiles([]);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'fixtureFile';
    document.body.append(input);
  });
  await page.locator('#fixtureFile').setInputFiles(unsupported);
  const proxy = await page.evaluate(async () => {
    const { prepareLocalMedia, localScreening, matchLocalFile } = await import('./local-media.js');
    const file = document.querySelector('#fixtureFile').files[0];
    const controller = new AbortController();
    const prepared = await prepareLocalMedia(file, {
      sourceLanguage: 'en',
      targetLanguage: 'tr',
      audioStreamIndex: 0,
      maxDuration: 100,
      maxAudioBytes: 10000000,
      signal: controller.signal,
      progress: () => {},
    });
    const output = await localScreening(file, prepared.media, controller.signal, () => {});
    const matched = await matchLocalFile(output, prepared.media, controller.signal);
    const video = document.createElement('video');
    video.src = URL.createObjectURL(output);
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(Error('Proxy is not playable'));
    });
    video.muted = true;
    await video.play();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Local screening playback stalled')), 5000);
      video.ontimeupdate = () => {
        if (video.currentTime > 0.15) {
          clearTimeout(timer);
          resolve();
        }
      };
    });
    video.pause();
    return {
      size: output.size,
      duration: video.duration,
      audioStreamIndex: matched.audioStreamIndex,
    };
  });
  assert.ok(proxy.duration > 7);
  assert.equal(proxy.audioStreamIndex, 0);
  console.log(
    'PASS: incompatible codec local screening and saved-copy recognition',
    JSON.stringify(proxy),
  );
  await page.locator('#fixtureFile').setInputFiles(delayed);
  const peaks = await page.evaluate(async () => {
    const { localWaveform } = await import('./local-media.js');
    const file = document.querySelector('#fixtureFile').files[0];
    const data = await localWaveform(
      file,
      {
        version: 1,
        name: file.name,
        size: file.size,
        fingerprint: 'a'.repeat(64),
        duration: 132.2,
        frameRate: 1,
        audioStreamIndex: 0,
      },
      new AbortController().signal,
      () => {},
    );
    const bytes = Uint8Array.from(atob(data.peaks), (char) => char.charCodeAt(0));
    if (bytes.length !== 13220) throw Error('Waveform does not cover the review timeline');
    return [bytes[50], bytes[130], bytes[11950], bytes[12030], bytes[13150]];
  });
  assert.ok(
    peaks[0] === 0 && peaks[1] >= 150 && peaks[2] === 0 && peaks[3] >= 150 && peaks[4] === 0,
    JSON.stringify(peaks),
  );
  console.log(
    'PASS: local waveform preserves delayed audio and chunk boundaries',
    JSON.stringify(peaks),
  );
  const large = process.env.HYBRID_LARGE_FILE;
  if (large && (await fs.stat(large).catch(() => null))) {
    await page.locator('#fixtureFile').setInputFiles(large);
    const info = await page.evaluate(async () => {
      const { FFmpeg, FFFSType } = await import('./vendor/ffmpeg-0.12.15/index.js');
      const ff = new FFmpeg();
      try {
        await ff.load({
          coreURL: new URL('./vendor/ffmpeg-core-0.12.10/ffmpeg-core.js', location.href).href,
          wasmURL: new URL('./vendor/ffmpeg-core-0.12.10/ffmpeg-core.wasm', location.href).href,
        });
        await ff.createDir('/movie');
        const file = document.querySelector('#fixtureFile').files[0];
        await ff.mount(FFFSType.WORKERFS, { blobs: [{ name: 'input', data: file }] }, '/movie');
        const code = await ff.ffprobe(
          [
            '-v',
            'error',
            '-show_entries',
            'format=duration',
            '-of',
            'json',
            '/movie/input',
            '-o',
            '/result.json',
          ],
          20000,
        );
        const tailCode = await ff.exec(
          [
            '-v',
            'error',
            '-sseof',
            '-5',
            '-i',
            '/movie/input',
            '-map',
            '0:a:0',
            '-t',
            '0.05',
            '-f',
            'null',
            '-',
          ],
          20000,
        );
        return {
          size: file.size,
          code,
          tailCode,
          info: JSON.parse(await ff.readFile('/result.json', 'utf8')),
        };
      } finally {
        ff.terminate();
      }
    });
    assert.ok([0, -1].includes(info.code));
    assert.equal(info.tailCode, 0);
    assert.ok(info.size > 2 * 1024 ** 3);
    assert.ok(Number(info.info.format.duration) > 5);
    console.log(
      'PASS: large local movie mounted, probed and decoded near its end without upload',
      JSON.stringify(info),
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#studio-title').scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log('PASS: Brave desktop/mobile, no script errors');
} catch (error) {
  for (const context of browser?.contexts() ?? [])
    for (const page of context.pages()) {
      console.error(
        'STATE',
        await page
          .locator('#notice')
          .textContent({ timeout: 500 })
          .catch(() => ''),
        await page
          .locator('#uploadProgressText')
          .textContent({ timeout: 500 })
          .catch(() => ''),
        errors,
      );
      await page.screenshot({ path: '/tmp/yesilcam-hybrid-failure.png' }).catch(() => {});
    }
  console.error('Browser fixture failed:', error);
  console.error(logs.slice(-2000));
  throw error;
} finally {
  await browser?.close();
  if (!exited) {
    server.kill('SIGTERM');
    const timer = setTimeout(() => server.kill('SIGKILL'), 4000);
    await exit;
    clearTimeout(timer);
  }
  await fs.rm(root, { recursive: true, force: true });
}
