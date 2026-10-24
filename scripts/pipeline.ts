import type { PipelineResult } from '../types/pipeline.js';
import type { Settings, Segment, Chunk } from '../types/pipeline.js';
import type { PipelineOptions } from '../types/pipeline.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  at,
  DATA_ROOT,
  jobId as validateId,
  titleSlug,
  readJson,
  writeJson,
  atomicWrite,
} from './lib/files.js';
import { checkAbort, probe } from './lib/process.js';
import { withTempBudget } from './lib/storage.js';
import { checkExistingSubtitles } from './0_check_subs.js';
import { downloadVideo } from './1_download_video.js';
import { validateSourceMedia } from './2_extract_audio.js';
import { chunkAudio } from './2.5_chunk_audio.js';
import { filterWithSileroVAD } from './2.6_vad_filter.js';
import {
  prepareSpeechProfiles,
  alignToSpeechBoundaries as alignSilero,
} from './3.5_align_silero.js';
import { alignToSpeechBoundaries as alignEnergy } from './3.5_align_energy.js';
import { transcribeChunksToSegments, offsetSegment } from './3_transcribe.js';
import { filterHallucinations, saveFilterResults } from './3.1_filter_hallucinations.js';
import { mergeSegments } from './3.2_merge_sentences.js';
import { cleanSegments } from './3.7_clean_srt.js';
import { parseSrt, segmentsToSrt, addReview } from './lib/srt.js';
import { chunkSrtForTranslation } from './4_chunk_srt.js';
import { translateSrtFile } from './5_translate.js';
import { validateProviderSettings } from './providers/catalog.js';
import { needsAudioReview } from './lib/progress.js';
import { migratePreparedAudio, originalAudioSettings } from './lib/source-audio.js';
import { fullMovie, movieSettings } from './lib/transcription-mode.js';
import { prepareMovieAudio } from './lib/movie-audio.js';
import { speakerContext, subtitleHash } from './lib/speakers.js';
import { writeSubtitleArtifacts } from './lib/subtitle-export.js';
import { editorialSource, validateEditorialSource } from './lib/editorial-subtitles.js';
import { mediaTiming } from './lib/media-timing.js';
import { extractEmbeddedSubtitles } from './lib/embedded-subtitles.js';
import type { ExistingSubtitle } from './lib/embedded-subtitles.js';
import { assertPipelineProviders } from './lib/pipeline-readiness.js';
import type { EditorialSource } from '../types/editorial.js';

export function validateSettings(settings: Settings) {
  validateProviderSettings({ ...config, ...settings });
  if (!['fixed', 'editorial'].includes(settings.TRANSLATION_MODE ?? 'fixed'))
    throw new Error('Unknown subtitle translation mode');
  if (
    settings.TRANSLATION_SONG_REFERENCES !== undefined &&
    (typeof settings.TRANSLATION_SONG_REFERENCES !== 'string' ||
      settings.TRANSLATION_SONG_REFERENCES.length > 8000 ||
      /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(settings.TRANSLATION_SONG_REFERENCES))
  )
    throw new Error('Song reference notes must be text of at most 8,000 characters');
  if (!['codex-local'].includes(settings.TRANSLATION_PROVIDER))
    throw new Error('Unknown translation provider');
  if (
    typeof settings.CODEX_MODEL !== 'string' ||
    (settings.CODEX_MODEL && !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(settings.CODEX_MODEL))
  )
    throw new Error('Invalid Codex model');
  for (const key of [
    'CHUNK_MIN_DURATION',
    'CHUNK_TARGET_DURATION',
    'CHUNK_MAX_DURATION',
    'SRT_CHUNK_SIZE',
    'SUBTITLE_MAX_DURATION_SEC',
    'SUBTITLE_MAX_CHARS',
    'MAX_INPUT_DURATION_SEC',
    'MAX_UPLOAD_BYTES',
    'MAX_TEMP_BYTES',
    'MIN_FREE_DISK_BYTES',
    'MAX_QUEUED_JOBS',
    'MEDIA_TIMEOUT_MS',
    'TRANSCRIPTION_TIMEOUT_MS',
    'WORKER_START_TIMEOUT_MS',
    'TRANSLATION_RETRY_ATTEMPTS',
    'CODEX_TRANSLATION_TIMEOUT_MS',
  ]) {
    if (
      !Number.isFinite(settings[key as keyof Settings]) ||
      Number(settings[key as keyof Settings]) <= 0
    )
      throw new Error(`Invalid setting: ${key}`);
  }
  if (
    !Number.isInteger(settings.SRT_CHUNK_SIZE) ||
    settings.CHUNK_MIN_DURATION > settings.CHUNK_TARGET_DURATION ||
    settings.CHUNK_TARGET_DURATION > settings.CHUNK_MAX_DURATION
  )
    throw new Error('Invalid chunk configuration');
  if (!Number.isInteger(settings.AUDIO_STREAM_INDEX) || settings.AUDIO_STREAM_INDEX < 0)
    throw new Error('Invalid audio stream index');
  if (!Number.isInteger(settings.MAX_QUEUED_JOBS) || settings.MAX_QUEUED_JOBS > 1000)
    throw new Error('MAX_QUEUED_JOBS must be an integer between 1 and 1000');
  if (!['native', 'energy', 'silero'].includes(settings.ALIGNMENT_METHOD))
    throw new Error('Unknown alignment method');
  if (
    !fullMovie(settings) &&
    !settings.LOCAL_AUDIO_ENABLED &&
    (settings.SILERO_VAD_ENABLED ||
      (settings.ALIGN_TO_SPEECH && settings.ALIGNMENT_METHOD === 'silero'))
  )
    throw new Error(
      'Local speech models are not installed; choose provider timestamps or energy alignment',
    );
  if (
    !/^(auto|[a-z]{2,3})$/.test(settings.DEFAULT_LANGUAGE) ||
    !/^[a-z]{2,3}$/.test(settings.TARGET_LANGUAGE)
  )
    throw new Error('Invalid language code');
}

export async function postprocessRecords(
  records: any,
  manifest: any,
  options: PipelineOptions = {},
) {
  const settings = manifest.settings;
  const kept = [],
    dropped = [],
    all = [];
  const nativeSegments: Segment[] = [];
  for (let index = 0; index < records.length; index++) {
    checkAbort(options.signal);
    const { chunk, segments } = records[index];
    const duration = chunk.endTime - chunk.startTime;
    let processed = segments.map((segment: Segment) => ({
      ...segment,
      review: [...new Set([...(segment.review ?? []), ...(chunk._review ?? [])])],
    }));
    if (settings.FILTER_HALLUCINATIONS) {
      // Local cue times, matching audio chunk. Original film offset is added last.
      const filtered = await filterHallucinations(chunk.file, processed, {
        signal: options.signal,
        settings,
        dropThreshold: settings.HALLUCINATION_DROP_THRESHOLD,
        markThreshold: settings.HALLUCINATION_MARK_THRESHOLD,
      });
      processed = filtered.kept;
      kept.push(...filtered.kept.map((segment) => offsetSegment(segment, chunk.startTime)));
      dropped.push(...filtered.dropped.map((segment) => offsetSegment(segment, chunk.startTime)));
    }
    nativeSegments.push(
      ...processed.map((segment: Segment) => offsetSegment(segment, chunk.startTime)),
    );
    // Source export stays compatible; translation can independently regroup native words.
    processed = mergeSegments(processed, { settings });
    await options.onStage?.({
      id: 'filtering',
      completed: index + 1,
      total: records.length,
      unit: 'chunks',
      detail: `Filtered and split ${index + 1}/${records.length} chunks`,
    });
    if (settings.ALIGN_TO_SPEECH) {
      const align = settings.ALIGNMENT_METHOD === 'silero' ? alignSilero : alignEnergy;
      processed = await align(chunk.file, processed, {
        signal: options.signal,
        duration,
        settings,
        profileFile: chunk.profileFile,
        threshold: settings.SILERO_VAD_THRESHOLD,
        noiseThreshold: settings.SILENCE_THRESHOLD_DB,
        minSilence: settings.MIN_SILENCE_DURATION,
        maxShift: settings.ALIGNMENT_MAX_SHIFT_SEC,
        padding: settings.ALIGNMENT_PADDING_SEC,
      });
      await options.onStage?.({
        id: 'alignment',
        completed: index + 1,
        total: records.length,
        unit: 'chunks',
        detail: `Aligned ${index + 1}/${records.length} chunks`,
      });
    }
    all.push(...processed.map((segment: Segment) => offsetSegment(segment, chunk.startTime)));
    await options.onProgress?.(index + 1, records.length);
  }
  if (settings.FILTER_HALLUCINATIONS)
    await saveFilterResults(manifest.id, kept, dropped, {
      kept: kept.length,
      dropped: dropped.length,
      suspicious: kept.filter((s) => s._suspicious).length,
    });
  const result = cleanSegments(all, { settings }).map((segment: Segment, index: number) => ({
    ...segment,
    id: String(index + 1),
  }));
  await writeJson(at('output', 'reviews', `${manifest.id}-anchors.json`), {
    segments: nativeSegments,
    audioEvents: records.flatMap(({ chunk, audioEvents = [] }: any) =>
      audioEvents.map((event: any) => ({
        ...event,
        start: event.start + chunk.startTime,
        end: event.end + chunk.startTime,
      })),
    ),
  });
  await writeJson(at('output', 'reviews', `${manifest.id}.json`), {
    version: 1,
    jobId: manifest.id,
    title: manifest.title,
    sourceAudio: manifest.input,
    method: settings.ALIGNMENT_METHOD,
    segments: result,
    dropped,
    vadDiscarded: manifest.vadDiscarded ?? [],
    warnings: manifest.warnings ?? [],
    runtimes: records.map(({ chunk, runtime }: Record<string, any>) => ({
      chunkId: chunk.id,
      runtime,
    })),
    chunkMap: manifest.chunks.map(
      ({ id, startTime, endTime, file, _original_file }: Record<string, any>) => ({
        id,
        startTime,
        endTime,
        file,
        originalFile: _original_file,
      }),
    ),
  });
  return result;
}

function publicFile(file: string) {
  return `/${path.relative(DATA_ROOT, file).split(path.sep).map(encodeURIComponent).join('/')}`;
}

async function reuseSubtitles(manifest: any, existing: ExistingSubtitle | null, options: any) {
  if (existing) {
    const { content, ...origin } = existing;
    const file = at(
      'found',
      `${titleSlug(manifest.title)}_${manifest.id}_${existing.source}_${existing.language}.srt`,
    );
    await atomicWrite(file, content);
    manifest.existingSource = existing.source;
    manifest.existingSubtitles = { ...origin, file, hash: subtitleHash(content) };
    manifest.lookedUp = true;
    // Existing subtitle tracks already have editorial timing. Translate their text exactly in place.
    manifest.settings.TRANSLATION_MODE = 'fixed';
    await writeJson(at('temp', manifest.id, 'manifest.json'), manifest);
  }
  const saved = manifest.existingSubtitles;
  const content = await fs.readFile(saved.file, 'utf8');
  if (subtitleHash(content) !== saved.hash)
    throw new Error('Saved existing subtitles changed; restore the saved track or start a new job');
  await options.onStage?.({
    id: 'subtitles',
    status: 'completed',
    detail: `Using ${saved.language} subtitles from ${saved.source}${saved.streamIndex !== undefined ? ` track ${saved.streamIndex}` : ''}; transcription is unnecessary`,
  });
  for (const stage of [
    'download',
    'chunking',
    'demucs',
    'vad',
    'transcription',
    'filtering',
    'alignment',
  ] as const)
    await options.onStage?.({
      id: stage,
      status: 'skipped',
      detail: 'Reusing existing subtitles; no audio processing needed',
    });
  return finalize(manifest, content, saved.language, options);
}

async function finalize(manifest: any, srt: string, sourceLanguage: string, options: any) {
  const { settings, id, title } = manifest;
  await options.onStage?.({
    id: 'export',
    status: 'running',
    percentage: null,
    detail: 'Saving source subtitles and reports',
  });
  const stem = `${titleSlug(title)}_${id}`;
  const subtitleFile = at('output', 'subtitles', `${stem}_${sourceLanguage}.srt`);
  const styled = await writeSubtitleArtifacts(
    subtitleFile,
    srt,
    sourceLanguage,
    at('output', 'reviews', `${id}-source-style.json`),
  );
  srt = styled.srt;
  if (manifest.existingSource) await atomicWrite(at('found', `${stem}_${sourceLanguage}.srt`), srt);
  await options.onStage?.({ id: 'export', status: 'completed', detail: 'Source SRT saved' });
  const result: PipelineResult = {
    subtitleFile: publicFile(subtitleFile),
    subtitleAssFile: publicFile(styled.assFile),
    subtitleStyleReviewFile: publicFile(styled.reviewFile),
    sourceLanguage,
    targetLanguage: settings.TARGET_LANGUAGE,
    reviewFile: manifest.chunks ? `/output/reviews/${id}.json` : null,
    usageFile: manifest.chunks ? `/output/raw_transcriptions/${id}/usage.json` : null,
  };
  if (manifest.embeddedSubtitleReportFile)
    result.embeddedSubtitleReportFile = manifest.embeddedSubtitleReportFile;
  if (manifest.existingSubtitles) {
    const { file, hash, ...origin } = manifest.existingSubtitles;
    result.existingSubtitleFile = publicFile(file);
    result.subtitleOrigin = origin;
  }
  if (options.speakers) {
    const file = at('output', 'reviews', `${id}-speakers.json`);
    await writeJson(file, { ...options.speakers, sourceHash: subtitleHash(srt) });
    result.speakerFile = publicFile(file);
  }
  const evidenceFile = at('output', 'reviews', `${id}-editorial-source.json`);
  let evidence = await readJson<EditorialSource | null>(evidenceFile, null);
  if (evidence) validateEditorialSource(srt, evidence);
  else {
    const native = await readJson(at('output', 'reviews', `${id}-anchors.json`), null);
    evidence = editorialSource(srt, native?.segments, native?.audioEvents);
    if (
      manifest.input &&
      settings.TRANSLATION_ENABLED &&
      sourceLanguage !== settings.TARGET_LANGUAGE &&
      settings.TRANSLATION_MODE === 'editorial'
    ) {
      try {
        Object.assign(evidence, await mediaTiming(manifest.input, options));
      } catch (error) {
        checkAbort(options.signal);
        await options.onWarning?.(
          'Media timing metadata unavailable; source audio timing is retained for review.',
        );
      }
    }
    await writeJson(evidenceFile, evidence);
  }
  result.editorialSourceFile = publicFile(evidenceFile);
  if (sourceLanguage === settings.TARGET_LANGUAGE) {
    result.englishSubtitleFile = publicFile(subtitleFile);
    result.translatedAssFile = publicFile(styled.assFile);
    result.translationStyleReviewFile = publicFile(styled.reviewFile);
    await options.onStage?.({
      id: 'translation',
      status: 'skipped',
      detail: 'Subtitles already use the target language',
    });
  } else {
    if (settings.EXPORT_TRANSLATION_CHUNKS) {
      const chunks = await chunkSrtForTranslation(
        srt,
        at('output', 'translation_chunks', stem),
        stem,
        { settings, sourceLanguage, targetLanguage: settings.TARGET_LANGUAGE },
      );
      result.translationChunks = {
        dir: publicFile(chunks.dir),
        jsonFiles: chunks.jsonFiles.map(publicFile),
        srtFiles: chunks.srtFiles.map(publicFile),
      };
    }
    // Publish partial source progress before optional translation; failure remains retryable.
    manifest.partialResult = result;
    await writeJson(at('temp', id, 'manifest.json'), manifest);
    if (settings.TRANSLATION_ENABLED) {
      await options.onStage?.({
        id: 'translation',
        percentage: null,
        detail: 'Starting subtitle translation',
      });
      const translated = at('output', 'subtitles', `${stem}_${settings.TARGET_LANGUAGE}.srt`);
      const translation = await translateSrtFile(
        subtitleFile,
        translated,
        {
          title,
          sourceLanguage,
          targetLanguage: settings.TARGET_LANGUAGE,
          ...(options.speakers ? { speakers: options.speakers } : {}),
          ...(settings.TRANSLATION_MODE === 'editorial' ? { editorial: evidence } : {}),
          ...(settings.TRANSLATION_SONG_REFERENCES
            ? { songReferences: settings.TRANSLATION_SONG_REFERENCES }
            : {}),
        },
        async (pct, message) => {
          await options.progress(85 + pct * 0.14, message);
          await options.onStage?.({
            id: 'translation',
            percentage: settings.TRANSLATION_PROVIDER === 'codex-local' && pct < 100 ? null : pct,
            detail: message,
          });
        },
        {
          settings,
          signal: options.signal,
          onStage: options.onStage,
          checkpoint: at('temp', id, 'translation-checkpoint.json'),
          workDir: at('temp', id, 'codex'),
          receiptDir: at('data', 'translation-receipts', id),
          retryCodex: options.retryCodex,
        },
      );
      result.englishSubtitleFile = publicFile(translated);
      if (translation.reviewSourceFile && translation.reviewTargetFile) {
        result.reviewSourceFile = publicFile(translation.reviewSourceFile);
        result.reviewTargetFile = publicFile(translation.reviewTargetFile);
      }
      const translatedStyle = await writeSubtitleArtifacts(
        translated,
        await fs.readFile(translated, 'utf8'),
        settings.TARGET_LANGUAGE,
        at('output', 'reviews', `${id}-target-style.json`),
      );
      result.translatedAssFile = publicFile(translatedStyle.assFile);
      result.translationStyleReviewFile = publicFile(translatedStyle.reviewFile);
      if ('report' in translation) {
        const reportFile = at('output', 'reviews', `${id}-translation.json`);
        await writeJson(reportFile, translation.report);
        Object.assign(result, { translationReviewFile: publicFile(reportFile) });
      }
      await options.onStage?.({
        id: 'translation',
        status: 'completed',
        detail: 'Translation saved and cue timing checked',
      });
    }
  }
  manifest.stage = 'completed';
  manifest.result = result;
  await writeJson(at('temp', id, 'manifest.json'), manifest);
  await options.progress(100, 'Subtitles ready; review report includes timing and filter flags.');
  return result;
}

export async function runPipeline(job: any, options: PipelineOptions = {}) {
  const id = validateId(job.id);
  if (job.type === 'translation') {
    const settings = {
      ...config,
      ...job.settings,
      CODEX_BIN: config.CODEX_BIN,
      CODEX_TRANSLATION_TIMEOUT_MS: config.CODEX_TRANSLATION_TIMEOUT_MS,
      TRANSLATION_MODE: job.settings?.TRANSLATION_MODE ?? 'fixed',
    };
    validateSettings(settings);
    const workDir = at('temp', id);
    const speakers =
      job.speakers ??
      (job.speakerContextFile ? await readJson(job.speakerContextFile, null) : null);
    const evidence =
      settings.TRANSLATION_MODE === 'editorial'
        ? job.editorialContextFile
          ? await readJson<EditorialSource>(job.editorialContextFile)
          : editorialSource(await fs.readFile(job.input, 'utf8'))
        : null;
    const outputPath = at(
      'output',
      'subtitles',
      `${titleSlug(job.title)}_${id}_${settings.TARGET_LANGUAGE}.srt`,
    );
    const result = await translateSrtFile(
      job.input,
      outputPath,
      {
        title: job.title,
        sourceLanguage: settings.DEFAULT_LANGUAGE,
        targetLanguage: settings.TARGET_LANGUAGE,
        ...(speakers ? { speakers } : {}),
        ...(evidence ? { editorial: evidence } : {}),
        ...(settings.TRANSLATION_SONG_REFERENCES
          ? { songReferences: settings.TRANSLATION_SONG_REFERENCES }
          : {}),
      },
      async (pct, message) => {
        await options.progress?.(pct, message);
        await options.onStage?.({
          id: 'translation',
          percentage: settings.TRANSLATION_PROVIDER === 'codex-local' && pct < 100 ? null : pct,
          detail: message,
        });
      },
      {
        ...options,
        settings,
        workDir,
        checkpoint: path.join(workDir, 'translation-checkpoint.json'),
        receiptDir: at('data', 'translation-receipts', id),
        retryCodex: job.codexRetry,
      },
    );
    const reportFile = at('output', 'reviews', `${id}-translation.json`);
    if ('report' in result) await writeJson(reportFile, result.report);
    const styled = await writeSubtitleArtifacts(
      outputPath,
      await fs.readFile(outputPath, 'utf8'),
      settings.TARGET_LANGUAGE,
      at('output', 'reviews', `${id}-target-style.json`),
    );
    await options.onStage?.({
      id: 'translation',
      status: 'completed',
      detail: 'Translation saved and cue timing checked',
    });
    return {
      subtitleFile: job.sourceSubtitleFile,
      englishSubtitleFile: publicFile(outputPath),
      translatedAssFile: publicFile(styled.assFile),
      translationStyleReviewFile: publicFile(styled.reviewFile),
      sourceLanguage: settings.DEFAULT_LANGUAGE,
      targetLanguage: settings.TARGET_LANGUAGE,
      translationReviewFile: 'report' in result ? publicFile(reportFile) : null,
      ...(result.reviewSourceFile && result.reviewTargetFile
        ? {
            reviewSourceFile: publicFile(result.reviewSourceFile),
            reviewTargetFile: publicFile(result.reviewTargetFile),
          }
        : {}),
    };
  }
  const workDir = at('temp', id),
    manifestFile = path.join(workDir, 'manifest.json');
  const progress = async (pct: number, message: string) => {
    checkAbort(options.signal);
    await options.progress?.(pct, message);
  };
  let manifest = (await migratePreparedAudio(id)) ?? (await readJson(manifestFile, null));
  if (!manifest) {
    const settings = movieSettings({
      ...config,
      ...(job.settings?.DEMUCS_ENABLED ? originalAudioSettings(job.settings) : job.settings),
      DEFAULT_LANGUAGE:
        job.sourceLanguage ?? job.settings?.DEFAULT_LANGUAGE ?? config.DEFAULT_LANGUAGE,
      TARGET_LANGUAGE:
        job.targetLanguage ?? job.settings?.TARGET_LANGUAGE ?? config.TARGET_LANGUAGE,
      DEMUCS_ENABLED: false,
    });
    validateSettings(settings);
    manifest = {
      version: 1,
      pathSchema: 1,
      id,
      title: job.title || 'Movie',
      type: job.type,
      youtubeUrl: job.youtubeUrl,
      imdbId: job.imdbId,
      input: job.input,
      sourceStat: job.sourceStat,
      settings,
      audioInput: 'original',
      stage: 'new',
      warnings: [],
    };
    await writeJson(manifestFile, manifest);
  }
  if (manifest.version !== 1 || manifest.id !== id) throw new Error('Invalid recovery manifest');
  manifest.settings = movieSettings({
    ...config,
    ...manifest.settings,
    PORTABLE_PATHS: manifest.pathSchema === 1,
    TRANSCRIPTION_MODE: manifest.settings.TRANSCRIPTION_MODE ?? 'chunks',
    TRANSCRIPTION_DIARIZATION: manifest.settings.TRANSCRIPTION_DIARIZATION ?? false,
    TRANSCRIPTION_AUDIO_EVENTS: manifest.settings.TRANSCRIPTION_AUDIO_EVENTS ?? false,
    TRANSLATION_MODE: manifest.settings.TRANSLATION_MODE ?? 'fixed',
  });
  // Operational limits may be raised for a retry without changing transcript
  // identity. Models, languages and signal-processing choices remain frozen.
  for (const key of [
    'MAX_TEMP_BYTES',
    'MIN_FREE_DISK_BYTES',
    'MEDIA_TIMEOUT_MS',
    'TRANSCRIPTION_TIMEOUT_MS',
    'WORKER_START_TIMEOUT_MS',
    'TRANSLATION_TIMEOUT_MS',
    'CODEX_TRANSLATION_TIMEOUT_MS',
    'MOVIE_TRANSCRIPTION_TIMEOUT_MS',
    'MAX_MOVIE_AUDIO_BYTES',
  ]) {
    manifest.settings[key as keyof Settings] = config[key as keyof Settings];
  }
  const settings = manifest.settings;
  const movie = fullMovie(settings);
  settings.CODEX_BIN = config.CODEX_BIN;
  validateSettings(settings);
  const warning = async (message: string) => {
    manifest.warnings.push(message);
    await options.onWarning?.(message);
  };
  const common = {
    settings,
    workDir,
    signal: options.signal,
    onWarning: warning,
    progress,
    onLog: (message: string) => process.stderr.write(message),
    onStage: options.onStage,
    retryCodex: job.codexRetry,
  };
  if (manifest.stage === 'completed') return manifest.result;
  if (!manifest.chunks) {
    if (manifest.existingSubtitles) return reuseSubtitles(manifest, null, common);
    if (!manifest.lookedUp) {
      await progress(5, 'Checking embedded and online subtitles before transcription');
      await options.onStage?.({
        id: 'subtitles',
        percentage: null,
        detail: 'Checking embedded and online subtitle tracks',
      });
      let existing;
      if (manifest.type === 'video') {
        try {
          const embedded = await extractEmbeddedSubtitles(manifest.input, {
            ...common,
            sourceLanguage: settings.DEFAULT_LANGUAGE,
            targetLanguage: settings.TARGET_LANGUAGE,
            sourceStat: manifest.sourceStat,
          });
          manifest.sourceStat ??= embedded.sourceStat;
          const reportFile = at('output', 'reviews', `${id}-embedded-subtitles.json`);
          await writeJson(reportFile, embedded.report);
          manifest.embeddedSubtitleReportFile = publicFile(reportFile);
          existing = embedded.subtitle;
        } catch (error) {
          checkAbort(options.signal);
          if (error.code === 'SOURCE_CHANGED') throw error;
          await warning(`Embedded subtitle check failed: ${error.message}`);
        }
      }
      if (!existing)
        existing = await checkExistingSubtitles(manifest.youtubeUrl, manifest.imdbId, {
          ...common,
          targetLanguage: settings.TARGET_LANGUAGE,
          input: manifest.type === 'video' ? manifest.input : null,
        });
      if (existing && 'referenceOnly' in existing && existing.referenceOnly) {
        const reference = at('found', `${titleSlug(manifest.title)}_${id}_reference.srt`);
        await atomicWrite(reference, existing.content);
        await warning(
          'An IMDb-only subtitle match was saved as a reference. Transcribing this film to preserve its timing.',
        );
        existing = null;
      }
      if (existing) return reuseSubtitles(manifest, existing, common);
      manifest.lookedUp = true;
      await writeJson(manifestFile, manifest);
    }
    await options.onStage?.({
      id: 'subtitles',
      status: 'completed',
      detail: 'Subtitle search completed',
    });
    await assertPipelineProviders(settings);
    if (!manifest.input) {
      await progress(8, 'Downloading source audio');
      await options.onStage?.({
        id: 'download',
        percentage: null,
        detail: 'Checking YouTube audio availability',
      });
      manifest.input = await withTempBudget(
        settings.MAX_UPLOAD_BYTES,
        () =>
          downloadVideo(manifest.youtubeUrl, id, {
            ...common,
            includeVideo: settings.PREPARE_REVIEW,
          }),
        settings,
      );
      await writeJson(manifestFile, manifest);
    }
    if (manifest.type === 'youtube')
      await options.onStage?.({
        id: 'download',
        status: 'completed',
        detail: 'Source audio available',
      });
    await options.onStage?.({
      id: 'chunking',
      percentage: null,
      detail: movie
        ? 'Preparing continuous movie audio'
        : 'Inspecting audio and finding cut points',
    });
    const input = await validateSourceMedia(manifest.input, id, common);
    const stat = await fs.stat(input);
    if (
      manifest.sourceStat &&
      (manifest.sourceStat.size !== stat.size || manifest.sourceStat.mtimeMs !== stat.mtimeMs)
    ) {
      throw new Error('Source file changed since this job started; create a new job');
    }
    manifest.sourceStat = { size: stat.size, mtimeMs: stat.mtimeMs };
    await writeJson(manifestFile, manifest);
    await progress(
      12,
      movie
        ? 'Preparing continuous audio for full-movie Scribe'
        : 'Cutting lossless chunks while preserving film offsets',
    );
    const info = await probe(input, { signal: options.signal });
    const audio = info.streams.filter((stream: any) => stream.codec_type === 'audio')[
      settings.AUDIO_STREAM_INDEX
    ];
    if (!audio) throw new Error('Configured audio stream does not exist');
    const pcmBytes = manifest.originalChunks
      ? 0
      : movie
        ? info.duration * 32000
        : info.duration *
          4 *
          Math.min(Number(audio.sample_rate) || 48000, 48000) *
          Math.min(audio.channels || 2, 2);
    manifest.chunks = await withTempBudget(
      Math.ceil(pcmBytes * 1.02 + 32 * 1024 * 1024),
      async () => {
        const chunks =
          manifest.originalChunks ??
          (movie
            ? await prepareMovieAudio(input, workDir, common)
            : await chunkAudio(input, id, {
                ...common,
                onProgress: async (done, total) =>
                  options.onStage?.({
                    id: 'chunking',
                    completed: done,
                    total,
                    unit: 'chunks',
                    detail: `Saved ${done}/${total} lossless chunks`,
                  }),
              }));
        const currentSource = await fs.stat(input);
        if (
          currentSource.size !== manifest.sourceStat.size ||
          currentSource.mtimeMs !== manifest.sourceStat.mtimeMs
        ) {
          throw new Error(
            'Source changed while cutting chunks; submit the stable file as a new job',
          );
        }
        for (const chunk of chunks) {
          const stat = await fs.stat(chunk.file);
          chunk.audioStat = { size: stat.size, mtimeMs: stat.mtimeMs };
        }
        manifest.originalChunks = chunks;
        await writeJson(manifestFile, manifest);
        await options.onStage?.({
          id: 'chunking',
          status: 'completed',
          completed: chunks.length,
          total: chunks.length,
          unit: movie ? 'movie' : 'chunks',
          detail: movie ? 'Continuous movie audio ready' : 'Lossless source chunks available',
        });
        await progress(
          18,
          movie
            ? 'Complete movie audio ready for transcription'
            : 'Original audio chunks ready for transcription',
        );
        return chunks;
      },
      settings,
    );
    manifest.audioInput = 'original';
    manifest.stage = 'prepared';
    await writeJson(manifestFile, manifest);
  } else {
    await options.onStage?.({
      id: 'subtitles',
      status: 'completed',
      detail: 'Restored from saved job',
    });
    if (manifest.type === 'youtube')
      await options.onStage?.({
        id: 'download',
        status: 'completed',
        detail: 'Using downloaded source audio',
      });
    const total = manifest.originalChunks?.length ?? manifest.chunks.length;
    await options.onStage?.({
      id: 'chunking',
      status: 'completed',
      completed: total,
      total,
      unit: 'chunks',
      detail: 'Using saved lossless chunks',
    });
    if (settings.DEMUCS_ENABLED)
      await options.onStage?.({
        id: 'demucs',
        status: 'completed',
        completed: total,
        total,
        unit: 'chunks',
        detail: 'Using saved vocal chunks',
      });
  }
  if (needsAudioReview(manifest, options.resume)) {
    manifest.stage = 'paused';
    manifest.pausedAt = new Date().toISOString();
    await writeJson(manifestFile, manifest);
    await progress(25, 'Paused for audio review. Audio chunks are ready; ASR has not started.');
    return { paused: true, jobId: id, chunkCount: manifest.chunks.length };
  }
  if (new Set(manifest.chunks.map((chunk: Chunk) => chunk.id)).size !== manifest.chunks.length)
    throw new Error('Duplicate chunk IDs in manifest');
  for (const chunk of manifest.chunks) {
    if (!Number.isInteger(chunk.id) || chunk.id < 0)
      throw new Error('Invalid chunk ID in manifest');
    if (
      !Number.isFinite(chunk.startTime) ||
      !Number.isFinite(chunk.endTime) ||
      chunk.endTime <= chunk.startTime
    )
      throw new Error('Chunk manifest is missing film offsets');
    const stat = await fs.stat(chunk.file);
    if (
      !chunk.audioStat ||
      chunk.audioStat.size !== stat.size ||
      chunk.audioStat.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error(
        `Chunk ${chunk.id} changed since preparation; start a new job or restore its saved audio`,
      );
    }
  }
  if (
    !manifest.profilesPrepared &&
    (settings.SILERO_VAD_ENABLED ||
      (settings.ALIGN_TO_SPEECH && settings.ALIGNMENT_METHOD === 'silero'))
  ) {
    await progress(25, 'Profiling speech in the transcription audio');
    await options.onStage?.({
      id: 'vad',
      completed: 0,
      total: manifest.chunks.length,
      unit: 'chunks',
      detail: 'Loading Silero and measuring speech in the audio chunks',
    });
    const profileBudget = Math.ceil(
      manifest.chunks.reduce((sum: any, chunk: Chunk) => sum + chunk.endTime - chunk.startTime, 0) *
        3000 +
        1024 * 1024,
    );
    const success = await withTempBudget(
      profileBudget,
      () => prepareSpeechProfiles(manifest.chunks, workDir, common),
      settings,
    );
    if (success)
      manifest.chunks = manifest.chunks.map((chunk: Chunk) => ({
        ...chunk,
        profileFile: path.join(workDir, `profile_${chunk.id}.json`),
      }));
    manifest.profilesPrepared = success;
    const filtered = await filterWithSileroVAD(manifest.chunks, id, common);
    manifest.chunks = filtered.kept;
    manifest.vadDiscarded = filtered.discarded;
    manifest.stage = 'ready';
    await writeJson(manifestFile, manifest);
    await options.onStage?.({
      id: 'vad',
      status: success ? 'completed' : 'skipped',
      detail: success ? 'Speech profiles saved' : 'Silero unavailable; using energy fallback',
    });
  } else if (manifest.profilesPrepared) {
    await options.onStage?.({
      id: 'vad',
      status: 'completed',
      detail: 'Using saved speech profiles',
    });
  }
  await progress(
    30,
    movie ? 'Transcribing the complete movie with ElevenLabs' : 'Transcribing the audio chunks',
  );
  await options.onStage?.({
    id: 'transcription',
    completed: 0,
    total: manifest.chunks.length,
    unit: movie ? 'movie' : 'chunks',
    ...(movie ? { percentage: null } : {}),
    detail: 'Preparing the selected ASR model',
  });
  const records = await transcribeChunksToSegments(
    manifest.chunks,
    settings.DEFAULT_LANGUAGE,
    id,
    { title: manifest.title },
    {
      ...common,
      returnChunks: true,
      onProgress: async (done, total) => {
        await progress(
          30 + (done / total) * 30,
          movie ? 'Full-movie transcription received' : `Transcribed ${done}/${total} chunks`,
        );
        await options.onStage?.({
          id: 'transcription',
          completed: done,
          total,
          unit: movie ? 'movie' : 'chunks',
          detail: movie
            ? 'Full-movie transcription received'
            : `Transcribed ${done}/${total} chunks`,
        });
      },
    },
  );
  await options.onStage?.({
    id: 'transcription',
    status: 'completed',
    detail: 'All ASR responses saved',
  });
  await options.onStage?.({
    id: 'filtering',
    completed: 0,
    total: records.length,
    unit: 'chunks',
    detail: 'Checking cues against the transcription audio',
  });
  if (settings.ALIGN_TO_SPEECH)
    await options.onStage?.({
      id: 'alignment',
      completed: 0,
      total: records.length,
      unit: 'chunks',
      detail: 'Aligning cue boundaries',
    });
  await progress(60, 'Filtering, splitting and aligning cues against their audio chunks');
  const segments = await postprocessRecords(records, manifest, {
    ...common,
    onProgress: async (done, total) =>
      progress(60 + (done / total) * 20, `Aligned ${done}/${total} chunks`),
  });
  await options.onStage?.({
    id: 'filtering',
    status: 'completed',
    detail: 'Cue filtering and splitting finished',
  });
  if (settings.ALIGN_TO_SPEECH)
    await options.onStage?.({
      id: 'alignment',
      status: 'completed',
      detail: 'Cue alignment finished',
    });
  if (!segments.length)
    throw new Error('No subtitle cues survived; inspect raw transcriptions and filter report');
  const names: Record<string, string> = {
    turkish: 'tr',
    english: 'en',
    ukrainian: 'uk',
    russian: 'ru',
    german: 'de',
    french: 'fr',
    spanish: 'es',
  };
  const languages = [
    ...new Set(
      records.map((record) => {
        const value = String(record.language ?? '').toLowerCase();
        return names[value] ?? (/^[a-z]{2,3}$/.test(value) ? value : 'und');
      }),
    ),
  ];
  const sourceLanguage =
    settings.DEFAULT_LANGUAGE === 'auto'
      ? languages.length === 1
        ? languages[0]
        : languages.length
          ? 'mul'
          : 'und'
      : settings.DEFAULT_LANGUAGE;
  return finalize(manifest, segmentsToSrt(segments), sourceLanguage, {
    ...common,
    speakers: speakerContext(segments),
  });
}
