import express from 'express';
import type { ErrorRequestHandler } from 'express';
import type { Job, QueueState, Settings } from './types/pipeline.js';
import {
  initializeCredentials,
  clearStaleCookieFiles,
  credential,
  credentialStatus,
  saveCredential,
  clearCredential,
} from './scripts/lib/credentials.js';
import { initializePassword, installAuth } from './scripts/lib/auth.js';
import { acquireInstanceLock } from './scripts/lib/instance-lock.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import {
  at,
  leaf,
  jobId,
  contained,
  readJson,
  writeJson,
  serialized,
  atomicWrite,
  titleSlug,
} from './scripts/lib/files.js';
import { withTempBudget, storageStatus, directoryBytes } from './scripts/lib/storage.js';
import {
  queueControl,
  pauseQueue,
  assertQueueCapacity,
  submissionKey,
  jobSummary,
} from './scripts/lib/queue.js';
import { QueueStore, progressWriter } from './scripts/lib/queue-store.js';
import { drainPaidWork } from './scripts/lib/paid-work.js';
import { inspectRequests, reconcileRequest } from './scripts/lib/request-recovery.js';
import { probe, terminateChildren } from './scripts/lib/process.js';
import { runPipeline, validateSettings } from './scripts/pipeline.js';
import { validateYouTubeUrl } from './scripts/1_download_video.js';
import {
  importTranslation,
  mergeTranslatedChunks,
  validTranslation,
} from './scripts/4_chunk_srt.js';
import { parseSrt } from './scripts/lib/srt.js';
import { publicCatalog, selection } from './scripts/providers/catalog.js';
import { applyStage, createStages, stopStages } from './scripts/lib/progress.js';
import { audioReview, audioReviewFile } from './scripts/lib/audio-review.js';
import {
  migratePreparedAudio,
  originalAudioSettings,
  configurePausedAudio,
} from './scripts/lib/source-audio.js';
import { fullMovie, movieSettings } from './scripts/lib/transcription-mode.js';
import { writeSubtitleArtifacts } from './scripts/lib/subtitle-export.js';
import { subtitleHash } from './scripts/lib/speakers.js';
import { prepareSubtitleReview } from './scripts/lib/review-preparation.js';
import {
  readSubtitleReview,
  reviewView,
  editSubtitleReview,
  reviewExport,
  saveReviewPosition,
  removeScreeningCopy,
} from './scripts/lib/subtitle-review.js';
import {
  codexStatus,
  subtitleDocument,
  MAX_SUBTITLE_BYTES,
  preserveCodexReceipt,
} from './scripts/lib/codex-translation.js';

validateSettings(config);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PATH = process.env.BASE_PATH || '';
if (!['127.0.0.1', '::1', 'localhost', '0.0.0.0', '::'].includes(HOST))
  throw new Error('Invalid HOST');
if (!process.env.PUBLIC_ORIGIN && ['0.0.0.0', '::'].includes(HOST))
  throw new Error('Set PUBLIC_ORIGIN to the public HTTPS origin');
const PUBLIC_ORIGIN = new URL(
  process.env.PUBLIC_ORIGIN || `http://${HOST === '::1' ? '[::1]' : HOST}:${PORT}`,
);
if (
  !['https:', 'http:'].includes(PUBLIC_ORIGIN.protocol) ||
  PUBLIC_ORIGIN.username ||
  PUBLIC_ORIGIN.password ||
  PUBLIC_ORIGIN.pathname !== '/' ||
  PUBLIC_ORIGIN.search ||
  PUBLIC_ORIGIN.hash
)
  throw new Error('PUBLIC_ORIGIN must be an origin such as https://subtitles.example.com');
if (
  PUBLIC_ORIGIN.protocol === 'http:' &&
  !['localhost', '127.0.0.1', '[::1]'].includes(PUBLIC_ORIGIN.hostname)
)
  throw new Error('Public deployments require HTTPS');
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('Invalid PORT');
if (
  (BASE_PATH && !/^\/[a-zA-Z0-9_/-]+$/.test(BASE_PATH)) ||
  BASE_PATH.endsWith('/') ||
  BASE_PATH.includes('//') ||
  BASE_PATH.includes('..')
)
  throw new Error('Invalid BASE_PATH');
for (const dir of [
  'data',
  'temp',
  'movies',
  'found',
  'output/subtitles',
  'output/translation_chunks',
  'output/reviews',
  'output/raw_transcriptions',
  'review-sessions',
]) {
  await fs.mkdir(at(dir), { recursive: true });
}

const releaseLock = await acquireInstanceLock();
await initializeCredentials();
await clearStaleCookieFiles();
await initializePassword();
const store = new QueueStore(at('data', 'processing-queue.json'), {
  version: 1,
  jobs: [],
  processed: {},
});
const now = () => new Date().toISOString();
const fail = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};
const terminal = new Set(['completed', 'failed', 'cancelled']);
let active: { id: string; controller: AbortController } | null = null;
let pumping = false,
  stopping = false,
  uploading = false,
  scanning = false;
let uploadAbort: AbortController | null = null;
let scanError: string | null = null;
let queueFault: string | null = null;
const reviewTasks = new Map<string, AbortController>();
let skippedFiles: { filename: string; reason: string }[] = [],
  lastScanFiles: string[] = [];
const observations = new Map();

await store.update(async (state) => {
  if (state.version !== 1 || !Array.isArray(state.jobs))
    throw new Error('Unsupported queue format; preserve it and migrate explicitly');
  state.processed ??= {};
  queueControl(state);
  for (const job of state.jobs) {
    if (job.result?.reviewStatus === 'preparing') {
      job.result.reviewStatus = 'failed';
      job.result.reviewError =
        'Screening preparation was interrupted. Prepare it again from the job card.';
      const stage = job.stages?.find((item) => item.id === 'review');
      if (stage) stage.status = 'interrupted';
    }
    if (job.status === 'processing') {
      pauseQueue(
        state,
        'The server stopped during a job. Check the interrupted job before resuming the queue.',
      );
      job.status = 'interrupted';
      stopStages(job.stages, 'interrupted');
      job.error = 'Server stopped during processing. Resume or retry this job.';
      job.logs = [...(job.logs ?? []), { time: now(), message: job.error }].slice(-200);
    }
    if (job.settings?.DEMUCS_ENABLED && job.status !== 'completed' && !job.intermediatesRemoved) {
      try {
        const manifest = await migratePreparedAudio(job.id);
        const noManifest =
          !manifest && !(await readJson(at('temp', job.id, 'manifest.json'), null));
        if (manifest || noManifest) {
          job.settings = manifest?.settings ?? originalAudioSettings(job.settings);
          job.stages = undefined;
          job.logs = [
            ...(job.logs ?? []),
            {
              time: now(),
              message:
                'Using original audio with Scribe v2. Previous separation artifacts are preserved.',
            },
          ].slice(-200);
        }
      } catch (error) {
        job.error = `Original audio migration needs attention: ${error.message}`;
        job.status = 'failed';
        job.logs = [...(job.logs ?? []), { time: now(), message: job.error }].slice(-200);
      }
    }
    // A review pause saved by an older version already has all of these
    // artifacts. Restore its bars without resuming the job or launching ASR.
    if (job.status === 'paused' && !job.stages && !job.intermediatesRemoved) {
      const manifest = await readJson(at('temp', jobId(job.id), 'manifest.json'), null);
      const count = manifest?.originalChunks?.length;
      if (manifest?.stage === 'paused' && count > 0 && manifest.chunks?.length > 0) {
        job.stages = createStages({
          type: job.type,
          settings: { ...config, ...manifest.settings },
        });
        for (const id of ['subtitles', 'download', 'chunking', 'demucs'] as const) {
          if (job.stages.find((stage) => stage.id === id)?.status === 'skipped') continue;
          applyStage(job.stages, {
            id,
            status: 'completed',
            detail: 'Restored from the saved audio review checkpoint',
            ...(['chunking', 'demucs'].includes(id)
              ? { completed: count, total: count, unit: 'chunks' }
              : {}),
          });
        }
      }
    }
  }
});
const knownJobs = new Set((await store.read()).jobs.map((job) => job.id));
for (const entry of await fs.readdir(at('temp'), { withFileTypes: true })) {
  if (
    !entry.isDirectory() ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.name) ||
    knownJobs.has(entry.name)
  )
    continue;
  const marker = await readJson(at('temp', entry.name, 'upload-staging.json'), null);
  if (marker?.jobId === entry.name)
    await fs.rm(await contained(at('temp'), entry.name), { recursive: true, force: true });
}

async function updateJob<T>(id: string, mutate: (job: Job, state: QueueState) => T | Promise<T>) {
  return store.update((state) => {
    const job = state.jobs.find((item) => item.id === id);
    if (!job) return fail(404, 'Job not found');
    return mutate(job, state);
  });
}
async function addJob(data: any) {
  const { transcriptionSettings, ...inputData } = data;
  const job: Job = {
    ...inputData,
    pathSchema: 1,
    id: data.id ?? jobId(),
    status: 'queued',
    progress: 0,
    logs: [],
    createdAt: now(),
    settings: {
      ...config,
      ...transcriptionSettings,
      DEFAULT_LANGUAGE: data.sourceLanguage ?? config.DEFAULT_LANGUAGE,
      TARGET_LANGUAGE: data.targetLanguage ?? config.TARGET_LANGUAGE,
      DEMUCS_ENABLED: false,
    },
  };
  validateSettings(job.settings);
  job.stages = createStages(job);
  const accepted = await store.update((state) => {
    const existing =
      job.submissionKey && state.jobs.find((item) => item.submissionKey === job.submissionKey);
    if (existing) return structuredClone(existing);
    assertQueueCapacity(state);
    state.jobs.push(job);
    return job;
  });
  wake();
  return accepted;
}
function wake() {
  if (!stopping && !queueFault)
    void pump().catch((error) => {
      queueFault = error.message;
      console.error('Queue stopped:', error.message);
    });
}
async function prepareJobReview(job: Job, result: any, signal?: AbortSignal) {
  const onStage = async (update: Parameters<typeof applyStage>[1]) =>
    updateJob(job.id, (item) => {
      item.stages ??= createStages(item);
      if (!item.stages.some((stage) => stage.id === 'review'))
        item.stages.push({
          id: 'review',
          label: 'Prepare screening',
          status: 'pending',
          percentage: null,
        });
      applyStage(item.stages, update);
    });
  await onStage({
    id: 'review',
    status: 'running',
    percentage: null,
    detail: 'Preparing film and subtitles for correction',
  });
  try {
    const sourceJob =
      job.type === 'translation'
        ? (await store.read()).jobs.find(
            (item) =>
              item.type !== 'translation' && item.result?.subtitleFile === result.subtitleFile,
          )
        : undefined;
    Object.assign(
      result,
      await serialized('screening-media-worker', () =>
        prepareSubtitleReview(
          job,
          result,
          {
            signal,
            onStage,
            settings: job.settings,
          },
          sourceJob,
        ),
      ),
    );
    await onStage({
      id: 'review',
      status: 'completed',
      detail: 'Screening ready. Subtitles can be used or corrected immediately.',
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    result.reviewStatus = 'failed';
    result.reviewError = error.message;
    await onStage({
      id: 'review',
      status: 'failed',
      detail: `Subtitles saved; screening needs attention: ${error.message}`,
    });
  }
}
async function cleanupSuccessfulJob(job: Job) {
  if (job.settings.KEEP_INTERMEDIATES ?? config.KEEP_INTERMEDIATES) return;
  try {
    await preserveCodexReceipt(at('temp', job.id), at('data', 'translation-receipts', job.id));
    await fs.rm(await contained(at('temp'), job.id), { recursive: true, force: true });
    await updateJob(job.id, (item) => {
      item.intermediatesRemoved = true;
    });
  } catch (error) {
    // Subtitle success must not become a failed/rebillable job because cleanup failed.
    await updateJob(job.id, (item) => {
      item.logs = [
        ...item.logs,
        { time: now(), message: `Subtitles saved; temporary cleanup failed: ${error.message}` },
      ].slice(-200);
    });
  }
}
async function pump() {
  if (pumping || stopping) return;
  pumping = true;
  try {
    while (!stopping) {
      const controller = new AbortController();
      const job = await store.update((state) => {
        if (queueControl(state).paused) return null;
        const item = state.jobs.find((j) => j.status === 'queued');
        if (!item) return null;
        item.status = 'processing';
        item.error = null;
        item.startedAt = now();
        item.stages ??= createStages(item);
        active = { id: item.id, controller };
        return structuredClone(item);
      });
      if (!job) break;
      const updates = progressWriter((mutate) => updateJob(job.id, mutate));
      try {
        const result = await runPipeline(job, {
          signal: controller.signal,
          resume: job.resume === true,
          onStage: async (update) =>
            updates.push(
              (item) => {
                item.stages ??= createStages(item);
                applyStage(item.stages, update);
              },
              update.status !== undefined && update.status !== 'running',
            ),
          onWarning: async (message) =>
            updateJob(job.id, (item) => {
              item.logs = [
                ...(item.logs ?? []),
                { time: now(), message: String(message).slice(0, 4000) },
              ].slice(-200);
            }),
          progress: async (progress, message) =>
            updates.push((item) => {
              item.progress = Math.min(100, Math.max(0, progress));
              item.logs = [
                ...(item.logs ?? []),
                { time: now(), message: String(message).slice(0, 4000) },
              ].slice(-200);
            }),
        });
        await updates.flush();
        await updateJob(job.id, (item, state) => {
          item.status = result.paused ? 'paused' : 'completed';
          item.result = result;
          item.finishedAt = now();
          item.resume = false;
          if (item.sourceKey && !result.paused)
            state.processed[item.sourceKey] = {
              filename: path.basename(item.input ?? ''),
              jobId: item.id,
              at: now(),
            };
        });
        if (!result.paused) {
          if (job.settings.PREPARE_REVIEW !== false && !stopping)
            await startReviewTask({ ...job, status: 'completed', result });
          else if (job.settings.PREPARE_REVIEW === false) await cleanupSuccessfulJob(job);
        }
      } catch (error) {
        await updates.flush();
        const manifest = await readJson(at('temp', job.id, 'manifest.json'), null).catch(
          () => null,
        );
        const reviewExists = await fs.access(at('output', 'reviews', `${job.id}.json`)).then(
          () => true,
          () => false,
        );
        const usageExists = await fs
          .access(at('output', 'raw_transcriptions', job.id, 'usage.json'))
          .then(
            () => true,
            () => false,
          );
        await updateJob(job.id, (item, state) => {
          item.status = stopping
            ? 'interrupted'
            : controller.signal.aborted
              ? 'cancelled'
              : 'failed';
          item.error = error.message;
          stopStages(item.stages, item.status as 'interrupted' | 'cancelled' | 'failed');
          item.finishedAt = now();
          if (manifest?.partialResult) item.result = manifest.partialResult;
          if (reviewExists)
            item.result = { ...item.result, reviewFile: `/output/reviews/${job.id}.json` };
          if (usageExists)
            item.result = {
              ...item.result,
              usageFile: `/output/raw_transcriptions/${job.id}/usage.json`,
            };
          item.logs = [...(item.logs ?? []), { time: now(), message: error.message }].slice(-200);
          if (config.PAUSE_ON_FAILURE && item.status === 'failed')
            pauseQueue(state, `“${item.title}” failed: ${error.message}`);
          if (item.status === 'interrupted')
            pauseQueue(
              state,
              'A job was interrupted. Check its saved progress before resuming the queue.',
            );
        });
      } finally {
        active = null;
      }
    }
  } finally {
    pumping = false;
    // Enqueue may have happened after the last claim but before this flag reset.
    const state = await store.read();
    if (
      !stopping &&
      !queueFault &&
      !queueControl(state).paused &&
      state.jobs.some((job) => job.status === 'queued')
    )
      setImmediate(wake);
  }
}

const app = express();
const trustedProxies = (process.env.TRUSTED_PROXIES || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
if (trustedProxies.length) app.set('trust proxy', trustedProxies);
app.disable('x-powered-by');
// Public, minimal liveness check; works through the proxy and inside the image.
app.get('/health', (req, res) =>
  res.status(stopping ? 503 : 200).json({ status: stopping ? 'stopping' : 'ok' }),
);
app.use((req, res, next) => {
  if (stopping) return res.status(503).json({ error: 'Server is stopping' });
  const local =
    PUBLIC_ORIGIN.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(PUBLIC_ORIGIN.hostname);
  const allowedHosts = local
    ? new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`])
    : new Set([PUBLIC_ORIGIN.host]);
  if (!allowedHosts.has(req.headers.host || ''))
    return res.status(403).json({ error: 'Host does not match PUBLIC_ORIGIN' });
  if (req.headers.origin && req.headers.origin !== `${PUBLIC_ORIGIN.protocol}//${req.headers.host}`)
    return res.status(403).json({ error: 'Same-origin requests required' });
  if (req.headers['sec-fetch-site'] === 'cross-site')
    return res.status(403).json({ error: 'Cross-site requests are disabled' });
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
    req.headers['x-yesilcam-request'] !== '1'
  ) {
    return res.status(403).json({ error: 'Missing application request header' });
  }
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  res.set('Cache-Control', 'no-store');
  if (PUBLIC_ORIGIN.protocol === 'https:') res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
const router = express.Router();
if (BASE_PATH)
  app.use((req, res, next) =>
    req.path === BASE_PATH ? res.redirect(308, `${BASE_PATH}/`) : next(),
  );
app.use(BASE_PATH || '/', router);
router.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
router.get('/app-config.js', (req, res) =>
  res
    .type('application/javascript')
    .send(
      `window.APP_BASE_PATH=${JSON.stringify(BASE_PATH)};window.APP_DEFAULT_LANGUAGE=${JSON.stringify(config.DEFAULT_LANGUAGE)};window.APP_TARGET_LANGUAGE=${JSON.stringify(config.TARGET_LANGUAGE)};window.APP_MAX_UPLOAD_BYTES=${config.MAX_UPLOAD_BYTES};window.APP_KEEP_INTERMEDIATES=${config.KEEP_INTERMEDIATES};window.APP_TRANSLATION_ENABLED=${config.TRANSLATION_ENABLED};`,
    ),
);
router.use('/api/auth', express.json({ limit: '8kb', strict: true }));
router.use(installAuth(router, PUBLIC_ORIGIN, BASE_PATH));
router.get('/api/connections', async (req, res) => res.json({ fields: await credentialStatus() }));
router.put(
  '/api/connections/:name',
  express.json({ limit: '300kb', strict: true }),
  async (req, res) => {
    await saveCredential(String(req.params.name), req.body?.value);
    res.json({ success: true });
  },
);
router.delete('/api/connections/:name', async (req, res) => {
  await clearCredential(String(req.params.name));
  res.json({ success: true });
});

async function jobInput(body: Record<string, any> = {}) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (title.length > 200) fail(400, 'Title is too long');
  const sourceLanguage = body.sourceLanguage || config.DEFAULT_LANGUAGE;
  const targetLanguage = body.targetLanguage || config.TARGET_LANGUAGE;
  if (
    typeof sourceLanguage !== 'string' ||
    typeof targetLanguage !== 'string' ||
    !/^(auto|[a-z]{2,3})$/.test(sourceLanguage) ||
    !/^[a-z]{2,3}$/.test(targetLanguage)
  )
    fail(400, 'Invalid language code');
  const booleanOption = (value: unknown, fallback: boolean) => {
    if (value === undefined) return fallback;
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fail(400, 'Invalid cleanup option');
  };
  const alignmentMethod = body.alignmentMethod ?? config.ALIGNMENT_METHOD;
  const transcriptionSettings: Partial<Settings> = {
    PAUSE_BEFORE_TRANSCRIPTION: booleanOption(
      body.pauseBeforeTranscription ?? body.pauseAfterDemucs,
      config.PAUSE_BEFORE_TRANSCRIPTION,
    ),
    PAUSE_AFTER_DEMUCS: false,
    TRANSLATION_ENABLED: booleanOption(body.translateWithCodex, config.TRANSLATION_ENABLED),
    KEEP_INTERMEDIATES: booleanOption(body.keepIntermediates, config.KEEP_INTERMEDIATES),
    TRANSLATION_PROVIDER: 'codex-local',
    CODEX_MODEL: body.codexModel ?? config.CODEX_MODEL,
    DEMUCS_ENABLED: false,
    ALIGNMENT_METHOD: alignmentMethod,
    ALIGN_TO_SPEECH: alignmentMethod !== 'native',
    SILERO_VAD_ENABLED: alignmentMethod === 'silero',
    TRANSCRIPTION_MODE: body.transcriptionMode ?? config.TRANSCRIPTION_MODE,
    TRANSCRIPTION_DIARIZATION: booleanOption(body.diarization, config.TRANSCRIPTION_DIARIZATION),
    TRANSCRIBE_BACKEND: body.provider ?? config.TRANSCRIBE_BACKEND,
    TRANSCRIPTION_MODEL: body.model ?? config.TRANSCRIPTION_MODEL,
    CLOUD_MAX_ESTIMATED_COST:
      body.maxEstimatedCost === undefined
        ? config.CLOUD_MAX_ESTIMATED_COST
        : Number(body.maxEstimatedCost),
    CLOUD_PRICE_PER_MINUTE:
      body.pricePerMinute === undefined
        ? config.CLOUD_PRICE_PER_MINUTE
        : body.pricePerMinute === ''
          ? null
          : Number(body.pricePerMinute),
    CLOUD_PRICE_CURRENCY: body.priceCurrency ?? config.CLOUD_PRICE_CURRENCY,
  };
  try {
    const settings = movieSettings({
      ...config,
      ...transcriptionSettings,
      DEFAULT_LANGUAGE: sourceLanguage,
      TARGET_LANGUAGE: targetLanguage,
    });
    if (fullMovie(settings))
      Object.assign(transcriptionSettings, {
        SILERO_VAD_ENABLED: false,
        ALIGN_TO_SPEECH: false,
        FILTER_HALLUCINATIONS: false,
      });
    validateSettings(settings);
    if (settings.TRANSLATION_ENABLED) {
      const status = await codexStatus({ settings });
      if (!status.available) fail(400, status.message);
    }
    const { provider, model } = selection(settings);
    if (provider.id === 'local' && !config.LOCAL_WHISPER_ENABLED)
      fail(400, 'Local Whisper is not installed in this cloud image; choose a cloud provider');
    if (provider.id !== 'local' && model.perMinute === null)
      fail(400, 'Enter a quoted price per minute for this model');
    if (provider.id === 'compatible' && !(await credential('TRANSCRIPTION_API_URL')))
      fail(400, 'Save a custom transcription URL in Connections');
    if (
      provider.key &&
      !(await credential(provider.key)) &&
      provider.id !== 'compatible' &&
      !settings.PAUSE_BEFORE_TRANSCRIPTION
    )
      fail(400, `${provider.name} needs a key in Connections`);
  } catch (error) {
    fail(400, error.message);
  }
  return { title: title || 'Movie', sourceLanguage, targetLanguage, transcriptionSettings };
}

router.get('/api/transcription-providers', async (req, res) =>
  res.json(await publicCatalog(config)),
);

// Upload before JSON parsing: stream bytes to a private, unique staging file.
router.post('/api/upload-audio', async (req, res) => {
  if (uploading) fail(429, 'An upload is already in progress');
  uploading = true;
  const id = jobId(),
    dir = at('temp', id),
    controller = new AbortController();
  uploadAbort = controller;
  let timer,
    accepted = false;
  const abort = () => controller.abort();
  req.once('aborted', abort);
  try {
    const data = await jobInput(req.query);
    assertQueueCapacity(await store.read());
    const declared =
      req.headers['content-length'] === undefined ? null : Number(req.headers['content-length']);
    if (
      declared !== null &&
      (!Number.isSafeInteger(declared) || declared <= 0 || declared > config.MAX_UPLOAD_BYTES)
    )
      fail(413, 'Upload size exceeds limit');
    await withTempBudget(declared ?? config.MAX_UPLOAD_BYTES, async () => {
      await fs.mkdir(dir, { recursive: true });
      await writeJson(path.join(dir, 'upload-staging.json'), { jobId: id });
      const input = path.join(dir, 'uploaded-audio');
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          callback(
            bytes > config.MAX_UPLOAD_BYTES
              ? Object.assign(new Error('Upload exceeds limit'), { status: 413 })
              : null,
            chunk,
          );
        },
      });
      timer = setTimeout(abort, config.MAX_UPLOAD_TIME_MS);
      await pipeline(req, limit, createWriteStream(input, { flags: 'wx', mode: 0o600 }), {
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!bytes || (declared !== null && bytes !== declared)) fail(400, 'Incomplete upload');
      const info = await probe(input, { signal: controller.signal });
      if (info.duration > config.MAX_INPUT_DURATION_SEC) fail(413, 'Audio duration exceeds limit');
      const type = info.streams.some(
        (stream: { codec_type: string; disposition?: { attached_pic?: number } }) =>
          stream.codec_type === 'video' && !stream.disposition?.attached_pic,
      )
        ? 'video'
        : 'audio';
      const job = await addJob({ ...data, id, type, input });
      accepted = true;
      await fs.rm(path.join(dir, 'upload-staging.json'), { force: true });
      res.status(201).json({ jobId: job.id });
    });
  } finally {
    clearTimeout(timer);
    req.off('aborted', abort);
    uploadAbort = null;
    try {
      if (!accepted) await fs.rm(dir, { recursive: true, force: true });
    } finally {
      uploading = false;
    }
  }
});
router.use(express.json({ limit: '2mb', strict: true }));
router.get('/api/codex', async (req, res) => res.json(await codexStatus()));
router.get('/api/subtitle-translations', async (req, res) => {
  const files = [];
  for (const item of await fs.readdir(at('output', 'subtitles'), { withFileTypes: true })) {
    if (!item.isFile() || !item.name.endsWith('.srt')) continue;
    const stat = await fs.stat(await contained(at('output', 'subtitles'), leaf(item.name)));
    files.push({
      filename: item.name,
      bytes: stat.size,
      url: `/output/subtitles/${encodeURIComponent(item.name)}`,
    });
  }
  res.json({ files: files.sort((a, b) => a.filename.localeCompare(b.filename)) });
});
router.post('/api/subtitle-translations', async (req, res) => {
  const response = await serialized('subtitle-translation-submission', async () => {
    const sourceLanguage = req.body?.sourceLanguage ?? config.DEFAULT_LANGUAGE;
    const targetLanguage = req.body?.targetLanguage ?? config.TARGET_LANGUAGE;
    const model = req.body?.model ?? config.CODEX_MODEL;
    const settings = {
      ...config,
      DEFAULT_LANGUAGE: sourceLanguage,
      TARGET_LANGUAGE: targetLanguage,
      CODEX_MODEL: model,
      TRANSLATION_PROVIDER: 'codex-local',
    };
    try {
      validateSettings(settings);
    } catch (error) {
      fail(400, error.message);
    }
    if (sourceLanguage === targetLanguage) fail(400, 'Choose a different target language');
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 200) fail(400, 'Enter a film title of at most 200 characters');
    const filename = req.body?.filename;
    let content = req.body?.content;
    if (filename !== undefined && content !== undefined)
      fail(400, 'Choose an existing subtitle or upload a file');
    if (filename !== undefined) {
      const file = await contained(at('output', 'subtitles'), leaf(filename));
      if (!filename.endsWith('.srt')) fail(400, 'Choose an SRT file');
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_SUBTITLE_BYTES)
        fail(400, 'Subtitle file must be at most 1 MB');
      content = await fs.readFile(file, 'utf8');
    }
    try {
      subtitleDocument(content);
    } catch (error) {
      fail(400, error.message);
    }
    const status = await codexStatus({ settings });
    if (!status.available) fail(400, status.message);
    const id = jobId(),
      dir = at('temp', id);
    const sourceName = filename ?? `${titleSlug(title)}_${id}_${sourceLanguage}.srt`;
    const sourceSubtitleFile = `/output/subtitles/${encodeURIComponent(sourceName)}`;
    let speakers;
    if (filename) {
      const original = (await store.read()).jobs.find(
        (job) => job.type !== 'translation' && job.result?.subtitleFile === sourceSubtitleFile,
      );
      if (original?.result?.speakerFile) {
        const saved = await readJson(
          at('output', 'reviews', `${jobId(original.id)}-speakers.json`),
          null,
        );
        if (saved?.sourceHash === subtitleHash(content)) speakers = saved;
      }
    }
    const key = submissionKey({
      type: 'translation',
      source: subtitleHash(content),
      sourceLanguage,
      targetLanguage,
      model,
      title,
      speakers: speakers ?? null,
    });
    const duplicate = (await store.read()).jobs.find(
      (job) =>
        job.submissionKey === key ||
        (!job.submissionKey &&
          job.type === 'translation' &&
          ['queued', 'processing', 'interrupted', 'failed'].includes(job.status) &&
          job.input &&
          (job as Job & { sourceSubtitleFile?: string }).sourceSubtitleFile ===
            sourceSubtitleFile &&
          job.settings.TARGET_LANGUAGE === targetLanguage &&
          job.settings.CODEX_MODEL === model),
    );
    if (duplicate && req.body?.forceNew !== true) return { jobId: duplicate.id, existing: true };
    assertQueueCapacity(await store.read());
    await atomicWrite(path.join(dir, 'input.srt'), content);
    if (!filename) await atomicWrite(at('output', 'subtitles', sourceName), content);
    const speakerContextFile = speakers
      ? at('data', 'translation-receipts', id, 'speakers.json')
      : undefined;
    if (speakerContextFile) await writeJson(speakerContextFile, speakers);
    let job: Job;
    try {
      job = await addJob({
        id,
        title,
        type: 'translation',
        input: path.join(dir, 'input.srt'),
        sourceSubtitleFile,
        ...(speakerContextFile ? { speakerContextFile } : {}),
        ...(req.body?.forceNew === true ? {} : { submissionKey: key }),
        sourceLanguage,
        targetLanguage,
        transcriptionSettings: { TRANSLATION_PROVIDER: 'codex-local', CODEX_MODEL: model },
      });
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    }
    return { jobId: job.id };
  });
  res.status(201).json(response);
});
router.get('/api/jobs', async (req, res) => {
  const limit = req.query.limit === undefined ? 100 : Number(req.query.limit);
  const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    fail(400, 'Use a limit of 1–200 and a nonnegative offset');
  const jobs = (await store.read()).jobs.filter(
    (job) => req.query.type !== 'translation' || job.type === 'translation',
  );
  const page = jobs
    .slice()
    .reverse()
    .slice(offset, offset + limit)
    .reverse();
  res.json(
    req.query.view === 'summary' ? { jobs: page.map(jobSummary), total: jobs.length } : page,
  );
});
router.post('/api/queue/control', async (req, res) => {
  const { paused, scannerEnabled } = req.body ?? {};
  if (
    (paused !== undefined && typeof paused !== 'boolean') ||
    (scannerEnabled !== undefined && typeof scannerEnabled !== 'boolean') ||
    (paused === undefined && scannerEnabled === undefined)
  )
    fail(400, 'Provide paused or scannerEnabled as a boolean');
  if (scannerEnabled === true) await jobInput({}); // Check saved credentials before enabling automation.
  await store.update((state) => {
    const control = queueControl(state);
    if (paused !== undefined)
      Object.assign(control, {
        paused,
        reason: paused ? 'Paused by you. The current job may finish.' : null,
      });
    if (scannerEnabled !== undefined) control.scannerEnabled = scannerEnabled;
    control.updatedAt = now();
  });
  queueFault = null;
  if (scannerEnabled === true) void scanMovies();
  wake();
  res.json({ success: true });
});
router.post('/api/jobs', async (req, res) => {
  let url;
  try {
    url = validateYouTubeUrl(req.body?.youtubeUrl);
  } catch (error) {
    fail(400, error.message);
  }
  const imdbId = String(req.body?.imdbId || '').trim();
  if (imdbId && !/^(tt)?\d{5,12}$/.test(imdbId)) fail(400, 'Invalid IMDb ID');
  const data = await jobInput(req.body);
  const key = submissionKey({
    type: 'youtube',
    url,
    imdbId,
    sourceLanguage: data.sourceLanguage,
    targetLanguage: data.targetLanguage,
    settings: data.transcriptionSettings,
  });
  const job = await addJob({
    ...data,
    type: 'youtube',
    youtubeUrl: url,
    imdbId,
    ...(req.body?.forceNew === true ? {} : { submissionKey: key }),
  });
  res.status(201).json({ jobId: job.id });
});
router.post('/api/jobs/clear', async (req, res) => {
  const result = await store.update(async (state) => {
    let count = 0;
    for (const job of state.jobs)
      if (job.status === 'queued') {
        job.status = 'cancelled';
        count++;
      }
    if (req.body?.clearAll === true) {
      const retained = [];
      for (const job of state.jobs) {
        const hasCache = await fs.stat(at('temp', job.id)).then(
          () => true,
          (error) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        if (!terminal.has(job.status) || hasCache) retained.push(job);
      }
      state.jobs = retained;
    }
    return {
      cleared: count,
      message: `${count} queued jobs cancelled; active, paused and cached jobs retained.`,
    };
  });
  res.json(result);
});
router.post('/api/jobs/archive', async (_req, res) => {
  const archived = await store.update(async (state) => {
    const ids = new Set<string>();
    for (const job of state.jobs) {
      if (
        !terminal.has(job.status) ||
        reviewTasks.has(job.id) ||
        (await fs.stat(at('temp', job.id)).catch(() => null))
      )
        continue;
      await writeJson(at('data', 'job-archive', `${jobId(job.id)}.json`), job);
      ids.add(job.id);
    }
    state.jobs = state.jobs.filter((job) => !ids.has(job.id));
    return ids.size;
  });
  res.json({ archived });
});
router.post('/api/jobs/:id/remove-screening', async (req, res) => {
  const id = jobId(req.params.id);
  if (reviewTasks.has(id)) return fail(409, 'Wait for screening preparation to finish');
  await updateJob(id, async (job) => {
    if (job.status !== 'completed') return fail(409, 'Only completed screenings can be removed');
    await removeScreeningCopy(id);
    job.result = { ...job.result, reviewStatus: 'removed' };
  });
  res.json({ success: true });
});
router.get('/api/jobs/:id', async (req, res) => {
  const job = (await store.read()).jobs.find((job) => job.id === jobId(req.params.id));
  if (!job) return fail(404, 'Job not found');
  const hasIntermediates = Boolean(await fs.stat(at('temp', job.id)).catch(() => null));
  res.json({
    ...job,
    hasIntermediates,
    screeningBytes: await directoryBytes(at('review-sessions', job.id)),
  });
});
async function startReviewTask(job: Job) {
  const id = job.id;
  if (reviewTasks.has(id)) return;
  const controller = new AbortController();
  reviewTasks.set(id, controller);
  try {
    await updateJob(id, (item) => {
      item.result = { ...item.result, reviewStatus: 'preparing', reviewError: null };
    });
  } catch (error) {
    reviewTasks.delete(id);
    throw error;
  }
  void (async () => {
    const result = { ...job.result };
    try {
      await prepareJobReview(job, result, controller.signal);
      await updateJob(id, (item) => {
        item.result = result;
      });
      if (result.reviewStatus === 'ready') await cleanupSuccessfulJob(job);
    } catch (error) {
      await updateJob(id, (item) => {
        item.result = { ...item.result, reviewStatus: 'failed', reviewError: error.message };
        stopStages(item.stages, 'interrupted');
      });
    } finally {
      reviewTasks.delete(id);
    }
  })().catch((error) => console.error('Screening preparation:', error.message));
}
router.post('/api/jobs/:id/prepare-review', async (req, res) => {
  const job = (await store.read()).jobs.find((item) => item.id === jobId(req.params.id));
  if (!job) return fail(404, 'Job not found');
  if (job.status !== 'completed')
    return fail(409, 'Finish the subtitle job before preparing its screening');
  await startReviewTask(job);
  res.status(202).json({ preparing: true });
});
router.get('/api/jobs/:id/requests', async (req, res) => {
  res.json({ requests: await inspectRequests(jobId(req.params.id)) });
});
router.post('/api/jobs/:id/reconcile', async (req, res) => {
  if (req.body?.remoteId === undefined && req.body?.allowNewRequest !== true)
    return fail(400, 'Choose an existing transcript ID or authorize a new request');
  await updateJob(jobId(req.params.id), async (job) => {
    if (['queued', 'processing'].includes(job.status))
      return fail(409, 'Cancel the active or queued job before reconciling');
    await reconcileRequest(job.id, String(req.body?.chunkId ?? ''), {
      remoteId: req.body?.remoteId,
      allowNewRequest: req.body?.allowNewRequest === true,
      note: req.body?.note,
    });
  });
  res.json({ success: true });
});
router.get('/api/reviews/:id', async (req, res) => {
  res.json(reviewView(await readSubtitleReview(jobId(req.params.id))));
});
router.post('/api/reviews/:id', async (req, res) => {
  res.json(reviewView(await editSubtitleReview(jobId(req.params.id), req.body)));
});
router.post('/api/reviews/:id/position', async (req, res) => {
  await saveReviewPosition(jobId(req.params.id), req.body?.position);
  res.json({ saved: true });
});
router.get('/api/reviews/:id/subtitles/:file', async (req, res) => {
  const match = String(req.params.file).match(/^([a-z]{2,3})\.(srt|ass|vtt|json)$/);
  if (!match) return fail(404, 'Subtitle export not found');
  const document = await readSubtitleReview(jobId(req.params.id));
  const original = req.query.original === '1';
  const content = reviewExport(document, match[1], match[2], original);
  res.attachment(
    `${titleSlug(document.title)}_${match[1]}${original ? '_original' : ''}.${match[2]}`,
  );
  res
    .type(
      (
        {
          srt: 'application/x-subrip',
          ass: 'text/x-ssa',
          vtt: 'text/vtt',
          json: 'application/json',
        } as Record<string, string>
      )[match[2]],
    )
    .send(content);
});
router.get('/api/jobs/:id/audio-review', async (req, res) => {
  const id = jobId(req.params.id);
  const job = (await store.read()).jobs.find((job) => job.id === id);
  if (!job || job.intermediatesRemoved) return fail(404, 'Audio chunks are unavailable');
  res.json(await audioReview(id));
});
router.get('/api/jobs/:id/audio/:chunkId/:variant', async (req, res) => {
  const id = jobId(req.params.id);
  const job = (await store.read()).jobs.find((job) => job.id === id);
  if (!job || job.intermediatesRemoved) return fail(404, 'Audio chunks are unavailable');
  const file = await audioReviewFile(id, req.params.chunkId, req.params.variant);
  res
    .type(file.endsWith('.flac') ? 'audio/flac' : 'audio/wav')
    .sendFile(file, { acceptRanges: true, cacheControl: false });
});
router.delete('/api/jobs/:id', async (req, res) => {
  const id = jobId(req.params.id);
  if (reviewTasks.has(id)) return fail(409, 'Wait for screening preparation to finish');
  await updateJob(id, async (job, state) => {
    if (!terminal.has(job.status)) fail(409, 'Cancel the job before deleting its history');
    const hasCache = await fs.stat(at('temp', id)).then(
      () => true,
      (error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (hasCache) fail(409, 'Remove this job’s intermediates before deleting its history');
    state.jobs = state.jobs.filter((item) => item.id !== id);
  });
  res.json({ success: true });
});
router.post('/api/jobs/:id/cancel', async (req, res) => {
  const id = jobId(req.params.id);
  await updateJob(id, (job) => {
    if (active?.id === id) {
      active.controller.abort();
      return;
    }
    if (['queued', 'paused', 'interrupted'].includes(job.status)) job.status = 'cancelled';
  });
  res.json({ success: true });
});
async function retry(id: string | string[], maxEstimatedCost?: unknown, retryCodex = true) {
  await updateJob(jobId(id), async (job, state) => {
    if (!['paused', 'failed', 'interrupted', 'cancelled'].includes(job.status))
      fail(409, 'Job is not resumable');
    if (job.intermediatesRemoved) fail(409, 'Intermediates were removed; submit a new job');
    assertQueueCapacity(state);
    if (job.status === 'paused' && !(await readJson(at('temp', job.id, 'manifest.json'), null)))
      fail(409, 'Paused manifest is missing');
    if (job.settings.DEMUCS_ENABLED) {
      const migrated = await migratePreparedAudio(job.id);
      if (migrated) {
        job.settings = migrated.settings;
        job.stages = createStages(job);
      }
    }
    if (maxEstimatedCost !== undefined) {
      const value = Number(maxEstimatedCost);
      if (!Number.isFinite(value) || value <= 0) fail(400, 'Invalid estimate allowance');
      const file = at('temp', job.id, 'manifest.json');
      const manifest = await readJson(file, null);
      if (manifest) {
        manifest.settings.CLOUD_MAX_ESTIMATED_COST = value;
        await writeJson(file, manifest);
      }
      job.settings = { ...job.settings, CLOUD_MAX_ESTIMATED_COST: value };
    }
    // Only the explicit review-pause resume authorizes crossing the audio gate.
    job.resume = job.status === 'paused' || job.resume === true;
    job.status = 'queued';
    job.error = null;
    job.codexRetry = retryCodex;
  });
  wake();
}
router.post('/api/jobs/:id/retry', async (req, res) => {
  await retry(req.params.id, req.body?.maxEstimatedCost, req.body?.retryCodex !== false);
  res.json({ jobId: req.params.id });
});
router.post('/api/paused-jobs/:id/configure', async (req, res) => {
  const input = await jobInput({ ...req.body, pauseBeforeTranscription: true });
  await updateJob(jobId(req.params.id), async (job) => {
    if (job.status !== 'paused' || job.intermediatesRemoved)
      fail(409, 'Job must be paused with its source audio retained');
    const manifest = await configurePausedAudio(job.id, {
      ...job.settings,
      ...input.transcriptionSettings,
      DEFAULT_LANGUAGE: input.sourceLanguage,
      TARGET_LANGUAGE: input.targetLanguage,
    });
    job.settings = manifest.settings;
    job.sourceLanguage = input.sourceLanguage;
    job.targetLanguage = input.targetLanguage;
    job.stages = createStages(job);
    job.progress = 0;
    job.result = undefined;
    job.logs = [
      ...(job.logs ?? []),
      {
        time: now(),
        message:
          'Transcription options saved. Resume prepares the new audio, then pauses for review before paid ASR.',
      },
    ].slice(-200);
  });
  res.json({ success: true });
});
router.get('/api/paused-jobs', async (req, res) =>
  res.json({
    jobs: (await store.read()).jobs
      .filter((j) => j.status === 'paused')
      .map((j) => ({
        jobId: j.id,
        title: j.title,
        pausedAt: j.finishedAt,
        chunkCount: j.result?.chunkCount,
        provider: j.settings.TRANSCRIBE_BACKEND,
        transcriptionMode: fullMovie(j.settings) ? 'full movie' : 'chunks',
      })),
  }),
);
router.post('/api/paused-jobs/:id/resume', async (req, res) => {
  await retry(req.params.id);
  res.json({ jobId: req.params.id, originalJobId: req.params.id });
});
router.post('/api/jobs/:id/cleanup', async (req, res) => {
  if (reviewTasks.has(jobId(req.params.id)))
    return fail(409, 'Wait for screening preparation to finish');
  await updateJob(jobId(req.params.id), async (job) => {
    if (!terminal.has(job.status)) fail(409, 'Only finished jobs can have intermediates removed');
    await preserveCodexReceipt(at('temp', job.id), at('data', 'translation-receipts', job.id));
    await fs.rm(await contained(at('temp'), job.id), { recursive: true, force: true });
    job.intermediatesRemoved = true;
  });
  res.json({ success: true });
});

const translationsRoot = at('output', 'translation_chunks');
async function translationDetails(name: string) {
  const folder = await contained(translationsRoot, leaf(name));
  const manifest = await readJson(await contained(folder, 'manifest.json'));
  const chunks = [];
  for (const file of manifest.files) {
    const data = await readJson(await contained(folder, file));
    const translated = data.entries.filter((entry: any) =>
      validTranslation(entry.translated),
    ).length;
    chunks.push({
      file,
      slimFile: file.replace('.json', '_translate.json'),
      entries: data.entries.length,
      translated,
      progress: data.entries.length ? Math.round((translated / data.entries.length) * 100) : 0,
    });
  }
  return { folder: name, chunks, targetLanguage: manifest.targetLanguage };
}
router.get('/api/translations', async (req, res) => {
  const folders = [];
  for (const dir of await fs.readdir(translationsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory() || dir.name.startsWith('.')) continue;
    try {
      const data = await translationDetails(dir.name);
      const totalEntries = data.chunks.reduce((sum, chunk) => sum + chunk.entries, 0);
      const translatedEntries = data.chunks.reduce((sum, chunk) => sum + chunk.translated, 0);
      folders.push({
        name: dir.name,
        path: `/output/translation_chunks/${encodeURIComponent(dir.name)}`,
        jsonFiles: data.chunks.length,
        slimFiles: data.chunks.length,
        totalEntries,
        translatedEntries,
        progress: totalEntries ? Math.round((translatedEntries / totalEntries) * 100) : 0,
      });
    } catch (error) {
      if (error.code !== 'ENOENT') folders.push({ name: dir.name, error: error.message });
    }
  }
  res.json(folders);
});
router.get('/api/translations/:folder', async (req, res) =>
  res.json(await translationDetails(req.params.folder)),
);
router.post('/api/translations/:folder/upload', async (req, res) => {
  const folder = await contained(translationsRoot, req.params.folder);
  try {
    res.json({
      success: true,
      ...(await importTranslation(
        folder,
        leaf(req.query.filename),
        req.body,
        req.query.type === 'slim',
      )),
    });
  } catch (error) {
    fail(400, error.message);
  }
});
router.post('/api/translations/:folder/merge', async (req, res) => {
  const folder = await contained(translationsRoot, req.params.folder);
  const manifest = await readJson(await contained(folder, 'manifest.json'));
  const filename = `${leaf(req.params.folder)}_${manifest.targetLanguage}.srt`;
  const output = await contained(at('output', 'subtitles'), filename);
  try {
    await mergeTranslatedChunks(
      manifest.files.map((file: string) => path.join(folder, leaf(file))),
      output,
    );
    const styled = await writeSubtitleArtifacts(
      output,
      await fs.readFile(output, 'utf8'),
      manifest.targetLanguage,
      at('output', 'reviews', `${leaf(req.params.folder)}-merged-style.json`),
    );
    res.json({
      success: true,
      outputFile: `/output/subtitles/${encodeURIComponent(filename)}`,
      assFile: `/output/subtitles/${encodeURIComponent(path.basename(styled.assFile))}`,
      styleReviewFile: `/output/reviews/${encodeURIComponent(path.basename(styled.reviewFile))}`,
      message: 'All cues translated; original timestamps preserved.',
    });
  } catch (error) {
    fail(400, error.message);
  }
});

const videoExtensions = new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v']);
async function scanMovies(manual = false) {
  if (scanning || stopping) return;
  scanning = true;
  try {
    const control = queueControl(await store.read());
    if (control.paused || (!manual && !control.scannerEnabled)) return;
    const names = (await fs.readdir(at('movies'), { withFileTypes: true }))
      .filter((item) => item.isFile() && videoExtensions.has(path.extname(item.name).toLowerCase()))
      .map((item) => item.name)
      .sort();
    lastScanFiles = names;
    skippedFiles = [];
    const present = new Set(names);
    for (const name of observations.keys()) if (!present.has(name)) observations.delete(name);
    const manualStats = new Map<string, string>();
    if (manual) {
      for (const filename of names) {
        const stat = await fs.stat(await contained(at('movies'), filename)).catch(() => null);
        if (stat) manualStats.set(filename, `${filename}:${stat.size}:${stat.mtimeMs}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const candidates: {
      filename: string;
      input: string;
      fingerprint: string;
      size: number;
      mtimeMs: number;
    }[] = [];
    for (const filename of names) {
      if (stopping) break;
      const input = await contained(at('movies'), filename),
        stat = await fs.stat(input).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
      if (!stat) continue;
      const fingerprint = `${filename}:${stat.size}:${stat.mtimeMs}`;
      const previous = observations.get(filename);
      observations.set(filename, {
        fingerprint,
        seen: previous?.fingerprint === fingerprint ? previous.seen : Date.now(),
      });
      if (
        manual
          ? manualStats.get(filename) !== fingerprint
          : !previous || previous.fingerprint !== fingerprint || Date.now() - previous.seen < 10000
      ) {
        skippedFiles.push({ filename, reason: 'Waiting for file to stop changing' });
        continue;
      }
      candidates.push({ filename, input, fingerprint, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    if (!candidates.length) {
      scanError = null;
      return;
    }
    const initial = await store.read();
    const known = new Set([
      ...Object.keys(initial.processed),
      ...initial.jobs.map((job) => job.sourceKey),
    ]);
    const newCandidates = candidates.filter((item) => !known.has(item.fingerprint));
    // No expensive preparation or futile failed jobs when a cloud key/login is missing.
    const defaults = newCandidates.length ? await jobInput({}) : null;
    await store.update((state) => {
      if (
        stopping ||
        queueControl(state).paused ||
        (!manual && !queueControl(state).scannerEnabled)
      )
        return;
      const bySource = new Map(state.jobs.map((job) => [job.sourceKey, job]));
      const busyInputs = new Set(
        state.jobs.filter((job) => !terminal.has(job.status)).map((job) => job.input),
      );
      let waiting = state.jobs.filter((job) => job.status === 'queued').length;
      for (const { filename, input, fingerprint, size, mtimeMs } of candidates) {
        if (state.processed[fingerprint]) {
          skippedFiles.push({ filename, reason: 'Completed output saved' });
          continue;
        }
        const existing = bySource.get(fingerprint);
        if (existing) {
          skippedFiles.push({
            filename,
            reason: `Existing job: ${existing.status}; use Retry if needed`,
          });
          continue;
        }
        if (busyInputs.has(input)) {
          skippedFiles.push({
            filename,
            reason: 'An earlier version of this file still has an unfinished job',
          });
          continue;
        }
        if (!defaults || waiting >= config.MAX_QUEUED_JOBS) {
          skippedFiles.push({ filename, reason: 'Queue is full; a later scan will pick this up' });
          continue;
        }
        const job: Job = {
          id: jobId(),
          type: 'video',
          pathSchema: 1,
          input,
          title: path.parse(filename).name,
          sourceKey: fingerprint,
          status: 'queued',
          progress: 0,
          logs: [],
          createdAt: now(),
          settings: { ...config, ...defaults.transcriptionSettings },
          sourceStat: { size, mtimeMs },
        };
        job.stages = createStages(job);
        state.jobs.push(job);
        waiting++;
      }
    });
    scanError = null;
  } catch (error) {
    scanError = error.message;
    console.error('Movie scan:', error.message);
  } finally {
    scanning = false;
    wake();
  }
}
router.post('/api/movies/scan', async (req, res) => {
  await scanMovies(true);
  if (scanError) fail(500, scanError);
  res.json({ success: true });
});
router.post('/api/movies/reset', async (req, res) => {
  const filename = leaf(req.body?.filename);
  await store.update((state) => {
    for (const [key, value] of Object.entries(state.processed))
      if (value.filename === filename) delete state.processed[key];
    // Release scanner deduplication for finished jobs while preserving history.
    for (const job of state.jobs)
      if (path.basename(job.input ?? '') === filename && terminal.has(job.status))
        delete job.sourceKey;
  });
  res.json({ success: true });
});
router.post('/api/movies/reset-all', async (req, res) => {
  await store.update((state) => {
    state.processed = {};
    for (const job of state.jobs) if (terminal.has(job.status)) delete job.sourceKey;
  });
  res.json({ success: true });
});
router.get('/api/movies/processed', async (req, res) =>
  res.json({ files: Object.values((await store.read()).processed) }),
);
router.get('/api/found', async (req, res) => {
  const result = [];
  for (const entry of await fs.readdir(at('found'), { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith('.srt')) {
      const file = await contained(at('found'), entry.name),
        stat = await fs.stat(file);
      result.push({
        filename: entry.name,
        size: stat.size,
        downloadedAt: stat.mtime.toISOString(),
      });
    }
  res.json(result);
});
router.get('/api/status', async (req, res) => {
  const state = await store.read(),
    pending = state.jobs.filter((job) => job.status === 'queued');
  const control = queueControl(state);
  res.json({
    scanner: {
      active: !stopping && control.scannerEnabled,
      interval: 60000,
      moviesDir: at('movies'),
      totalFiles: lastScanFiles.length,
      processedCount: Object.keys(state.processed).length,
      pendingInDir: skippedFiles.filter((f) => f.reason.startsWith('Waiting')).length,
      error: scanError,
    },
    queue: {
      paused: control.paused || Boolean(queueFault),
      reason: queueFault || control.reason,
      maxQueuedJobs: config.MAX_QUEUED_JOBS,
      isProcessing: Boolean(active),
      pendingJobs: pending.length,
      pendingTitles: pending.slice(0, 20).map((j) => j.title),
      currentTitle: state.jobs.find((j) => j.id === active?.id)?.title,
    },
    storage: {
      ...(await storageStatus()),
      maxTemporaryBytes: config.MAX_TEMP_BYTES,
      minFreeBytes: config.MIN_FREE_DISK_BYTES,
    },
    skippedFiles: skippedFiles.slice(-50),
    config: { opensubtitlesConfigured: Boolean(await credential('OPENSUBTITLES_API_KEY')) },
  });
});

// Review media belongs on the data volume, never inside the image/build directory.
router.get('/review-sessions/:session/:file', async (req, res, next) => {
  const session = leaf(req.params.session),
    file = leaf(req.params.file);
  if (!/\.(webm|mp4|mkv|srt|ass|vtt|json|md)$/.test(file)) return fail(404, 'Not found');
  const target = await contained(at('review-sessions'), session, file);
  const exists = await fs.stat(target).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!exists) return next(); // Preserve old local review sessions during migration.
  if (!exists.isFile()) return fail(404, 'Not found');
  res.sendFile(target, { acceptRanges: true, cacheControl: false });
});

// Generated files are served as attachments through containment checks. No static
// directory traversal or symlink can expose .env, manifests, cookies or the queue.
router.get(/^\/(output|found)\/(.+)$/, async (req, res) => {
  const category = req.params[0],
    parts = req.params[1].split('/').map(leaf);
  if (
    category === 'output' &&
    !['subtitles', 'translation_chunks', 'reviews', 'raw_transcriptions'].includes(parts[0])
  )
    fail(404, 'Not found');
  if (!/\.(json|srt|ass)$/.test(parts.at(-1) ?? '')) fail(404, 'Not found');
  const file = await contained(at(category), ...parts);
  res.download(file, path.basename(file));
});
router.use(express.static(at('public'), { dotfiles: 'deny', fallthrough: true }));
const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  const message =
    error.type === 'entity.parse.failed'
      ? 'Invalid JSON body'
      : error.type === 'entity.too.large'
        ? 'Request body exceeds the limit'
        : error.message;
  console.error(message);
  if (res.headersSent) return next(error);
  const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
  res.status(status).json({
    error: status >= 500 ? 'The operation failed. Check the server log for details.' : message,
  });
};
app.use(errorHandler);

const server = app.listen(PORT, HOST);
try {
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
} catch (error) {
  await releaseLock();
  throw error;
}
console.log(`Yeşilçam Revival: ${PUBLIC_ORIGIN.origin}${BASE_PATH}/`);
server.requestTimeout = config.MAX_UPLOAD_TIME_MS + 30000;
const scanTimer = setInterval(() => {
  void scanMovies();
}, 60000);
void scanMovies();
wake();
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(scanTimer);
  const draining = drainPaidWork(config.SHUTDOWN_GRACE_MS);
  for (const controller of reviewTasks.values()) controller.abort();
  uploadAbort?.abort();
  server.close();
  console.log('Shutdown: waiting for submitted transcription responses to be saved');
  await draining;
  active?.controller.abort();
  const deadline = Date.now() + 15000;
  while ((pumping || uploading || scanning || reviewTasks.size) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 100));
  // Release the kernel lock only once work has stopped; process exit closes it too.
  if (!pumping && !uploading && !scanning && !reviewTasks.size) await releaseLock();
  process.exit(pumping || uploading || scanning || reviewTasks.size ? 1 : 0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function fatal(error: unknown) {
  console.error('Fatal server error:', error);
  active?.controller.abort();
  for (const controller of reviewTasks.values()) controller.abort();
  uploadAbort?.abort();
  terminateChildren();
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
