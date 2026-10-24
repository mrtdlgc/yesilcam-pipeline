import fs from 'node:fs/promises';
import { at, contained, jobId, readJson, serialized, writeJson } from './files.js';
import { subtitleHash } from './speakers.js';
import { segmentsToSrt, formatTimestamp } from './srt.js';
import { subtitleDocument } from './codex-translation.js';
import { subtitleStyleReport, subtitlesToAss } from './subtitle-style.js';

export interface ReviewCue {
  id: string;
  start: number;
  end: number;
  startTime: string;
  endTime: string;
  texts: Record<string, string>;
  speaker: string;
  warnings: string[];
  note: string;
  flagged: boolean;
  omitted: boolean;
}
export interface SubtitleReview {
  version: 2;
  id: string;
  title: string;
  sourceHash: string;
  targetHash: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  languages: string[];
  duration: number;
  media: string | null;
  mediaMessage: string;
  revision: number;
  position: number;
  updatedAt: string;
  cues: ReviewCue[];
  original: ReviewCue[];
}
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}
const key = (id: string) => `subtitle-review:${jobId(id)}`;
async function filename(id: string) {
  const root = at('data', 'subtitle-reviews');
  await fs.mkdir(root, { recursive: true });
  return contained(root, `${jobId(id)}.json`);
}
export async function readSubtitleReview(id: string): Promise<SubtitleReview> {
  const document = await readJson<SubtitleReview>(await filename(id));
  if (document.version !== 2 || document.id !== id) fail(409, 'Unsupported subtitle review');
  const saved = await readJson<{ position: number } | null>(
    at('data', 'subtitle-review-positions', `${jobId(id)}.json`),
    null,
  );
  if (saved && Number.isFinite(saved.position))
    document.position = Math.max(0, Math.min(document.duration, saved.position));
  return document;
}
export async function createSubtitleReview(input: {
  id: string;
  title: string;
  source: string;
  target?: string;
  sourceLanguage: string;
  targetLanguage: string;
  duration: number;
  media: string | null;
  mediaMessage?: string;
  speakers?: Record<string, string>;
  warnings?: Record<string, string[]>;
  omissions?: Record<string, boolean>;
}) {
  return serialized(key(input.id), async () => {
    const file = await filename(input.id);
    const existing = await readJson<SubtitleReview | null>(file, null);
    const sourceHash = subtitleHash(input.source);
    const targetHash = input.target ? subtitleHash(input.target) : null;
    if (existing) {
      if (existing.sourceHash !== sourceHash || existing.targetHash !== targetHash)
        fail(
          409,
          'This screening already has a different source. Preserve its edits and use a new job.',
        );
      if (!existing.media && input.media) {
        existing.media = input.media;
        existing.mediaMessage = '';
        existing.revision++;
        await writeJson(file, existing);
      }
      return existing; // A retry must never replace human corrections.
    }
    const source = subtitleDocument(input.source).cues;
    const target = input.target ? subtitleDocument(input.target).cues : null;
    if (source.length > 10000) fail(400, 'Review supports at most 10,000 cues per film');
    const languages = [
      ...new Set([input.sourceLanguage, ...(target ? [input.targetLanguage] : [])]),
    ];
    if (languages.some((language) => !/^[a-z]{2,3}$/.test(language)))
      fail(400, 'Invalid subtitle language');
    if (
      target &&
      (target.length !== source.length ||
        target.some(
          (cue, i) =>
            cue.id !== source[i].id || cue.start !== source[i].start || cue.end !== source[i].end,
        ))
    )
      fail(409, 'Source and translation must have matching cue IDs and timings for paired review');
    const cues = source.map((cue, index): ReviewCue => ({
      id: cue.id,
      start: cue.start,
      end: cue.end,
      startTime: cue.startTime,
      endTime: cue.endTime,
      texts: {
        [input.sourceLanguage]: cue.text,
        ...(target ? { [input.targetLanguage]: target[index].text } : {}),
      },
      speaker: input.speakers?.[cue.id] ?? '',
      warnings: input.warnings?.[cue.id] ?? [],
      note: '',
      flagged: false,
      omitted: input.omissions?.[cue.id] === true,
    }));
    const document: SubtitleReview = {
      version: 2,
      id: jobId(input.id),
      title: input.title,
      sourceHash,
      targetHash,
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      languages,
      duration: Math.max(input.duration || 0, ...source.map((cue) => cue.end)),
      media: input.media,
      mediaMessage: input.mediaMessage ?? '',
      revision: 0,
      position: 0,
      updatedAt: new Date().toISOString(),
      cues,
      original: structuredClone(cues),
    };
    await writeJson(file, document);
    return document;
  });
}

function segments(document: SubtitleReview, language: string, original = false) {
  if (!document.languages.includes(language)) fail(404, 'Subtitle language not found');
  const cues = (original ? document.original : document.cues)
    .filter((cue) => !cue.omitted)
    .map((cue) => ({ ...cue, text: cue.texts[language] }));
  return original ? cues : cues.sort((a, b) => a.start - b.start || Number(a.id) - Number(b.id));
}
export function reviewExport(
  document: SubtitleReview,
  language: string,
  format: string,
  original = false,
) {
  const cues = segments(document, language, original);
  if (format === 'srt')
    return segmentsToSrt(cues, { preserveIds: original, preserveTimestamps: true });
  if (format === 'ass') return subtitlesToAss(cues);
  if (format === 'vtt')
    return (
      'WEBVTT\n\n' +
      cues
        .map(
          (cue, index) =>
            `${original ? cue.id : index + 1}\n${formatTimestamp(cue.start).replace(',', '.')} --> ${formatTimestamp(cue.end).replace(',', '.')}\n${cue.text}`,
        )
        .join('\n\n') +
      '\n'
    );
  if (format === 'json') return JSON.stringify(subtitleStyleReport(cues, language), null, 2) + '\n';
  return fail(404, 'Unknown subtitle export format');
}
export function reviewView(document: SubtitleReview) {
  const warnings = new Map<string, Set<string>>();
  for (const language of document.languages)
    for (const item of subtitleStyleReport(segments(document, language), language).warnings) {
      const set = warnings.get(item.id) ?? new Set<string>();
      set.add(`${language}: ${item.code}`);
      warnings.set(item.id, set);
    }
  const original = new Map(document.original.map((cue) => [cue.id, cue]));
  return {
    ...document,
    cues: document.cues
      .map((cue) => ({
        ...cue,
        warnings: [...new Set([...cue.warnings, ...(warnings.get(cue.id) ?? [])])],
        changed: JSON.stringify(cue) !== JSON.stringify(original.get(cue.id)),
      }))
      .sort((a, b) => a.start - b.start || Number(a.id) - Number(b.id)),
  };
}
function text(value: unknown, limit: number, label: string, empty = false) {
  if (
    typeof value !== 'string' ||
    value.length > limit ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  )
    fail(400, `Invalid ${label}`);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (!empty && (!normalized || /\n[ \t]*\n/.test(normalized)))
    fail(400, `${label} must contain text without blank lines`);
  if (label === 'subtitle text') {
    // Match the exporter's supported markup, without accepting script/HTML injection.
    const stack: string[] = [];
    for (const tag of normalized.match(/<[^>]*>/g) ?? []) {
      const match = tag.match(/^<(\/)?(i|b|u)>$/i);
      if (!match) fail(400, 'Use only balanced <i>, <b> or <u> subtitle markup');
      const name = match[2].toLowerCase();
      if (match[1]) {
        if (stack.pop() !== name) fail(400, 'Unbalanced subtitle markup');
      } else stack.push(name);
    }
    if (stack.length) fail(400, 'Unbalanced subtitle markup');
  }
  return normalized;
}
function time(value: unknown, duration: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > duration + 0.1)
    fail(400, 'Cue timing must be within the film');
  return Math.round(value * 1000) / 1000;
}
export async function editSubtitleReview(id: string, input: any) {
  return serialized(key(id), async () => {
    const document = await readSubtitleReview(id);
    if (!Number.isInteger(input?.revision) || input.revision !== document.revision)
      fail(409, 'This screening changed in another tab. Reload before applying your saved draft.');
    if (input.edits === undefined && input.shift === undefined && input.add === undefined)
      fail(400, 'No subtitle changes supplied');
    const changed = structuredClone(document);
    const cues = new Map(changed.cues.map((cue) => [cue.id, cue]));
    if (input.edits !== undefined) {
      if (!Array.isArray(input.edits) || input.edits.length > 10000) fail(400, 'Invalid cue edits');
      const seen = new Set<string>();
      for (const edit of input.edits) {
        const cue = cues.get(edit?.id);
        if (!cue || seen.has(cue.id)) fail(400, 'Unknown or repeated cue ID');
        seen.add(cue.id);
        if (edit.reset === true) {
          const baseline = document.original.find((entry) => entry.id === cue.id);
          if (!baseline) fail(400, 'New cues have no generated original; omit the cue instead');
          Object.assign(cue, structuredClone(baseline));
          continue;
        }
        if (
          Object.keys(edit).some(
            (name) => !['id', 'texts', 'start', 'end', 'note', 'flagged', 'omitted'].includes(name),
          )
        )
          fail(400, 'Unknown cue edit field');
        if (edit.texts !== undefined) {
          if (!edit.texts || typeof edit.texts !== 'object' || Array.isArray(edit.texts))
            fail(400, 'Invalid subtitle texts');
          for (const [language, value] of Object.entries(edit.texts)) {
            if (!document.languages.includes(language)) fail(400, 'Unknown subtitle language');
            cue.texts[language] = text(value, 8000, 'subtitle text');
          }
        }
        if (edit.start !== undefined) {
          cue.start = time(edit.start, document.duration);
          cue.startTime = formatTimestamp(cue.start);
        }
        if (edit.end !== undefined) {
          cue.end = time(edit.end, document.duration);
          cue.endTime = formatTimestamp(cue.end);
        }
        if (cue.end <= cue.start) fail(400, 'Cue end must be after its start');
        if (edit.note !== undefined) cue.note = text(edit.note, 4000, 'review note', true);
        for (const field of ['flagged', 'omitted'] as const) {
          if (edit[field] !== undefined) {
            if (typeof edit[field] !== 'boolean') fail(400, `Invalid ${field} value`);
            cue[field] = edit[field];
          }
        }
      }
    }
    if (input.shift !== undefined) {
      const shift = input.shift;
      const ordered = [...changed.cues].sort(
        (a, b) => a.start - b.start || Number(a.id) - Number(b.id),
      );
      const first = ordered.findIndex((cue) => cue.id === shift?.fromId);
      const last = ordered.findIndex((cue) => cue.id === shift?.toId);
      if (
        first < 0 ||
        last < first ||
        typeof shift.seconds !== 'number' ||
        !Number.isFinite(shift.seconds) ||
        Math.abs(shift.seconds) > 3600
      )
        fail(400, 'Choose a valid cue range and offset of at most one hour');
      for (const cue of ordered.slice(first, last + 1)) {
        cue.start = time(cue.start + shift.seconds, document.duration);
        cue.end = time(cue.end + shift.seconds, document.duration);
        cue.startTime = formatTimestamp(cue.start);
        cue.endTime = formatTimestamp(cue.end);
      }
    }
    if (input.add !== undefined) {
      if (changed.cues.length >= 10000) fail(400, 'Review cue limit reached');
      const added = input.add;
      const start = time(added?.start, document.duration),
        end = time(added?.end, document.duration);
      if (end <= start) fail(400, 'Cue end must be after its start');
      const texts = Object.fromEntries(
        document.languages.map((language) => [
          language,
          text(added?.texts?.[language], 8000, 'subtitle text'),
        ]),
      );
      changed.cues.push({
        id: String(Math.max(...changed.cues.map((cue) => Number(cue.id))) + 1),
        start,
        end,
        startTime: formatTimestamp(start),
        endTime: formatTimestamp(end),
        texts,
        speaker: '',
        warnings: [],
        note: '',
        flagged: false,
        omitted: false,
      });
    }
    if (!changed.cues.some((cue) => !cue.omitted)) fail(400, 'Keep at least one subtitle cue');
    // One durable commit is the source of every SRT/ASS/VTT export; no half-written language pair.
    for (const language of changed.languages)
      subtitleDocument(reviewExport(changed, language, 'srt'));
    if (JSON.stringify(changed.cues) !== JSON.stringify(document.cues)) {
      changed.revision++;
      changed.updatedAt = new Date().toISOString();
      await writeJson(await filename(id), changed);
    }
    return changed;
  });
}
export async function saveReviewPosition(id: string, position: unknown) {
  return serialized(key(id), async () => {
    const document = await readSubtitleReview(id);
    await writeJson(at('data', 'subtitle-review-positions', `${jobId(id)}.json`), {
      position: time(position, document.duration),
    });
  });
}

export async function removeScreeningCopy(id: string) {
  return serialized(key(id), async () => {
    const document = await readSubtitleReview(id);
    if (document.media)
      await fs.rm(await contained(at('review-sessions'), jobId(id), document.media), {
        force: true,
      });
    document.media = null;
    document.mediaMessage =
      'Screening copy removed to free space. Select a local film or prepare the screening again.';
    document.revision++;
    await writeJson(await filename(id), document);
    await fs.rm(at('data', 'subtitle-review-media', `${jobId(id)}.json`), { force: true });
  });
}
