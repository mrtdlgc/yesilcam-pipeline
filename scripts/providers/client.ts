import type { RequestState } from '../../types/checkpoints.js';
import { acquireProcessLock } from '../lib/process-identity.js';
import { assertPaidSubmissionAllowed, trackPaidWork } from '../lib/paid-work.js';
import type { Settings } from '../../types/pipeline.js';
import { credential } from '../lib/credentials.js';
import fs from 'node:fs/promises';
import { createReadStream, openAsBlob } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fetchLimited } from '../lib/http.js';
import { readJson, writeJson } from '../lib/files.js';
import { estimate, selection } from './catalog.js';
import { adapters } from './adapters.js';
import { normalize } from './normalize.js';
import { fullMovie, scribeDiarization } from '../lib/transcription-mode.js';

export function cloudPlan(chunks: any, settings: Settings, language = settings.DEFAULT_LANGUAGE) {
  const selected = selection(settings, language);
  const quote = estimate(chunks, selected);
  return {
    provider: selected.provider.id,
    model: selected.model.id,
    ...quote,
    timing: selected.model.timing,
    billing: selected.provider.billing,
    chunks: chunks.length,
  };
}

export function checkCloudPlan(plan: any, settings: Settings) {
  if (plan.provider === 'local') return;
  if (plan.amount === null)
    throw new Error(
      'No verified price for this model. Set a quoted price per minute before submitting audio.',
    );
  if (plan.amount > settings.CLOUD_MAX_ESTIMATED_COST)
    throw new Error(
      `Estimated transcription cost ${plan.amount.toFixed(4)} ${plan.currency} exceeds the job estimate limit ${settings.CLOUD_MAX_ESTIMATED_COST}`,
    );
}

export function reservedAmount(
  request: Pick<RequestState, 'estimate' | 'reportedCost' | 'usageCostEstimate'>,
  currency: string,
) {
  return Math.max(
    request.estimate.amount ?? 0,
    request.reportedCost?.currency === currency ? request.reportedCost.amount : 0,
    request.usageCostEstimate?.currency === currency ? request.usageCostEstimate.amount : 0,
  );
}

export async function usageReport(rawDir: string, plan: any) {
  const files = await fs.readdir(rawDir).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  });
  const requests = [];
  for (const file of files.filter((f) =>
    /^chunk_[a-zA-Z0-9_-]+(?:\.attempt-\d+)?\.request\.json$/.test(f),
  )) {
    const r = await readJson<RequestState>(path.join(rawDir, file));
    requests.push({
      chunkId: r.chunkId,
      provider: r.provider,
      model: r.model,
      status: r.status,
      seconds: r.estimate.seconds,
      estimate: r.estimate,
      reportedCost: r.reportedCost ?? null,
      requestId: r.requestId,
      remoteId: r.remoteId,
      elapsedMs: r.elapsedMs,
      usage: r.usage,
      attempts: r.attempts,
      usageCostEstimate: r.usageCostEstimate,
      file,
      error: r.error,
    });
  }
  const potentiallyBilled = requests.filter(
    (r) => r.status !== 'rejected' && r.status !== 'prepared',
  );
  const trackedChunks = new Set(requests.map((r) => String(r.chunkId)));
  const untrackedCachedChunks =
    plan.provider === 'local'
      ? 0
      : files.filter((f) => {
          const match = /^chunk_([a-zA-Z0-9_-]+)\.json$/.exec(f);
          return match && !trackedChunks.has(match[1]);
        }).length;
  const report = {
    version: 1,
    updatedAt: new Date().toISOString(),
    plan,
    requests,
    untrackedCachedChunks,
    estimatedReserved: potentiallyBilled.reduce((sum, r) => sum + (r.estimate.amount ?? 0), 0),
    allowanceReserved: potentiallyBilled.reduce(
      (sum, r) => sum + reservedAmount(r, plan.currency),
      0,
    ),
    reportedAmountKnown: potentiallyBilled.reduce(
      (sum, r) => sum + (r.reportedCost?.amount ?? 0),
      0,
    ),
    unreportedRequests: potentiallyBilled.filter((r) => !r.reportedCost).length,
    uncertainRequests: requests.filter((r) => ['submitting', 'uncertain'].includes(r.status))
      .length,
    note: 'Estimates exclude account credits, discounts, taxes and subscription fees. Reported cost is available only when returned by the provider. OpenRouter BYOK costs may exclude the upstream bill. An estimate is not an invoice.',
  };
  await writeJson(path.join(rawDir, 'usage.json'), report);
  return report;
}

export async function transcribeCloud(
  chunk: any,
  language: string,
  prompt: any,
  settings: Settings,
  options: any,
) {
  await fs.mkdir(options.rawDir, { recursive: true });
  const lockFile = path.join(options.rawDir, `chunk_${chunk.id}.request.lock`);
  const release = await acquireProcessLock(lockFile);
  try {
    return await trackPaidWork(() => transcribeLocked(chunk, language, prompt, settings, options));
  } finally {
    await release();
  }
}

async function transcribeLocked(
  chunk: any,
  language: string,
  prompt: any,
  settings: Settings,
  options: any,
) {
  const selected = selection(settings, language);
  const adapter = adapters[selected.provider.id];
  if (!adapter) throw new Error('No cloud adapter for selected provider');
  const key = await credential(selected.provider.key);
  const endpoint = await credential('TRANSCRIPTION_API_URL');
  const region = (await credential('SPEECHMATICS_REGION')) || 'eu1';
  const movie = fullMovie(settings);
  if (movie && (selected.provider.id !== 'elevenlabs' || selected.model.id !== 'scribe_v2'))
    throw new Error('Full-movie uploads require direct ElevenLabs / Scribe v2');
  const stat = await fs.stat(chunk.file);
  const limit = movie ? settings.MAX_MOVIE_AUDIO_BYTES : 20 * 1024 * 1024;
  if (!stat.isFile() || !stat.size || stat.size > limit)
    throw new Error(
      `Transcription audio exceeds the ${Math.floor(limit / 1024 / 1024)} MiB upload limit or is empty`,
    );
  if (
    chunk.audioStat &&
    (chunk.audioStat.size !== stat.size || chunk.audioStat.mtimeMs !== stat.mtimeMs)
  )
    throw new Error('Transcription audio changed after preparation');
  const handle = await fs.open(chunk.file, 'r');
  const header = Buffer.alloc(12);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }
  const magic = header.subarray(0, 4).toString('ascii');
  const formats = {
    wav: 'audio/wav',
    flac: 'audio/flac',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    ogg: 'audio/ogg',
    webm: 'audio/webm',
  };
  const format =
    ['RIFF', 'RF64'].includes(magic) && header.subarray(8, 12).toString('ascii') === 'WAVE'
      ? 'wav'
      : magic === 'fLaC'
        ? 'flac'
        : magic === 'OggS'
          ? 'ogg'
          : header.subarray(4, 8).toString('ascii') === 'ftyp'
            ? 'm4a'
            : header.subarray(0, 3).toString('ascii') === 'ID3' ||
                (header[0] === 0xff && (header[1] & 0xe0) === 0xe0 && (header[1] & 6) !== 0)
              ? 'mp3'
              : header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
                ? 'webm'
                : null;
  if (!format)
    throw new Error('Unknown cloud audio container; use the pipeline prepared WAV chunks');
  const audioHash = createHash('sha256');
  for await (const part of createReadStream(chunk.file, { signal: options.signal }))
    audioHash.update(part);
  const current = await fs.stat(chunk.file);
  if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)
    throw new Error('Transcription audio changed while hashing');
  const identity = audioHash
    .update(
      JSON.stringify({
        signature: options.signature,
        language,
        prompt,
        provider: selected.provider.id,
        model: selected.model.id,
        ...(movie ? { requestMode: 'movie' } : {}),
        ...(scribeDiarization(settings) ? { diarization: true } : {}),
        endpoint: selected.provider.id === 'compatible' ? (endpoint ?? '') : '',
        region: selected.provider.id === 'speechmatics' ? region : '',
      }),
    )
    .digest('hex');
  const stateFile = path.join(options.rawDir, `chunk_${chunk.id}.request.json`);
  let state = await readJson<RequestState | null>(stateFile, null);
  if (state && state.identity !== identity)
    throw new Error('Cloud request checkpoint does not match the audio/configuration');
  if (state && ['submitting', 'uncertain'].includes(state.status)) {
    throw new Error(
      `Chunk ${chunk.id} may already have been charged. Inspect ${stateFile}; reconcile the request before explicitly allowing a new attempt.`,
    );
  }
  const quote = estimate([chunk], selected);
  state ??= {
    version: 1,
    identity,
    chunkId: chunk.id,
    provider: selected.provider.id,
    model: selected.model.id,
    status: 'prepared',
    estimate: quote,
    attempts: 0,
    createdAt: new Date().toISOString(),
  };
  const save = async (patch: Partial<RequestState>) => {
    Object.assign(state, patch);
    await writeJson(stateFile, state);
  };
  if (state.result) {
    const response = await normalize(state.result, chunk, settings, selected);
    if (state.error) await save({ error: null });
    response._runtime.cached = true;
    return response;
  }
  if (!key && selected.provider.id !== 'compatible')
    throw new Error(`${selected.provider.key} is missing`);
  const timeout = movie
    ? settings.MOVIE_TRANSCRIPTION_TIMEOUT_MS
    : settings.TRANSCRIPTION_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(movie ? timeout : settings.CLOUD_JOB_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const started = Date.now();
  const request = async (url: string, init = {}) => {
    const r = await fetchLimited(url, {
      ...init,
      redirect: 'error',
      signal,
      timeout,
      maxBytes: movie ? 32 * 1024 * 1024 : 8 * 1024 * 1024,
    });
    const value = r.json();
    const requestId =
      r.headers.get('x-generation-id') ?? r.headers.get('x-request-id') ?? value.request_id;
    if (requestId) await save({ requestId });
    return value;
  };
  const submit = async (url: string, init: any) => {
    if (state.submissionResponse) return state.submissionResponse;
    assertPaidSubmissionAllowed();
    const usage = await usageReport(options.rawDir, options.plan);
    const reserved = usage.requests
      .filter((r) => !['prepared', 'rejected'].includes(r.status))
      .reduce((sum, r) => sum + reservedAmount(r, quote.currency), 0);
    if (quote.amount === null || reserved + quote.amount > settings.CLOUD_MAX_ESTIMATED_COST)
      throw new Error('Next request exceeds the estimated job allowance');
    signal.throwIfAborted();
    assertPaidSubmissionAllowed();
    await save({
      status: 'submitting',
      submittedAt: new Date().toISOString(),
      attempts: state.attempts + 1,
      error: null,
    });
    let r;
    try {
      r = await request(url, { ...init, method: 'POST' });
    } catch (error) {
      // A timeout, disconnected response, or 5xx cannot establish whether the
      // provider accepted/billed the request. Never automatically POST again.
      await save({
        status: [400, 401, 402, 403, 404, 405, 413, 415, 422, 429].includes(error.status)
          ? 'rejected'
          : 'uncertain',
        error: error.message,
        ...(error.requestId ? { requestId: error.requestId } : {}),
      });
      throw error;
    }
    await save({ status: 'accepted', submissionResponse: r });
    return r;
  };
  try {
    // Node's file-backed Blob streams multipart uploads without loading a movie
    // into RAM. Small adapters retain their existing Buffer interface.
    const audioFile = movie ? await openAsBlob(chunk.file, { type: formats[format] }) : undefined;
    const audio = movie ? Buffer.alloc(0) : await fs.readFile(chunk.file);
    const result = await adapter({
      audio,
      audioFile,
      format,
      mime: formats[format],
      selected,
      key,
      endpoint,
      region,
      state,
      settings,
      language,
      prompt,
      signal,
      request,
      submit,
      save,
    });
    const usage = result.usage ?? null;
    const reportedCost =
      selected.provider.id === 'openrouter' && Number.isFinite(usage?.cost) && usage.cost >= 0
        ? { amount: usage.cost, currency: 'USD', source: 'provider usage.cost' }
        : null;
    const usageCostEstimate =
      selected.provider.id === 'gemini' &&
      Number.isFinite(usage?.total_input_tokens) &&
      Number.isFinite(usage?.total_output_tokens) &&
      selected.model.inputPerMillion !== undefined &&
      selected.model.outputPerMillion !== undefined
        ? {
            currency: 'USD',
            amount:
              (usage.total_input_tokens * selected.model.inputPerMillion +
                usage.total_output_tokens * selected.model.outputPerMillion) /
              1e6,
            source: 'Reported tokens multiplied by published rates; excludes credits and discounts',
          }
        : null;
    await save({
      status: 'complete',
      result,
      submissionResponse: null, // The complete result replaces the submission copy.
      usage,
      reportedCost,
      usageCostEstimate,
      error: null,
      elapsedMs: (state.elapsedMs ?? 0) + Date.now() - started,
    });
    return await normalize(result, chunk, settings, selected);
  } catch (error) {
    await save({
      error: error.message,
      ...(state.status !== 'complete'
        ? { elapsedMs: (state.elapsedMs ?? 0) + Date.now() - started }
        : {}),
    });
    throw error;
  } finally {
    await usageReport(options.rawDir, options.plan);
  }
}
