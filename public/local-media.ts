import type { FFmpeg } from '@ffmpeg/ffmpeg';
import type { LocalMedia, LocalWaveform } from './local-types.js';
import { embeddedTracks, rankedSubtitleTracks, subtitleLanguage } from './subtitle-tracks.js';
import { parseSrt } from './subtitle-text.js';

type Progress = (message: string, percentage?: number) => void;
const root = new URL('./', import.meta.url);
const maxOutput = 512 * 1024 ** 2;
const hashes = new WeakMap<File, Promise<string>>();

export async function localMovieHash(file: File): Promise<string | undefined> {
  if (file.size < 131072) return undefined;
  let hash = BigInt(file.size);
  for (const start of [0, file.size - 65536]) {
    const data = new DataView(await file.slice(start, start + 65536).arrayBuffer());
    for (let offset = 0; offset < data.byteLength; offset += 8)
      hash += data.getBigUint64(offset, true);
  }
  return (hash & 0xffffffffffffffffn).toString(16).padStart(16, '0');
}

export function fingerprint(file: File): Promise<string> {
  let promise = hashes.get(file);
  if (!promise) {
    promise = (async () => {
      if (!crypto.subtle) throw new Error('Local preparation needs HTTPS (or localhost).');
      const size = 1024 * 1024;
      const parts = await Promise.all(
        [0, Math.floor(file.size / 2), Math.max(0, file.size - size)].map((start) =>
          file.slice(start, start + size).arrayBuffer(),
        ),
      );
      const data = await new Blob([String(file.size), ...parts]).arrayBuffer();
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))]
        .map((value) => value.toString(16).padStart(2, '0'))
        .join('');
    })();
    hashes.set(file, promise);
  }
  return promise;
}

async function engine(file: File, signal: AbortSignal, progress: Progress) {
  signal.throwIfAborted();
  progress('Loading local media tools… Your movie stays on this computer.');
  const module = (await import(
    new URL('vendor/ffmpeg-0.12.15/index.js', root).href
  )) as typeof import('@ffmpeg/ffmpeg');
  const ffmpeg = new module.FFmpeg();
  const abort = () => ffmpeg.terminate();
  signal.addEventListener('abort', abort, { once: true });
  const close = () => {
    signal.removeEventListener('abort', abort);
    ffmpeg.terminate();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    await Promise.race([
      ffmpeg.load({
        coreURL: new URL('vendor/ffmpeg-core-0.12.10/ffmpeg-core.js', root).href,
        wasmURL: new URL('vendor/ffmpeg-core-0.12.10/ffmpeg-core.wasm', root).href,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Local media tools took too long to load. Try again.')),
          90000,
        );
      }),
    ]);
    clearTimeout(timer);
    await ffmpeg.createDir('/movie');
    // WORKERFS reads File slices on demand. Never copy a multi-GB movie into WASM memory.
    if (
      !(await ffmpeg.mount(
        module.FFFSType.WORKERFS,
        { blobs: [{ name: 'input', data: file }] },
        '/movie',
      ))
    )
      throw new Error('This browser cannot read the local movie. Try a desktop browser.');
    return { ffmpeg, input: '/movie/input', close };
  } catch (error) {
    clearTimeout(timer);
    close();
    throw error;
  }
}
async function inspect(ffmpeg: FFmpeg, input: string) {
  await ffmpeg.deleteFile('/probe.json').catch(() => {});
  const messages: string[] = [];
  const log = ({ message }: { message: string }) => {
    messages.push(message.slice(0, 200));
    if (messages.length > 3) messages.shift();
  };
  ffmpeg.on('log', log);
  try {
    const code = await ffmpeg.ffprobe(
      [
        '-v',
        'error',
        '-show_error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        input,
        '-o',
        '/probe.json',
      ],
      60000,
    );
    // core 0.12.10 leaves ret at -1 on successful ffprobe calls (upstream #817).
    // Accept it only with fresh, complete JSON metadata below; never reuse stale output.
    if (code !== 0 && code !== -1)
      throw new Error(
        `Could not inspect this media file locally: ${messages.join(' ').slice(0, 400) || `decoder status ${code}`}`,
      );
  } finally {
    ffmpeg.off('log', log);
  }
  const info = JSON.parse((await ffmpeg.readFile('/probe.json', 'utf8')) as string);
  await ffmpeg.deleteFile('/probe.json');
  if (
    info.error ||
    !Array.isArray(info.streams) ||
    !info.streams.length ||
    !(Number(info.format?.duration) > 0)
  )
    throw new Error('Could not read complete media metadata locally.');
  return info as { format: { duration: string; tags?: Record<string, string> }; streams: any[] };
}
async function execute(
  ffmpeg: FFmpeg,
  args: string[],
  duration: number,
  progress: Progress,
  message: string,
  timeout = 30 * 60 * 1000,
) {
  const update = ({ time }: { time: number }) =>
    progress(message, Math.max(0, Math.min(99, (time / 1e6 / duration) * 100)));
  ffmpeg.on('progress', update);
  progress(message, 0);
  try {
    if (
      (await ffmpeg.exec(
        ['-v', 'error', '-threads', '1', '-filter_threads', '1', ...args],
        timeout,
      )) !== 0
    )
      throw new Error(
        'Local media preparation stopped or exceeded its limit. No movie was uploaded.',
      );
  } finally {
    ffmpeg.off('progress', update);
  }
}

export async function prepareLocalMedia(
  file: File,
  options: {
    sourceLanguage: string;
    targetLanguage: string;
    audioStreamIndex: number;
    maxDuration: number;
    maxAudioBytes: number;
    signal: AbortSignal;
    progress: Progress;
    findSubtitles?: (
      media: LocalMedia,
    ) => Promise<{ content: string; language: string; source: string } | null>;
  },
) {
  if (!crypto.subtle) throw new Error('Local preparation needs HTTPS (or localhost).');
  if (!file.size || file.size > 128 * 1024 ** 3)
    throw new Error('Choose a nonempty movie smaller than 128 GiB.');
  const { ffmpeg, input, close } = await engine(file, options.signal, options.progress);
  try {
    options.progress('Inspecting local audio and subtitle tracks…');
    const info = await inspect(ffmpeg, input),
      duration = Number(info.format.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > options.maxDuration)
      throw new Error('Movie duration exceeds the supported limit.');
    const audio = info.streams.filter((stream) => stream.codec_type === 'audio')[
      options.audioStreamIndex
    ];
    if (!audio) throw new Error('The selected audio track is missing.');
    const video = info.streams.find(
      (stream) => stream.codec_type === 'video' && !stream.disposition?.attached_pic,
    );
    const rate = (value: string) => {
      const [n, d] = String(value).split('/').map(Number);
      return n / d;
    };
    const fps = rate(video?.avg_frame_rate);
    const media: LocalMedia = {
      version: 1,
      name: file.name,
      size: file.size,
      fingerprint: await fingerprint(file),
      duration,
      frameRate:
        fps >= 1 && fps <= 240 && Math.abs(fps - rate(video?.r_frame_rate)) < 0.001 ? fps : null,
      audioStreamIndex: options.audioStreamIndex,
    };
    media.movieHash = await localMovieHash(file);
    const tracks = rankedSubtitleTracks(
      embeddedTracks(info.streams),
      options.targetLanguage,
      options.sourceLanguage,
      subtitleLanguage(audio.tags?.language),
    );
    const deadline = Date.now() + 120000;
    for (const track of tracks) {
      options.signal.throwIfAborted();
      if (Date.now() >= deadline) break;
      options.progress(`Extracting ${track.language} subtitles on this computer…`);
      try {
        if (
          (await ffmpeg.exec(
            [
              '-v',
              'error',
              '-i',
              input,
              '-map',
              `0:${track.index}`,
              '-c:s',
              'srt',
              '-fs',
              '1048576',
              '/subtitles.srt',
            ],
            Math.max(1, deadline - Date.now()),
          )) !== 0
        )
          continue;
        const content = (await ffmpeg.readFile('/subtitles.srt', 'utf8')) as string;
        if (new TextEncoder().encode(content).length >= 1024 ** 2) continue;
        const cues = parseSrt(content);
        if (
          !cues.length ||
          cues.length > 10000 ||
          cues.some((cue) => cue.end > duration + 0.25) ||
          (duration >= 600 &&
            (cues.length < 10 || Math.max(...cues.map((cue) => cue.end)) < duration / 2))
        )
          continue;
        return {
          media,
          subtitle: {
            content,
            language: track.language!,
            source: 'local-embedded',
            streamIndex: track.index,
            title: track.title,
          },
          audio: null,
        };
      } catch (error) {
        options.signal.throwIfAborted();
      } finally {
        await ffmpeg.deleteFile('/subtitles.srt').catch(() => {});
      }
    }
    if (options.findSubtitles) {
      options.progress('Checking online subtitles using only the movie fingerprint…');
      const subtitle = await options.findSubtitles(media);
      if (subtitle) return { media, subtitle, audio: null };
    }
    options.signal.throwIfAborted();
    const cap = Math.min(options.maxAudioBytes, maxOutput);
    await execute(
      ffmpeg,
      [
        '-i',
        input,
        '-map',
        `0:${audio.index}`,
        '-vn',
        '-sn',
        '-dn',
        '-af',
        'aresample=async=1:first_pts=0,apad',
        '-t',
        String(duration),
        '-ac',
        '1',
        '-ar',
        '16000',
        '-sample_fmt',
        's16',
        '-c:a',
        'flac',
        '-compression_level',
        '3',
        '-fs',
        String(cap),
        '/audio.flac',
      ],
      duration,
      options.progress,
      'Preparing compact audio locally… Video stays on this computer.',
    );
    const prepared = await inspect(ffmpeg, '/audio.flac');
    if (Math.abs(Number(prepared.format.duration) - duration) > 0.05)
      throw new Error('Prepared audio is incomplete. No job was submitted.');
    const data = (await ffmpeg.readFile('/audio.flac')) as Uint8Array<ArrayBuffer>;
    if (!data.length || data.length >= cap)
      throw new Error('Prepared audio exceeds the upload limit.');
    return { media, subtitle: null, audio: new Blob([data], { type: 'audio/flac' }) };
  } finally {
    close();
  }
}

function base64(bytes: Uint8Array) {
  let value = '';
  for (let i = 0; i < bytes.length; i += 8192)
    value += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(value);
}
export async function localWaveform(
  file: File,
  media: LocalMedia,
  signal: AbortSignal,
  progress: Progress,
): Promise<LocalWaveform> {
  const { ffmpeg, input, close } = await engine(file, signal, progress);
  try {
    const bins = Math.ceil(media.duration * 100),
      peaks = new Uint8Array(bins),
      rms = new Uint8Array(bins);
    for (let start = 0; start < media.duration; start += 120) {
      signal.throwIfAborted();
      progress('Preparing waveform on this computer…', (start / media.duration) * 100);
      const duration = Math.min(120, media.duration - start);
      if (
        (await ffmpeg.exec(
          [
            '-v',
            'error',
            '-threads',
            '1',
            '-ss',
            String(start),
            '-i',
            input,
            '-map',
            `0:a:${media.audioStreamIndex}`,
            '-vn',
            '-sn',
            '-dn',
            '-af',
            'aresample=8000:async=1:first_pts=0,apad',
            '-t',
            String(duration),
            '-ac',
            '1',
            '-ar',
            '8000',
            '-c:a',
            'pcm_s16le',
            '-f',
            's16le',
            '/waveform.pcm',
          ],
          180000,
        )) !== 0
      )
        throw new Error('Local waveform decoding failed.');
      const data = (await ffmpeg.readFile('/waveform.pcm')) as Uint8Array<ArrayBuffer>;
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (
        let offset = 0, bin = start * 100;
        offset + 1 < data.length && bin < bins;
        bin++, offset += 160
      ) {
        let peak = 0,
          squares = 0,
          count = 0;
        for (let p = offset; p < Math.min(offset + 160, data.length - 1); p += 2) {
          const sample = view.getInt16(p, true);
          peak = Math.max(peak, Math.abs(sample));
          squares += sample * sample;
          count++;
        }
        peaks[bin] = Math.min(255, Math.round((peak / 32768) * 255));
        rms[bin] = Math.min(255, Math.round((Math.sqrt(squares / count) / 32768) * 255));
      }
      await ffmpeg.deleteFile('/waveform.pcm');
    }
    return {
      version: 1,
      duration: media.duration,
      binsPerSecond: 100,
      peaks: base64(peaks),
      rms: base64(rms),
    };
  } finally {
    close();
  }
}

// Optional, explicitly started fallback for codecs the browser cannot play directly.
// The small screening copy is generated and kept locally, never sent to the VPS.
export async function localScreening(
  file: File,
  media: LocalMedia,
  signal: AbortSignal,
  progress: Progress,
) {
  const { ffmpeg, input, close } = await engine(file, signal, progress);
  try {
    const videoRate = Math.max(
      100000,
      Math.min(800000, Math.floor((384 * 1024 ** 2 * 8) / media.duration) - 96000),
    );
    await execute(
      ffmpeg,
      [
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        `0:a:${media.audioStreamIndex}`,
        '-vf',
        'scale=-2:min(480\\,ih),format=yuv420p',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-b:v',
        String(videoRate),
        '-maxrate',
        String(videoRate),
        '-bufsize',
        String(videoRate * 2),
        '-af',
        'aresample=async=1:first_pts=0,apad',
        '-c:a',
        'aac',
        '-b:a',
        '80k',
        '-ac',
        '2',
        '-t',
        String(media.duration),
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-metadata',
        `comment=yesilcam-local:${media.fingerprint}`,
        '-movflags',
        '+faststart',
        '-fs',
        String(maxOutput),
        '/screening.mp4',
      ],
      media.duration,
      progress,
      'Preparing a local screening copy… This can take a while. You can keep editing.',
      12 * 60 * 60 * 1000,
    );
    const info = await inspect(ffmpeg, '/screening.mp4');
    if (Math.abs(Number(info.format.duration) - media.duration) > 0.25)
      throw new Error('Local screening copy is incomplete.');
    const data = (await ffmpeg.readFile('/screening.mp4')) as Uint8Array<ArrayBuffer>;
    if (data.length >= maxOutput)
      throw new Error(
        'Local screening exceeded its memory limit. Use a browser-playable MP4 copy.',
      );
    return new File([data], `${file.name}.screening.mp4`, { type: 'video/mp4' });
  } finally {
    close();
  }
}

export async function matchLocalFile(
  file: File,
  media: LocalMedia,
  signal: AbortSignal,
): Promise<LocalMedia> {
  if (file.size === media.size && (await fingerprint(file)) === media.fingerprint) return media;
  const { ffmpeg, input, close } = await engine(file, signal, () => {});
  try {
    const info = await inspect(ffmpeg, input);
    if (
      info.format.tags?.comment === `yesilcam-local:${media.fingerprint}` &&
      Math.abs(Number(info.format.duration) - media.duration) < 0.25
    )
      return { ...media, audioStreamIndex: 0 };
    throw new Error(
      'This is a different movie or edition. Choose the original file or its saved local screening copy.',
    );
  } finally {
    close();
  }
}
