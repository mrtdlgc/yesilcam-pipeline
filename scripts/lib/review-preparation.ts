import type { Manifest } from '../../types/checkpoints.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Job, PipelineOptions } from '../../types/pipeline.js';
import { config } from '../../config.js';
import { at, contained, persistentPath, jobId, readJson, serialized, writeJson } from './files.js';
import { probe, run, checkAbort } from './process.js';
import { withTempBudget } from './storage.js';
import { subtitleHash } from './speakers.js';
import { createSubtitleReview, readSubtitleReview } from './subtitle-review.js';
import { downloadVideo } from '../1_download_video.js';

async function outputFile(url: string) {
  if (typeof url !== 'string' || !url.startsWith('/output/'))
    throw new Error('Invalid subtitle artifact');
  return contained(
    at('output'),
    ...url.slice('/output/'.length).split('/').map(decodeURIComponent),
  );
}
export function screeningLinks(id: string, languages: string[], target: string) {
  const language = languages.includes(target) ? target : languages[0];
  const base = `/api/reviews/${jobId(id)}/subtitles/`;
  return {
    reviewUrl: `/review-player.html?job=${id}`,
    reviewStatus: 'ready',
    reviewError: null,
    currentSubtitleFile: `${base}${language}.srt`,
    currentAssFile: `${base}${language}.ass`,
    reviewLanguages: languages,
  };
}

export async function prepareReviewMedia(input: string, id: string, options: PipelineOptions = {}) {
  const settings = { ...config, ...options.settings };
  const root = at('review-sessions');
  await fs.mkdir(root, { recursive: true });
  const dir = await contained(root, jobId(id));
  await fs.mkdir(dir, { recursive: true });
  const before = await fs.stat(input);
  const cacheRoot = at('data', 'subtitle-review-media');
  await fs.mkdir(cacheRoot, { recursive: true });
  const cacheFile = await contained(cacheRoot, `${id}.json`);
  const identity = subtitleHash(
    JSON.stringify([
      persistentPath(input),
      before.size,
      before.mtimeMs,
      settings.AUDIO_STREAM_INDEX,
    ]),
  );
  const cached = await readJson(cacheFile, null);
  if (cached?.identity === identity) {
    const saved = await contained(dir, cached.file);
    if ((await fs.stat(saved).catch(() => null))?.size === cached.bytes)
      return { media: cached.file as string, duration: cached.duration as number };
  }
  const info = await probe(input, { signal: options.signal });
  if (info.duration > settings.MAX_INPUT_DURATION_SEC)
    throw new Error('Review media exceeds the duration limit');
  const video = info.streams.find(
    (stream: any) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
  );
  const audio = info.streams.filter((stream: any) => stream.codec_type === 'audio')[
    settings.AUDIO_STREAM_INDEX
  ];
  if (!audio) throw new Error('Review audio stream is missing');
  const webm =
    video &&
    ['vp8', 'vp9'].includes(video.codec_name) &&
    ['yuv420p', 'yuv420p10le'].includes(video.pix_fmt);
  const copyVideo = video && (webm || (video.codec_name === 'h264' && video.pix_fmt === 'yuv420p'));
  const extension = webm ? 'webm' : 'mp4';
  const name = `screening.${extension}`;
  const output = await contained(dir, name);
  const staging = path.join(dir, `.screening.partial.${extension}`);
  const reserve = Math.min(
    settings.MAX_UPLOAD_BYTES,
    Math.ceil(before.size + info.duration * (copyVideo ? 20000 : 250000) + 8 * 1024 * 1024),
  );
  let buffer = '',
    lastProgress = 0;
  let updates = Promise.resolve();
  await options.onStage?.({
    id: 'review',
    status: 'running',
    percentage: 0,
    detail: video
      ? copyVideo
        ? 'Preparing watchable film without re-encoding video'
        : 'Preparing a 480p screening copy with two CPU threads'
      : 'Preparing audio for subtitle review',
  });
  return withTempBudget(
    reserve,
    async () => {
      try {
        await fs.rm(staging, { force: true });
        const args: (string | number)[] = [
          '-nostdin',
          '-y',
          '-v',
          'error',
          '-threads',
          '2',
          '-filter_threads',
          '2',
          '-filter_complex_threads',
          '2',
          '-i',
          input,
        ];
        if (video) args.push('-map', `0:${video.index}`, '-c:v', copyVideo ? 'copy' : 'libx264');
        if (video && !copyVideo)
          args.push(
            '-vf',
            'scale=-2:min(480\\,ih),format=yuv420p',
            '-preset',
            'veryfast',
            '-crf',
            '24',
            '-threads',
            '2',
          );
        const copyAudio = webm
          ? ['opus', 'vorbis'].includes(audio.codec_name)
          : audio.codec_name === 'aac';
        args.push(
          '-map',
          `0:${audio.index}`,
          '-c:a',
          copyAudio ? 'copy' : webm ? 'libopus' : 'aac',
        );
        if (!copyAudio) args.push('-b:a', '128k', '-ac', '2');
        args.push('-map_metadata', '-1', '-sn');
        if (!webm) args.push('-movflags', '+faststart');
        args.push('-fs', settings.MAX_UPLOAD_BYTES, '-progress', 'pipe:1', '-nostats', staging);
        await run('ffmpeg', args, {
          signal: options.signal,
          timeout: Math.max(settings.MEDIA_TIMEOUT_MS, Math.ceil(info.duration * 3000 + 60000)),
          priority: 10,
          onStdout(chunk) {
            buffer += chunk.toString();
            let end: number;
            while ((end = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              if (!line.startsWith('out_time_us=')) continue;
              const seconds = Number(line.slice(12)) / 1e6;
              if (!Number.isFinite(seconds) || Date.now() - lastProgress < 2000) continue;
              lastProgress = Date.now();
              updates = updates.then(async () => {
                await options.onStage?.({
                  id: 'review',
                  percentage: Math.min(99, (seconds / info.duration) * 100),
                  detail: 'Preparing screening media',
                });
              });
              void updates.catch(() => {});
            }
          },
        });
        await updates;
        checkAbort(options.signal);
        const current = await fs.stat(input);
        if (current.size !== before.size || current.mtimeMs !== before.mtimeMs)
          throw new Error('Source changed while preparing review media');
        const prepared = await probe(staging, { signal: options.signal });
        const mappedDurations = [video, audio]
          .filter(Boolean)
          .map((stream) => Number(stream.duration))
          .filter((duration) => Number.isFinite(duration) && duration > 0);
        const expectedDuration = mappedDurations.length
          ? Math.max(...mappedDurations)
          : info.duration;
        if (Math.abs(prepared.duration - expectedDuration) > Math.max(1, expectedDuration * 0.001))
          throw new Error('Screening copy is incomplete or its duration changed');
        const stat = await fs.stat(staging);
        if (!stat.size || stat.size > settings.MAX_UPLOAD_BYTES)
          throw new Error('Screening copy exceeds its size limit');
        await fs.rename(staging, output);
        await writeJson(cacheFile, {
          identity,
          file: name,
          bytes: stat.size,
          duration: prepared.duration,
        });
        return { media: name, duration: prepared.duration };
      } finally {
        await fs.rm(staging, { force: true });
      }
    },
    settings,
  );
}

// Run after export, before temporary cleanup. A review retry has no path into ASR/Codex.
export async function prepareSubtitleReview(
  job: Job,
  result: any,
  options: PipelineOptions = {},
  sourceJob?: Job,
) {
  return serialized(`prepare-screening:${jobId(job.id)}`, async () => {
    const existing = await readSubtitleReview(job.id).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (
      existing?.localMedia ||
      existing?.media ||
      (existing && job.type === 'translation' && !sourceJob)
    )
      return screeningLinks(job.id, existing.languages, existing.targetLanguage);
    const settings = { ...config, ...job.settings };
    const manifest = await readJson<Manifest | null>(at('temp', job.id, 'manifest.json'), null);
    const source = await fs.readFile(
      result.reviewSourceFile
        ? await outputFile(result.reviewSourceFile)
        : result.subtitleFile
          ? await outputFile(result.subtitleFile)
          : job.input!,
      'utf8',
    );
    const target = result.reviewTargetFile
      ? await fs.readFile(await outputFile(result.reviewTargetFile), 'utf8')
      : result.englishSubtitleFile && result.englishSubtitleFile !== result.subtitleFile
        ? await fs.readFile(await outputFile(result.englishSubtitleFile), 'utf8')
        : undefined;
    const sourceLanguage =
      (result.sourceLanguage || settings.DEFAULT_LANGUAGE) === 'auto'
        ? 'und'
        : result.sourceLanguage || settings.DEFAULT_LANGUAGE;
    const targetLanguage = result.targetLanguage || settings.TARGET_LANGUAGE;
    const speakers: Record<string, string> = {};
    const speakerFile = result.speakerFile || sourceJob?.result?.speakerFile;
    if (speakerFile) {
      const context = await readJson(await outputFile(speakerFile));
      const scopes = new Set((context.cues ?? []).map((cue: any) => cue.scope));
      if (context.sourceHash === subtitleHash(source))
        for (const cue of context.cues ?? [])
          speakers[String(cue.cueId)] =
            scopes.size > 1 ? `${cue.scope} / ${cue.speaker}` : String(cue.speaker);
    }
    const warnings: Record<string, string[]> = {};
    const omissions: Record<string, boolean> = {};
    if (result.reviewFile && !result.reviewSourceFile) {
      const report = await readJson(await outputFile(result.reviewFile));
      for (const cue of report.segments ?? []) warnings[String(cue.id)] = cue.review ?? [];
    }
    if (result.reviewSourceFile || result.reviewTargetFile) {
      if (!result.reviewSourceFile || !result.reviewTargetFile || !result.translationReviewFile)
        throw new Error('Editorial review artifacts are incomplete');
      const report = await readJson(await outputFile(result.translationReviewFile));
      if (
        report.editorial?.reviewSourceHash !== subtitleHash(source) ||
        report.editorial?.reviewTargetHash !== subtitleHash(target!)
      )
        throw new Error('Editorial review no longer matches the saved translation');
      for (const cue of report.editorial.cues) {
        speakers[cue.id] = cue.speaker;
        warnings[cue.id] = cue.warnings;
        omissions[cue.id] = cue.omitted === true;
      }
    }
    const sourceManifest = sourceJob
      ? await readJson(at('temp', sourceJob.id, 'manifest.json'), null)
      : null;
    const localMedia = job.localMedia ?? sourceJob?.localMedia;
    let input = localMedia
      ? undefined
      : job.type === 'translation'
        ? sourceManifest?.input || sourceJob?.input
        : manifest?.input || job.input;
    const inherited = sourceJob
      ? await readSubtitleReview(sourceJob.id).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        })
      : null;
    let media: string | null = null,
      duration = 0;
    if (inherited?.media)
      input = await contained(at('review-sessions'), sourceJob!.id, inherited.media);
    if (
      input &&
      !(await fs.stat(input).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }))
    )
      input = undefined;
    let downloaded = false;
    if (!localMedia && !input && job.youtubeUrl) {
      downloaded = true;
      input = await withTempBudget(
        settings.MAX_UPLOAD_BYTES,
        () =>
          downloadVideo(job.youtubeUrl!, job.id, {
            ...options,
            settings,
            includeVideo: true,
            workDir: at('temp', job.id, 'review-download'),
            onStage: async (update) => {
              await options.onStage?.({ ...update, id: 'review' });
            },
          }),
        settings,
      );
    }
    if (input) {
      const pinned =
        job.type === 'translation'
          ? sourceManifest?.sourceStat || sourceJob?.sourceStat
          : manifest?.sourceStat || job.sourceStat;
      if (pinned && !inherited?.media && !downloaded) {
        const stat = await fs.stat(input);
        if (stat.size !== pinned.size || stat.mtimeMs !== pinned.mtimeMs)
          throw new Error('Review source no longer matches the transcribed film');
      }
      ({ media, duration } = await prepareReviewMedia(input, job.id, {
        ...options,
        settings: {
          ...settings,
          AUDIO_STREAM_INDEX: inherited?.media
            ? 0
            : (sourceJob?.settings.AUDIO_STREAM_INDEX ?? settings.AUDIO_STREAM_INDEX),
        },
      }));
    } else if (!localMedia && job.type !== 'translation')
      throw new Error(
        'Source media is missing. Restore the original file and prepare the screening again.',
      );
    // Screening media is durable now; the re-download is never a resume checkpoint.
    const downloadDir = at('temp', job.id, 'review-download');
    await fs.rm(downloadDir, { recursive: true, force: true });
    await fs.rmdir(at('temp', job.id)).catch((error) => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
    });
    const document = await createSubtitleReview({
      id: job.id,
      title: job.title,
      source,
      target,
      sourceLanguage,
      targetLanguage,
      media,
      duration,
      ...(localMedia ? { localMedia, duration: localMedia.duration } : {}),
      speakers,
      warnings,
      omissions,
      mediaMessage: localMedia
        ? 'Open the matching local movie to watch and correct subtitles. Your movie stays on this computer.'
        : media
          ? ''
          : 'This subtitle-only job has no linked film. Choose a local video in the editor to check timing.',
    });
    return screeningLinks(job.id, document.languages, targetLanguage);
  });
}
