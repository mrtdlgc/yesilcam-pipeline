import type { Settings } from '../types/pipeline.js';
import type { Chunk, Segment } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import { credential } from './lib/credentials.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from '../config.js';
import { at, jobId as validateId, readJson, writeJson } from './lib/files.js';
import { WHISPER_PYTHON, whisperEnv, run, checkAbort } from './lib/process.js';
import { cloudPlan, checkCloudPlan, transcribeCloud, usageReport } from './providers/client.js';
import { WhisperWorker } from './lib/whisper-worker.js';
import { fullMovie, scribeDiarization } from './lib/transcription-mode.js';
export { formatTimestamp as formatSRTTime, segmentsToSrt } from './lib/srt.js';

export function buildSandwichPrompt(
  movieContext: Record<string, any> = {},
  previousSentence: string | null = null,
) {
  if (!previousSentence || /\uFFFD|Ã.|Â.|Р[°-я]/u.test(previousSentence)) return null;
  return previousSentence.trim().slice(-250);
}

function validateResponse(response: any, chunk: Chunk) {
  if (!Array.isArray(response.segments)) throw new Error('Transcriber returned no segment array');
  const duration = chunk.endTime - chunk.startTime;
  return response.segments
    .filter((segment: Segment) => typeof segment.text !== 'string' || segment.text.trim())
    .map((segment: Segment) => {
      if (
        !Number.isFinite(segment.start) ||
        !Number.isFinite(segment.end) ||
        segment.start < 0 ||
        segment.end <= segment.start ||
        segment.end > duration + 0.25 ||
        typeof segment.text !== 'string'
      ) {
        throw new Error(`Invalid transcription timestamps in chunk ${chunk.id}`);
      }
      const end = Math.min(segment.end, duration);
      if (end <= segment.start) throw new Error(`Transcription cue exceeds chunk ${chunk.id}`);
      return {
        ...segment,
        end,
        text: segment.text
          .trim()
          .replace(/\r\n?/g, '\n')
          .replace(/\n\s*\n/g, '\n'),
        _chunkId: chunk.id,
      };
    })
    .filter((segment: Segment) => segment.text);
}

export async function transcribeChunksToSegments(
  chunks: Chunk[],
  language: string,
  id: any,
  movieContext: Record<string, any> = {},
  options: PipelineOptions = {},
) {
  validateId(id);
  const settings = { ...config, ...options.settings };
  const movie = fullMovie(settings);
  if (movie && (chunks.length !== 1 || chunks[0].startTime !== 0))
    throw new Error('Full-movie transcription requires one continuous audio file starting at zero');
  if (['local', 'auto'].includes(settings.TRANSCRIBE_BACKEND) && !config.LOCAL_WHISPER_ENABLED)
    throw new Error('Local Whisper is not installed in this cloud image');
  for (const chunk of chunks) {
    if (
      !/^[a-zA-Z0-9_-]{1,60}$/.test(String(chunk.id)) ||
      !Number.isFinite(chunk.startTime) ||
      !Number.isFinite(chunk.endTime) ||
      chunk.startTime < 0 ||
      chunk.endTime <= chunk.startTime
    )
      throw new Error('Invalid transcription chunk');
  }
  if (new Set(chunks.map((c: any) => String(c.id))).size !== chunks.length)
    throw new Error('Duplicate chunk IDs');
  const rawDir = at('output', 'raw_transcriptions', id);
  const inferenceSettings = Object.fromEntries(
    [
      'TRANSCRIBE_BACKEND',
      'ALLOW_CLOUD_FALLBACK',
      'LOCAL_WHISPER_MODEL',
      'LOCAL_WHISPER_DEVICE',
      'LOCAL_WHISPER_COMPUTE_TYPE',
      'LOCAL_WHISPER_CPU_THREADS',
      'LOCAL_WHISPER_WORKERS',
      'WORD_TIMESTAMPS',
      'GROQ_MODEL',
      'WHISPER_PROMPT_ENABLED',
      'WHISPER_USE_PREVIOUS_SENTENCE',
    ].map((key) => [key, settings[key as keyof Settings]]),
  );
  const legacySignature = createHash('sha256')
    .update(
      JSON.stringify({
        language,
        settings: inferenceSettings,
        chunks: chunks.map(({ id, file, startTime, endTime, audioStat }: Record<string, any>) => ({
          id,
          file,
          startTime,
          endTime,
          audioStat,
        })),
      }),
    )
    .digest('hex');
  const records = [];
  let worker,
    backend = settings.TRANSCRIBE_BACKEND,
    previous = null,
    previousEnd = null;
  if (backend === 'auto') {
    try {
      await run(WHISPER_PYTHON(), [at('scripts', 'local_whisper.py'), '--check'], {
        timeout: 30000,
        signal: options.signal,
        env: whisperEnv(settings),
      });
      backend = 'local';
    } catch (error) {
      checkAbort(options.signal);
      if (!settings.ALLOW_CLOUD_FALLBACK) throw error;
      backend = 'groq';
      await options.onWarning?.(
        'Local Whisper unavailable; explicitly enabled cloud fallback is being used.',
      );
    }
  }
  const effective = { ...settings, TRANSCRIBE_BACKEND: backend };
  if (backend === 'local' && settings.TRANSCRIPTION_MODEL)
    effective.LOCAL_WHISPER_MODEL = settings.TRANSCRIPTION_MODEL;
  const plan = cloudPlan(chunks, effective, language);
  checkCloudPlan(plan, effective);
  const signature = createHash('sha256')
    .update(
      JSON.stringify({
        legacySignature,
        backend,
        model: plan.model,
        schema: 2,
        compatibleFormat: settings.COMPATIBLE_RESPONSE_FORMAT,
        ...(movie ? { requestMode: 'movie' } : {}),
        ...(scribeDiarization(settings) ? { diarization: true } : {}),
        endpoint:
          backend === 'compatible' ? ((await credential('TRANSCRIPTION_API_URL')) ?? '') : '',
        region:
          backend === 'speechmatics' ? ((await credential('SPEECHMATICS_REGION')) ?? 'eu1') : '',
      }),
    )
    .digest('hex');
  try {
    for (let index = 0; index < chunks.length; index++) {
      checkAbort(options.signal);
      const chunk = chunks[index];
      if (previousEnd !== null && chunk.startTime - previousEnd > 3) previous = null;
      const prompt =
        settings.WHISPER_PROMPT_ENABLED && settings.WHISPER_USE_PREVIOUS_SENTENCE
          ? buildSandwichPrompt(movieContext, previous)
          : null;
      const rawFile = path.join(rawDir, `chunk_${chunk.id}.json`);
      let saved = await readJson(rawFile, null);
      if (
        saved &&
        ((saved.signature !== signature &&
          !(
            saved.version === 1 &&
            !settings.TRANSCRIPTION_MODEL &&
            ['local', 'groq'].includes(backend) &&
            saved.signature === legacySignature
          )) ||
          saved.chunk.id !== chunk.id ||
          saved.prompt !== prompt)
      ) {
        throw new Error('Checkpoint configuration differs; start a new job to change settings');
      }
      if (saved) {
        try {
          validateResponse(saved.response, chunk);
        } catch (error) {
          if (backend !== 'local') throw error; // Retain paid responses without another charge.
          await fs.rename(
            rawFile,
            path.join(rawDir, `chunk_${chunk.id}.invalid-${Date.now()}.json`),
          );
          saved = null; // Preserve bad evidence while letting Retry actually retry it.
        }
      }
      const cacheHit = Boolean(saved);
      if (!saved) {
        let response;
        if (backend === 'local') {
          if (!worker) {
            await options.onStage?.({
              id: 'transcription',
              completed: index,
              total: chunks.length,
              unit: 'chunks',
              detail: 'Loading the local Whisper model (first use may download weights)',
            });
            worker = new WhisperWorker(effective, options.signal);
            await worker.start();
          }
          await options.onStage?.({
            id: 'transcription',
            completed: index,
            total: chunks.length,
            unit: 'chunks',
            detail: `Local ASR is transcribing chunk ${index + 1}/${chunks.length}`,
          });
          response = await worker.transcribe(
            chunk.file,
            language === 'auto' ? null : language,
            prompt,
          );
        } else {
          await options.onStage?.({
            id: 'transcription',
            completed: index,
            total: chunks.length,
            unit: movie ? 'movie' : 'chunks',
            ...(movie ? { percentage: null } : {}),
            detail: movie
              ? 'Uploading the complete audio and waiting for ElevenLabs'
              : `Waiting for ${backend} on chunk ${index + 1}/${chunks.length}`,
          });
          if (backend === 'groq' && index > 0)
            await delay(settings.GROQ_RATE_LIMIT_DELAY_MS, undefined, { signal: options.signal });
          const started = Date.now();
          let reporting = false;
          let report = Promise.resolve();
          const heartbeat = movie
            ? setInterval(() => {
                if (reporting) return;
                reporting = true;
                report = Promise.resolve(
                  options.onStage?.({
                    id: 'transcription',
                    percentage: null,
                    detail: `ElevenLabs full-movie request in progress · ${Math.floor((Date.now() - started) / 1000)}s elapsed; provider percentage unavailable`,
                  }),
                )
                  .catch(() => {})
                  .finally(() => {
                    reporting = false;
                  });
              }, 15000)
            : undefined;
          try {
            response = await transcribeCloud(chunk, language, prompt, effective, {
              signal: options.signal,
              rawDir,
              signature,
              plan,
            });
          } finally {
            clearInterval(heartbeat);
            await report;
          }
        }
        saved = { version: 2, signature, chunk, prompt, response };
        // Retain even a malformed model response for inspection. Validation below
        // prevents publishing it or advancing to a later chunk.
        await writeJson(rawFile, saved);
      }
      const segments = validateResponse(saved.response, chunk);
      records.push({
        chunk,
        segments,
        rawFile,
        language: saved.response.language,
        text:
          typeof saved.response.text === 'string'
            ? saved.response.text
            : segments.map((s: any) => s.text).join(' '),
        runtime: saved.response._runtime,
        usage: saved.response._usage,
        cached: cacheHit || saved.response._runtime?.cached === true,
      });
      const tail = segments.at(-1)?.text ?? '';
      previous = tail.match(/[^.!?]+[.!?]?\s*$/u)?.[0]?.trim() ?? tail;
      previousEnd = chunk.endTime;
      await options.onProgress?.(index + 1, chunks.length);
    }
  } finally {
    await worker?.stop();
    await usageReport(rawDir, plan);
  }
  if (options.returnChunks) return records;
  return records.flatMap(({ chunk, segments }) =>
    segments.map((segment: Segment) => offsetSegment(segment, chunk.startTime)),
  );
}

export function offsetSegment(segment: Segment, offset: number): Segment {
  return {
    ...segment,
    start: segment.start + offset,
    end: segment.end + offset,
    ...(segment.words
      ? {
          words: segment.words.map((word: any) => ({
            ...word,
            start: word.start + offset,
            end: word.end + offset,
          })),
        }
      : {}),
    _filmOffset: offset,
  };
}

export async function transcribeToSegments(
  file: string,
  language: string,
  id: any,
  chunkIndex = 0,
  prompt: string | null = null,
  movieContext: Record<string, any> = {},
  options: PipelineOptions = {},
) {
  const { probe } = await import('./lib/process.js');
  const { duration } = await probe(file, { signal: options.signal });
  return transcribeChunksToSegments(
    [{ id: chunkIndex ?? 0, file, startTime: 0, endTime: duration }],
    language,
    id,
    movieContext,
    options,
  );
}
