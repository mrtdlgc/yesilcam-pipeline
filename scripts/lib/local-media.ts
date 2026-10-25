import type { LocalMedia } from '../../public/local-types.js';
import { config } from '../../config.js';
import { subtitleDocument, MAX_SUBTITLE_BYTES } from './codex-translation.js';
import { subtitleLanguage } from './embedded-subtitles.js';

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { status: 400 });
};
export function localMediaMetadata(value: unknown): LocalMedia {
  const data = value as LocalMedia;
  if (
    !data ||
    data.version !== 1 ||
    typeof data.name !== 'string' ||
    !data.name.trim() ||
    data.name.length > 255 ||
    /[\x00-\x1f\x7f/\\]/.test(data.name) ||
    !Number.isSafeInteger(data.size) ||
    data.size <= 0 ||
    data.size > 128 * 1024 ** 3 ||
    typeof data.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.fingerprint) ||
    !Number.isFinite(data.duration) ||
    data.duration <= 0 ||
    data.duration > config.MAX_INPUT_DURATION_SEC ||
    !(
      data.frameRate === null ||
      (Number.isFinite(data.frameRate) && data.frameRate >= 1 && data.frameRate <= 240)
    ) ||
    !Number.isInteger(data.audioStreamIndex) ||
    data.audioStreamIndex < 0 ||
    data.audioStreamIndex > 63
  )
    invalid('Invalid local movie metadata');
  if (
    data.movieHash !== undefined &&
    (typeof data.movieHash !== 'string' ||
      !/^[a-f0-9]{16}$/.test(data.movieHash) ||
      data.size < 131072)
  )
    invalid('Invalid movie lookup fingerprint');
  if (data.requiresLocalScreening !== undefined && typeof data.requiresLocalScreening !== 'boolean')
    invalid('Invalid local playback information');
  return {
    version: 1,
    name: data.name,
    size: data.size,
    fingerprint: data.fingerprint,
    duration: data.duration,
    frameRate: data.frameRate,
    audioStreamIndex: data.audioStreamIndex,
    ...(data.movieHash ? { movieHash: data.movieHash } : {}),
    ...(data.requiresLocalScreening !== undefined
      ? { requiresLocalScreening: data.requiresLocalScreening }
      : {}),
  };
}
export function localSubtitle(value: any, media: LocalMedia, targetLanguage?: string) {
  if (
    !value ||
    typeof value.content !== 'string' ||
    Buffer.byteLength(value.content) > MAX_SUBTITLE_BYTES
  )
    invalid('Local subtitles exceed the size limit');
  const language = subtitleLanguage(value.language);
  if (!language) invalid('Choose a known subtitle language');
  const { cues } = subtitleDocument(value.content);
  if (
    !cues.length ||
    cues.length > 10000 ||
    cues.some((cue) => cue.start < 0 || cue.end > media.duration + 0.25)
  )
    invalid('Local subtitle times fall outside this movie');
  if (
    media.duration >= 600 &&
    (cues.length < 10 || Math.max(...cues.map((cue) => cue.end)) < media.duration / 2)
  )
    invalid('Sparse or incomplete subtitles cannot replace full dialogue');
  return {
    content: value.content as string,
    language:
      targetLanguage && subtitleLanguage(targetLanguage) === language ? targetLanguage : language!,
    source: value.source === 'opensubtitles' ? 'opensubtitles' : 'local-embedded',
    title: typeof value.title === 'string' ? value.title.slice(0, 300) : '',
    ...(Number.isInteger(value.streamIndex) && value.streamIndex >= 0 && value.streamIndex < 1024
      ? { streamIndex: value.streamIndex as number }
      : {}),
  };
}
export function validateLocalAudio(info: { duration: number; streams: any[] }, media: LocalMedia) {
  const audio = info.streams.filter((s) => s.codec_type === 'audio');
  if (
    !Number.isFinite(info.duration) ||
    info.duration <= 0 ||
    info.streams.length !== 1 ||
    audio.length !== 1 ||
    audio[0].codec_name !== 'flac' ||
    Number(audio[0].sample_rate) !== 16000 ||
    audio[0].sample_fmt !== 's16' ||
    audio[0].channels !== 1 ||
    Math.abs(info.duration - media.duration) > 0.05
  )
    invalid(
      'Hybrid jobs accept only complete 16 kHz mono FLAC audio; the movie must stay on your computer',
    );
}
