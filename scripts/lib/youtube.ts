import { at } from './files.js';
import { run } from './process.js';
import type { RunOptions } from './process.js';
import { withYouTubeCookies } from './credentials.js';

export async function youtube(args: string[], options: RunOptions = {}) {
  return withYouTubeCookies(async (cookies) => {
    try {
      return await run(
        process.env.YTDLP_BIN || 'yt-dlp',
        [
          '--ignore-config',
          '--no-plugin-dirs',
          '--no-remote-components',
          '--no-js-runtimes',
          '--js-runtimes',
          `node:${process.execPath}`,
          '--no-playlist',
          '--socket-timeout',
          '20',
          '--retries',
          '3',
          '--fragment-retries',
          '3',
          '--extractor-retries',
          '2',
          '--cache-dir',
          at('data', 'yt-dlp-cache'),
          ...(cookies ? ['--cookies', cookies] : []),
          ...args,
        ],
        options,
      );
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const detail = String(error.message);
      if (/ENOENT/.test(detail))
        throw new Error(
          'yt-dlp is missing. Install requirements-download.txt; the Docker image includes it.',
        );
      if (
        /sign in|confirm you.re not a bot|cookies|HTTP Error 403|HTTP Error 429|PO Token/i.test(
          detail,
        )
      ) {
        throw new Error(
          'YouTube rejected access from this server. Save a fresh YouTube cookies.txt export in Connections and retry, or upload the audio. Some hosting IPs remain blocked even with cookies.',
        );
      }
      if (/challenge|javascript|js runtime|signature|nsig/i.test(detail)) {
        throw new Error(
          'YouTube challenge solving failed. Update yt-dlp and its matching yt-dlp-ejs package using requirements-download.txt, then rebuild the image. Node is enabled automatically.',
        );
      }
      if (/private video|video unavailable|not available|members.only/i.test(detail))
        throw new Error(
          'This YouTube video is unavailable to the server/account. Check the link or upload a local audio file.',
        );
      throw error;
    }
  });
}
