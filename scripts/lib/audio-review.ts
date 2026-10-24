import fs from 'node:fs/promises';
import path from 'node:path';
import { at, contained, jobId, readJson } from './files.js';
import { fullMovie } from './transcription-mode.js';

const missing = (message: string): never => {
  throw Object.assign(new Error(message), { status: 404 });
};
async function reviewSource(id: string) {
  const root = await contained(at('temp'), jobId(id));
  const manifest = await readJson(path.join(root, 'manifest.json'), null);
  if (manifest && !manifest.originalChunks?.length && manifest.archivedOriginalChunks?.length)
    manifest.originalChunks = manifest.archivedOriginalChunks;
  if (!manifest?.originalChunks?.length)
    return missing('Audio chunks are not available yet, or were removed');
  return { root, manifest };
}
async function originalFile(root: string, chunk: { file: string }) {
  const relative = path.relative(root, path.resolve(chunk.file));
  return contained(root, ...relative.split(path.sep));
}
const separationSettings = (manifest: any) =>
  fullMovie(manifest.settings)
    ? null
    : (manifest.legacySeparation ?? (manifest.settings.DEMUCS_ENABLED ? manifest.settings : null));
async function vocalFile(root: string, chunk: { id: number }, settings: Record<string, any>) {
  const name = `chunk_${String(chunk.id).padStart(5, '0')}_vocals`;
  try {
    const file = await contained(root, 'vocals', `${name}.wav`);
    const metadata = await readJson(await contained(root, 'vocals', `${name}.json`), null);
    if (
      !metadata ||
      metadata.identity?.model !== settings.DEMUCS_MODEL ||
      metadata.identity?.shifts !== settings.DEMUCS_SHIFTS ||
      metadata.identity?.overlap !== settings.DEMUCS_OVERLAP
    )
      return null;
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== metadata.size || stat.size < 44) return null;
    return { file, sourceSha256: metadata.identity.source_sha256 };
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}
export async function audioReview(id: string) {
  const { root, manifest } = await reviewSource(id);
  const separation = separationSettings(manifest);
  const chunks = [];
  for (const chunk of manifest.originalChunks) {
    if (!Number.isInteger(chunk.id) || chunk.id < 0) throw new Error('Invalid audio chunk ID');
    const original = await originalFile(root, chunk);
    const stat = await fs.stat(original);
    const vocal = separation ? await vocalFile(root, chunk, separation) : null;
    const base = `/api/jobs/${encodeURIComponent(id)}/audio/${chunk.id}`;
    chunks.push({
      id: chunk.id,
      start: chunk.startTime,
      end: chunk.endTime,
      originalUrl: stat.isFile() ? `${base}/original` : null,
      vocalsUrl: vocal ? `${base}/vocals` : null,
      sourceSha256: vocal?.sourceSha256 ?? null,
    });
  }
  return {
    jobId: id,
    title: manifest.title,
    total: chunks.length,
    ready: chunks.filter((chunk) => chunk.vocalsUrl).length,
    originalsReady: chunks.filter((chunk) => chunk.originalUrl).length,
    chunks,
    hasVocalComparison: Boolean(separation),
    archivedVocals: Boolean(manifest.legacySeparation),
    model: separation?.DEMUCS_MODEL ?? null,
    pauseBeforeTranscription: Boolean(
      manifest.settings.PAUSE_BEFORE_TRANSCRIPTION || manifest.settings.PAUSE_AFTER_DEMUCS,
    ),
    stage: manifest.stage,
  };
}
export async function audioReviewFile(id: string, chunkId: string, variant: string) {
  if (!/^\d{1,8}$/.test(chunkId) || !['original', 'vocals'].includes(variant))
    return missing('Audio chunk not found');
  const { root, manifest } = await reviewSource(id);
  const chunk = manifest.originalChunks.find((c: { id: number }) => String(c.id) === chunkId);
  if (!chunk) return missing('Audio chunk not found');
  if (variant === 'original') return originalFile(root, chunk);
  const separation = separationSettings(manifest);
  if (!separation) return missing('There are no archived vocals for this job');
  const vocal = await vocalFile(root, chunk, separation);
  return vocal?.file ?? missing('This vocal chunk has not finished yet');
}
