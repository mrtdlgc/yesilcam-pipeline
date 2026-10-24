import type { PipelineOptions } from '../types/pipeline.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { leaf, contained, readJson, writeJson, atomicWrite, serialized } from './lib/files.js';
import { parseSrt, segmentsToSrt, parseTime, formatTimestamp } from './lib/srt.js';
export { parseSrt } from './lib/srt.js';

export function validTranslation(text: string) {
  return (
    typeof text === 'string' &&
    text.trim().length > 0 &&
    text.length <= 5000 &&
    !/\uFFFD|```|\n\s*\n/u.test(text) &&
    !/^(?:translation(?: here)?|translated text|translation_failed|todo|n\/a|null|undefined|\[.*translation.*\]|\.\.\.)$|^error:/iu.test(
      text.trim(),
    )
  );
}

function entriesFor(segments: any) {
  return segments.map((segment: any, i: any) => ({
    id: String(segment.id ?? i + 1),
    start: segment.startTime ?? formatTimestamp(segment.start),
    end: segment.endTime ?? formatTimestamp(segment.end),
    original: segment.text,
    translated: '',
  }));
}

export async function chunkSrtForTranslation(
  input: any,
  outputDir: string,
  baseName: any,
  options: PipelineOptions = {},
) {
  leaf(baseName);
  const settings = { ...config, ...options.settings };
  const segments = typeof input === 'string' ? parseSrt(input) : input;
  const source = entriesFor(segments);
  const sourceHash = createHash('sha256').update(JSON.stringify(source)).digest('hex');
  const manifestFile = path.join(outputDir, 'manifest.json');
  return serialized(outputDir, async () => {
    const previous = await readJson(manifestFile, null);
    if (previous) {
      if (
        previous.sourceHash !== sourceHash ||
        previous.targetLanguage !== (options.targetLanguage ?? settings.TARGET_LANGUAGE)
      ) {
        throw new Error('Translation source or target language changed; create a new run folder');
      }
      return translationPaths(outputDir, previous);
    }
    await fs.mkdir(outputDir, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < source.length; index += settings.SRT_CHUNK_SIZE) {
      const entries = source.slice(index, index + settings.SRT_CHUNK_SIZE);
      const filename = `${baseName}_chunk_${String(files.length + 1).padStart(3, '0')}.json`;
      files.push(filename);
      const metadata = {
        sourceHash,
        sourceLanguage: options.sourceLanguage ?? settings.DEFAULT_LANGUAGE,
        targetLanguage: options.targetLanguage ?? settings.TARGET_LANGUAGE,
        chunk: files.length,
      };
      await writeJson(path.join(outputDir, filename), { metadata, entries });
      await writeJson(path.join(outputDir, filename.replace('.json', '_translate.json')), {
        metadata,
        entries: entries.map(({ id, original }: Record<string, any>) => ({
          id,
          original,
          translated: '',
        })),
      });
      await atomicWrite(
        path.join(outputDir, filename.replace('.json', '.srt')),
        entriesToSrt(entries, false),
      );
    }
    const manifest = {
      version: 1,
      sourceHash,
      sourceLanguage: options.sourceLanguage ?? settings.DEFAULT_LANGUAGE,
      targetLanguage: options.targetLanguage ?? settings.TARGET_LANGUAGE,
      files,
      source,
    };
    // The manifest is the commit marker. Uploads cannot target unfinished exports.
    await writeJson(manifestFile, manifest);
    return translationPaths(outputDir, manifest);
  });
}

function translationPaths(dir: any, manifest: any) {
  return {
    dir,
    jsonFiles: manifest.files.map((file: string) => path.join(dir, file)),
    srtFiles: manifest.files.map((file: string) => path.join(dir, file.replace('.json', '.srt'))),
  };
}

function entriesToSrt(entries: any, translated: any) {
  return segmentsToSrt(
    entries.map((entry: any) => ({
      id: entry.id,
      start: parseTime(entry.start),
      end: parseTime(entry.end),
      startTime: entry.start,
      endTime: entry.end,
      text: translated ? entry.translated : entry.original,
    })),
    { preserveIds: true, preserveTimestamps: true },
  );
}

function validateEntries(incoming: any, expected: any, slim: any) {
  if (!Array.isArray(incoming) || incoming.length !== expected.length)
    throw new Error('Every cue ID must occur exactly once');
  const byId = new Map(incoming.map((entry) => [String(entry.id), entry]));
  if (byId.size !== expected.length) throw new Error('Duplicate cue IDs');
  return expected.map((original: any) => {
    const entry = byId.get(String(original.id));
    if (!entry) throw new Error(`Missing cue ${original.id}`);
    if (
      !slim &&
      (entry.start !== original.start ||
        entry.end !== original.end ||
        entry.original !== original.original)
    ) {
      throw new Error(`Cue ${original.id}: timing and source text are immutable`);
    }
    if (slim && entry.original !== undefined && entry.original !== original.original)
      throw new Error(`Cue ${original.id}: source text changed`);
    const text = slim ? (entry.translated ?? entry.text) : entry.translated;
    if (!validTranslation(text))
      throw new Error(`Cue ${original.id}: translation is empty or a placeholder`);
    return { ...original, translated: text.trim() };
  });
}

export async function importTranslation(folder: string, filename: string, data: any, slim = false) {
  leaf(filename);
  return serialized(folder, async () => {
    const manifest = await readJson(await contained(folder, 'manifest.json'));
    const canonical = slim ? filename.replace(/_translate\.json$/, '.json') : filename;
    if (!manifest.files.includes(canonical))
      throw new Error('Filename is not in this translation manifest');
    const file = await contained(folder, canonical);
    const saved = await readJson(file);
    const expected = manifest.source.filter((entry: any) =>
      saved.entries.some((item: any) => String(item.id) === String(entry.id)),
    );
    if (expected.length !== saved.entries.length)
      throw new Error('Translation manifest is inconsistent');
    if (data.metadata?.sourceHash && data.metadata.sourceHash !== manifest.sourceHash)
      throw new Error('Translation belongs to a different source');
    const entries = validateEntries(data.entries, expected, slim);
    await writeJson(file, { metadata: saved.metadata, entries });
    return { entries: entries.length };
  });
}

export async function mergeTranslatedChunks(jsonFiles: any, outputPath: string) {
  if (!jsonFiles.length) throw new Error('No translation chunks');
  const folder = path.dirname(jsonFiles[0]);
  return serialized(folder, async () => {
    const manifest = await readJson(await contained(folder, 'manifest.json'));
    if (
      jsonFiles.length !== manifest.files.length ||
      jsonFiles.some(
        (file: string, i: any) => path.resolve(file) !== path.resolve(folder, manifest.files[i]),
      )
    ) {
      throw new Error('Merge requires exactly the files in the manifest');
    }
    const incoming = [];
    for (const filename of manifest.files)
      incoming.push(...(await readJson(await contained(folder, filename))).entries);
    const entries = validateEntries(incoming, manifest.source, false);
    await atomicWrite(outputPath, entriesToSrt(entries, true));
    return outputPath;
  });
}
