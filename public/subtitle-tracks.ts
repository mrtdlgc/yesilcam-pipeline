const aliases: Record<string, string> = {};
for (const group of [
  'en eng',
  'tr tur',
  'uk ukr',
  'ru rus',
  'de deu ger',
  'fr fra fre',
  'es spa',
  'it ita',
  'ar ara',
  'fa fas per',
  'el ell gre',
  'nl nld dut',
  'pt por',
  'pl pol',
  'ro ron rum',
  'zh zho chi',
  'ja jpn',
  'ko kor',
  'hi hin',
  'he heb',
  'cs ces cze',
  'sv swe',
  'da dan',
  'no nor nob nno nb nn',
  'fi fin',
  'hu hun',
  'bg bul',
  'sr srp',
  'hr hrv',
  'sk slk slo',
  'th tha',
  'vi vie',
  'id ind',
  'ms msa may',
  'ca cat',
  'eu eus baq',
  'gl glg',
  'is isl ice',
  'et est',
  'lv lav',
  'lt lit',
  'sl slv',
  'sq sqi alb',
  'mk mkd mac',
  'hy hye arm',
  'ka kat geo',
  'az aze',
  'be bel',
  'kk kaz',
  'ur urd',
  'bn ben',
  'ta tam',
  'te tel',
  'ml mal',
  'tl tgl fil',
]) {
  const codes = group.split(' ');
  for (const code of codes) aliases[code] = codes[0];
}
export function subtitleLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0];
  if (!/^[a-z]{2,3}$/.test(code) || ['und', 'mul', 'zxx', 'mis'].includes(code)) return null;
  return aliases[code] ?? code;
}
export interface EmbeddedTrack {
  index: number;
  codec: string;
  language: string | null;
  title: string;
  default: boolean;
  hearingImpaired: boolean;
  reason: string | null;
  selected?: boolean;
  cues?: number;
}
const textCodecs = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt', 'text']);
export function embeddedTracks(streams: any[]): EmbeddedTrack[] {
  return streams
    .filter((stream) => stream.codec_type === 'subtitle')
    .map((stream) => {
      const language = subtitleLanguage(stream.tags?.language);
      const title = String(stream.tags?.title ?? '').slice(0, 300);
      const disposition = stream.disposition ?? {};
      const forced = disposition.forced || /\bforced\b/i.test(title);
      const commentary =
        disposition.comment || /\b(commentary|director[’']?s comments?)\b/i.test(title);
      const signsOnly =
        !/\b(full|dialogue|complete)\b/i.test(title) &&
        /\b(?:signs?|songs?|lyrics?)(?:[\s/&+_-]+(?:and\s+)?(?:signs?|songs?|lyrics?))*(?:\s+only)?\s*(?:$|[)\]])/i.test(
          title,
        );
      return {
        index: stream.index,
        codec: stream.codec_name,
        language,
        title,
        default: Boolean(disposition.default),
        hearingImpaired:
          Boolean(disposition.hearing_impaired) || /\b(sdh|cc|hearing.impaired)\b/i.test(title),
        reason: forced
          ? 'Forced subtitles are not a full dialogue track.'
          : commentary
            ? 'Commentary is not the film dialogue.'
            : signsOnly
              ? 'Signs or songs only; not a full dialogue track.'
              : !textCodecs.has(stream.codec_name)
                ? 'Image-based or unsupported subtitles need OCR before translation.'
                : !language
                  ? 'Track language is missing or undetermined.'
                  : null,
      };
    });
}

export function rankedSubtitleTracks(
  tracks: EmbeddedTrack[],
  targetLanguage: string,
  sourceLanguage: string,
  audioLanguage: string | null,
) {
  const preferred = [
    ...new Set(
      [subtitleLanguage(targetLanguage), subtitleLanguage(sourceLanguage), audioLanguage].filter(
        (value): value is string => Boolean(value),
      ),
    ),
  ];
  const rank = (track: EmbeddedTrack) => {
    const match = preferred.indexOf(track.language!);
    return match >= 0
      ? match
      : preferred.length + (track.default ? 0 : track.language === 'en' ? 1 : 2);
  };
  return tracks
    .filter((track) => !track.reason)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(a.hearingImpaired) - Number(b.hearingImpaired) ||
        Number(b.default) - Number(a.default) ||
        a.index - b.index,
    );
}
