import type { PipelineOptions } from '../types/pipeline.js';
import { credential } from './lib/credentials.js';
import { youtube } from './lib/youtube.js';
import { config } from '../config.js';
import { fetchLimited } from './lib/http.js';
import { run, checkAbort } from './lib/process.js';
import { parseSrt, segmentsToSrt } from './lib/srt.js';
import { validateYouTubeUrl } from './1_download_video.js';
import fs from 'node:fs/promises';

async function movieHash(file: string) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size < 131072) return null;
    let hash = BigInt(size);
    for (const position of [0, size - 65536]) {
      const buffer = Buffer.alloc(65536);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead !== buffer.length) throw new Error('Movie changed during subtitle lookup');
      for (let offset = 0; offset < buffer.length; offset += 8)
        hash += buffer.readBigUInt64LE(offset);
    }
    return { hash: (hash & 0xffffffffffffffffn).toString(16).padStart(16, '0'), size };
  } finally {
    await handle.close();
  }
}

export async function searchOpenSubtitles({
  imdbId,
  movie,
  language = 'en',
  signal,
}: Record<string, any>) {
  const key = await credential('OPENSUBTITLES_API_KEY');
  if (!key) return null;
  const headers: Record<string, string> = {
    'Api-Key': key,
    'User-Agent': (await credential('OPENSUBTITLES_USER_AGENT')) || 'YesilcamRevival v1.0',
    'Content-Type': 'application/json',
  };
  const token = await credential('OPENSUBTITLES_TOKEN');
  if (token) headers.Authorization = `Bearer ${token}`;
  const params = new URLSearchParams({ languages: language, type: 'movie' });
  if (movie) {
    params.set('moviehash', movie.hash);
    params.set('moviebytesize', String(movie.size));
  } else if (imdbId) {
    if (!/^(tt)?\d{5,12}$/.test(imdbId)) throw new Error('Invalid IMDb ID');
    params.set('imdb_id', imdbId.replace(/^tt/, ''));
  } else return null;
  const data = (
    await fetchLimited(`https://api.opensubtitles.com/api/v1/subtitles?${params}`, {
      headers,
      signal,
    })
  ).json();
  const match = data.data
    ?.filter(
      (item: any) =>
        item.attributes?.language === language &&
        !item.attributes.ai_translated &&
        !item.attributes.machine_translated &&
        item.attributes?.files?.length === 1 &&
        item.attributes.files[0].file_id &&
        (!movie || item.attributes.moviehash_match === true),
    )
    .sort(
      (a: any, b: any) =>
        Number(b.attributes.download_count || 0) - Number(a.attributes.download_count || 0),
    )[0];
  if (!match) return null;
  const fileId = match.attributes.files[0].file_id;
  const download = (
    await fetchLimited('https://api.opensubtitles.com/api/v1/download', {
      method: 'POST',
      headers,
      body: JSON.stringify({ file_id: fileId, sub_format: 'srt' }),
      signal,
    })
  ).json();
  if (!download.link || new URL(download.link).protocol !== 'https:')
    throw new Error('Invalid OpenSubtitles download URL');
  const content = (await fetchLimited(download.link, { signal })).text;
  if (!parseSrt(content).length) throw new Error('Downloaded subtitle is empty');
  return { source: 'opensubtitles', language, content, fileId, referenceOnly: !movie };
}

export async function checkExistingSubtitles(
  youtubeUrl: any,
  imdbId: any,
  options: PipelineOptions = {},
) {
  const language = options.targetLanguage ?? config.TARGET_LANGUAGE;
  if (youtubeUrl) {
    try {
      const { stdout } = await youtube(
        ['--skip-download', '--dump-single-json', '--', validateYouTubeUrl(youtubeUrl)],
        { signal: options.signal, timeout: 60000 },
      );
      const subtitles = JSON.parse(stdout).subtitles ?? {};
      const keys = Object.keys(subtitles)
        .filter(
          (key) => key === language || key.toLowerCase().startsWith(`${language.toLowerCase()}-`),
        )
        .sort((a, b) => Number(b === language) - Number(a === language));
      const track = keys.flatMap((key) => subtitles[key]).find((item: any) => item.ext === 'json3');
      if (track) {
        const data = (await fetchLimited(track.url, { signal: options.signal })).json();
        const segments = (data.events ?? [])
          .filter((event: any) => event.segs?.length && event.dDurationMs > 0)
          .map((event: any) => ({
            start: event.tStartMs / 1000,
            end: (event.tStartMs + event.dDurationMs) / 1000,
            text: event.segs
              .map((segment: any) => segment.utf8)
              .join('')
              .trim(),
          }))
          .filter((s: any) => s.text);
        if (segments.length)
          return {
            source: 'youtube',
            language,
            content: segmentsToSrt(segments, { preserveTimestamps: true }),
          };
      }
    } catch (error) {
      checkAbort(options.signal);
      await options.onWarning?.(`Subtitle lookup failed: ${error.message}`);
    }
  }
  if (imdbId || ((options.input || options.movie) && (await credential('OPENSUBTITLES_API_KEY')))) {
    try {
      return await searchOpenSubtitles({
        imdbId,
        movie: options.movie ?? (options.input ? await movieHash(options.input) : null),
        language,
        signal: options.signal,
      });
    } catch (error) {
      checkAbort(options.signal);
      await options.onWarning?.(
        `OpenSubtitles lookup failed: ${error.message}; generating subtitles instead.`,
      );
    }
  }
  return null;
}
