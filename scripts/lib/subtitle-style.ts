import type { Segment } from '../../types/pipeline.js';
import { parseSrt } from './srt.js';

// An automated layout/readability profile, not Netflix delivery certification.
export const SUBTITLE_STYLE_VERSION = 1;
const markup = /(<\/?(?:i|b|u|font)\b[^>]*>)/gi;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function netflixProfile(language = 'en') {
  return {
    name: 'Netflix-inspired',
    version: SUBTITLE_STYLE_VERSION,
    language,
    maxLines: 2,
    maxCharactersPerLine: 42,
    minDurationSeconds: 5 / 6,
    maxDurationSeconds: 7,
    // Conservative Turkish interlingual limit; this is not an SDH generator.
    maxCharactersPerSecond: ['tr', 'tur'].includes(language) ? 17 : 20,
    languageSpecific: ['en', 'eng', 'tr', 'tur'].includes(language),
  };
}

function decodeEntities(text: string) {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,
    (original, entity: string) => {
      if (!entity.startsWith('#')) return named[entity.toLowerCase()];
      const point =
        entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
      return point >= 32 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : original;
    },
  );
}

export function visibleText(text: string) {
  return decodeEntities(text.replace(markup, ''));
}

export function visibleLength(text: string) {
  return Array.from(graphemes.segment(visibleText(text))).length;
}

function flatText(text: string) {
  // Keep spaces inside markup attributes intact.
  return text
    .split(markup)
    .map((part, index) => (index % 2 ? part : part.replace(/\s+/gu, ' ')))
    .join('')
    .trim();
}

export function wrapSubtitle(text: string, language = 'en'): string {
  const original = text.replace(/\r\n?/g, '\n').trim();
  const lines = original.split('\n').map((line) => line.trim());
  // Two voices/lyrics already have meaningful line boundaries. Never collapse them.
  if (lines.length > 1 && lines.every((line) => /^[-–—♪♫]/u.test(visibleText(line))))
    return lines.join('\n');
  if (
    lines.length === 2 &&
    /^<i>[\s\S]*<\/i>$/i.test(original) &&
    lines.every((line) => visibleLength(line) <= 42)
  )
    return lines.join('\n');
  const flat = flatText(original);
  if (visibleLength(flat) <= 42) return flat;
  if (lines.length === 2 && lines.every((line) => visibleLength(line) <= 42))
    return lines.join('\n');
  let best: { score: number; text: string } | undefined;
  // Only break at spaces outside tags; never split a word or lose a markup token.
  for (const match of flat.matchAll(/<\/?(?:i|b|u|font)\b[^>]*>| /gi)) {
    if (match[0] !== ' ') continue;
    const left = flat.slice(0, match.index),
      right = flat.slice(match.index + 1);
    const a = visibleLength(left),
      b = visibleLength(right);
    if (!a || !b) continue;
    const last = visibleText(left).split(/\s+/u).at(-1) ?? '';
    const first = visibleText(right).split(/\s+/u)[0];
    const english = !['tr', 'tur'].includes(language);
    const stranded = english
      ? /^(a|an|the|my|your|his|her|our|their|to|of|in|on|at|with|from|not|don't|is|are|was|were|will|have|has|had|I|you|he|she|we|they)$/i.test(
          last,
        )
      : /^(bir|bu|şu|o|her|hiçbir|en|çok)$/iu.test(last);
    const phrase =
      /[,;:.!?…]["'”’)]?$/u.test(last) ||
      (english
        ? /^(and|but|or|because|when|if|with|without|for|to|in|on)$/i
        : /^(ve|ama|fakat|çünkü|ancak|oysa|eğer)$/iu
      ).test(first);
    const score =
      (Math.max(0, a - 42) + Math.max(0, b - 42)) * 1000 +
      Math.abs(a - b) +
      (a > b ? 3 : 0) +
      (Math.min(a, b) < 8 ? 30 : 0) +
      (stranded ? 60 : 0) -
      (phrase ? 12 : 0);
    if (!best || score < best.score) best = { score, text: `${left}\n${right}` };
  }
  // Oversize text is kept and flagged below, never truncated to fit.
  return best?.text ?? flat;
}

export function subtitleStyleReport(cues: Segment[], language = 'en') {
  const profile = netflixProfile(language);
  const warnings: { id: string; code: string; reason: string; actual?: number; limit?: number }[] =
    [];
  let previousEnd = -Infinity;
  for (const [index, cue] of cues.entries()) {
    const id = String(cue.id ?? index + 1);
    const warn = (code: string, reason: string, actual?: number, limit?: number) =>
      warnings.push({
        id,
        code,
        reason,
        ...(actual === undefined ? {} : { actual }),
        ...(limit === undefined ? {} : { limit }),
      });
    const lengths = cue.text.split('\n').map(visibleLength);
    if (lengths.length > 2) warn('line_count', 'More than two lines', lengths.length, 2);
    if (Math.max(...lengths) > 42)
      warn(
        'line_length',
        'Line exceeds 42 visible characters; rephrase manually',
        Math.max(...lengths),
        42,
      );
    const duration = cue.end - cue.start;
    if (duration + 0.0005 < profile.minDurationSeconds)
      warn(
        'short_duration',
        'Cue is shorter than 5/6 second; review against the audio',
        duration,
        profile.minDurationSeconds,
      );
    if (duration > 7) warn('long_duration', 'Cue exceeds seven seconds', duration, 7);
    const cps = visibleLength(cue.text.replace(/\n/g, ' ')) / duration;
    if (cps > profile.maxCharactersPerSecond)
      warn(
        'reading_speed',
        'Reading speed exceeds the adult language profile',
        Math.round(cps * 100) / 100,
        profile.maxCharactersPerSecond,
      );
    if (cue.start < previousEnd)
      warn('overlap', 'Cue overlaps an earlier subtitle; timing was preserved');
    previousEnd = Math.max(previousEnd, cue.end);
    if (/[{}\\]/u.test(visibleText(cue.text)))
      warn(
        'ass_literal_characters',
        'ASS uses libass-compatible escapes for literal braces/backslashes; check your player',
      );
  }
  return {
    profile,
    cues: cues.length,
    warnings,
    timingChanged: false,
    note: 'Automatic layout and adult readability checks only. Dialogue, cue IDs and timings are preserved. Check linguistic line breaks, shot changes, frame gaps and on-screen text manually. Other languages use a generic 20 CPS fallback. ASS uses centisecond precision; SRT retains exact milliseconds.',
  };
}

export function formatSubtitleDocument(source: string, language = 'en') {
  const cues = parseSrt(source).map((cue) => ({ ...cue, text: wrapSubtitle(cue.text, language) }));
  const blocks = source
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n(?:[ \t]*\n)+/);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const srt =
    (source.startsWith('\uFEFF') ? '\uFEFF' : '') +
    cues
      .map((cue, i) => [...blocks[i].split('\n').slice(0, 2), cue.text].join('\n'))
      .join('\n\n')
      .replace(/\n/g, newline) +
    newline;
  return { srt, cues, report: subtitleStyleReport(cues, language) };
}

function assTime(centiseconds: number) {
  const hours = Math.floor(centiseconds / 360000);
  return `${hours}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
}

function assText(text: string) {
  return text
    .split(markup)
    .map((part, index) => {
      if (index % 2) {
        const tag = part.match(/^<(\/)?(i|b|u)\s*>$/i);
        // Font/color overrides are omitted so the chosen visual style stays consistent.
        return tag ? `{\\${tag[2].toLowerCase()}${tag[1] ? 0 : 1}}` : '';
      }
      // Match FFmpeg's literal-text strategy: break control sequences with a word
      // joiner, and use libass's escaped opening brace plus an empty override block.
      return decodeEntities(part)
        .replace(/\\/g, '\\\u2060')
        .replace(/\{/g, '\\{{}')
        .replace(/\n/g, '\\N');
    })
    .join('');
}

export function subtitlesToAss(cues: Segment[]) {
  const header = `[Script Info]
Title: Yesilcam Revival - Netflix-inspired subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: None

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Netflix,Arial,54,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2.5,0.8,2,100,100,54,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  return (
    header +
    cues
      .map((cue) => {
        const start = Math.round(cue.start * 100);
        // ASS has 10ms resolution; retain even flagged sub-centisecond native cues.
        const end = Math.max(start + 1, Math.round(cue.end * 100));
        return `Dialogue: 0,${assTime(start)},${assTime(end)},Netflix,,0,0,0,,${assText(cue.text)}`;
      })
      .join('\n') +
    '\n'
  );
}
