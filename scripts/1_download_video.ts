import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { at, jobId as validateId } from './lib/files.js';
import { youtube } from './lib/youtube.js';
import type { PipelineOptions } from '../types/pipeline.js';
import { downloadProgress, progressLines } from './lib/progress.js';

export function validateYouTubeUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A YouTube video URL is required');
  const url = new URL(value);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'].includes(url.hostname)
  )
    throw new Error('A YouTube video URL is required');
  const id =
    url.hostname === 'youtu.be'
      ? url.pathname.slice(1)
      : (url.searchParams.get('v') ?? url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)/)?.[1]);
  if (!/^[a-zA-Z0-9_-]{11}$/.test(id ?? '')) throw new Error('A single YouTube video is required');
  return `https://www.youtube.com/watch?v=${id}`;
}

export async function downloadVideo(youtubeUrl: string, id: string, options: PipelineOptions = {}) {
  validateId(id);
  const settings = { ...config, ...options.settings };
  const dir = options.workDir ?? at('temp', id);
  await fs.mkdir(dir, { recursive: true });
  const url = validateYouTubeUrl(youtubeUrl);
  const metadata = await youtube(['--skip-download', '--dump-single-json', '--', url], {
    signal: options.signal,
    timeout: 90000,
  });
  const info = JSON.parse(metadata.stdout);
  if (
    info.is_live ||
    info.live_status === 'is_upcoming' ||
    !Number.isFinite(info.duration) ||
    info.duration <= 0
  )
    throw new Error('Choose a finished YouTube video with a known duration');
  if (info.duration > settings.MAX_INPUT_DURATION_SEC)
    throw new Error('YouTube video exceeds the configured duration limit');
  const limit = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, limit.signal]) : limit.signal;
  let monitoring = false,
    storageError: Error | undefined;
  const monitor = setInterval(async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      let bytes = 0;
      for (const name of await fs.readdir(dir))
        if (name.startsWith('source.')) {
          bytes += await fs.stat(path.join(dir, name)).then(
            (s) => s.size,
            (e) => {
              if (e.code === 'ENOENT') return 0;
              throw e;
            },
          );
        }
      if (bytes > settings.MAX_UPLOAD_BYTES)
        throw new Error('YouTube download exceeded the configured size limit');
    } catch (error) {
      storageError = error;
      limit.abort();
    } finally {
      monitoring = false;
    }
  }, 1000);
  let stdout: string;
  const updates = progressLines(async (value) => {
    await options.onStage?.(downloadProgress(value));
  });
  try {
    ({ stdout } = await youtube(
      [
        '--no-simulate',
        '--newline',
        '--progress',
        '--progress-template',
        'download:YESILCAM_PROGRESS {"downloaded_bytes":%(progress.downloaded_bytes|null)j,"total_bytes":%(progress.total_bytes|null)j,"total_bytes_estimate":%(progress.total_bytes_estimate|null)j,"status":%(progress.status|null)j}',
        '--progress-delta',
        '5',
        '--max-filesize',
        String(settings.MAX_UPLOAD_BYTES),
        '--match-filter',
        `!is_live & duration <= ${settings.MAX_INPUT_DURATION_SEC}`,
        '-f',
        options.includeVideo
          ? 'bestvideo[height<=720][vcodec^=avc1]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[height<=720]'
          : 'bestaudio/best',
        '-o',
        path.join(dir, 'source.%(ext)s'),
        '--print',
        'after_move:filepath',
        '--',
        url,
      ],
      {
        signal,
        timeout: settings.MEDIA_TIMEOUT_MS,
        onStderr: (text) => {
          updates.push(text);
          options.onLog?.(text);
        },
        maxOutput: 1024 * 1024,
      },
    ));
  } catch (error) {
    throw storageError ?? error;
  } finally {
    clearInterval(monitor);
    await updates.finish();
  }
  const file = stdout.trim().split('\n').at(-1);
  if (!file || path.dirname(path.resolve(file)) !== path.resolve(dir))
    throw new Error(
      'YouTube produced no audio file. The available download may exceed the size limit or no supported audio format was available; upload a local file instead.',
    );
  const stat = await fs.stat(file);
  if (!stat.size || stat.size > settings.MAX_UPLOAD_BYTES)
    throw new Error('Downloaded audio exceeds the configured limit');
  return file;
}
