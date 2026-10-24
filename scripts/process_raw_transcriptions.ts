import type { PipelineOptions } from '../types/pipeline.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { at, readJson, jobId } from './lib/files.js';
import { postprocessRecords } from './pipeline.js';
import { segmentsToSrt } from './lib/srt.js';
import { writeSubtitleArtifacts } from './lib/subtitle-export.js';

// A raw response alone is insufficient: chunk IDs are not array offsets.
// Require the exact job manifest and every retained chunk's response.
export async function processRawTranscriptions(id: any, options: PipelineOptions = {}) {
  jobId(id);
  const manifest = await readJson(at('temp', id, 'manifest.json'), null);
  if (!manifest?.chunks?.length)
    throw new Error('Job manifest with original chunk offsets is required');
  const records = [];
  for (const chunk of manifest.chunks) {
    const raw = await readJson(
      at('output', 'raw_transcriptions', id, `chunk_${chunk.id}.json`),
      null,
    );
    if (
      !raw ||
      raw.chunk.id !== chunk.id ||
      raw.chunk.startTime !== chunk.startTime ||
      raw.chunk.endTime !== chunk.endTime
    ) {
      throw new Error(`Missing or mismatched raw transcription for chunk ${chunk.id}`);
    }
    records.push({
      chunk,
      segments: raw.response.segments,
      runtime: raw.response._runtime,
      language: raw.response.language,
    });
  }
  const segments = await postprocessRecords(records, manifest, options);
  const output = at('output', 'subtitles', `${id}_recovered.srt`);
  await writeSubtitleArtifacts(
    output,
    segmentsToSrt(segments),
    manifest.settings.DEFAULT_LANGUAGE,
    at('output', 'reviews', `${id}-recovered-style.json`),
  );
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2])
    throw new Error('Usage: node build/scripts/process_raw_transcriptions.js <job-id>');
  console.log(await processRawTranscriptions(process.argv[2]));
}
