import fs from 'node:fs/promises';
import path from 'node:path';
import { at, serialized, workspaceRoot } from './files.js';
import { config } from '../../config.js';

let reserved = 0;
export async function directoryBytes(dir: string): Promise<number> {
  let bytes = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) bytes += await directoryBytes(file);
    else if (entry.isFile())
      bytes += await fs.stat(file).then(
        (stat) => stat.size,
        (error) => {
          if (error.code === 'ENOENT') return 0; // Concurrent explicit cleanup is allowed.
          throw error;
        },
      );
  }
  return bytes;
}

const snapshots = new Map<
  string,
  {
    at: number;
    value: Promise<{
      temporaryBytes: number;
      availableBytes: number;
      screeningBytes: number;
      transcriptBytes: number;
      correctionBytes: number;
    }>;
  }
>();
export function storageStatus() {
  const key = workspaceRoot(),
    saved = snapshots.get(key);
  if (saved && Date.now() - saved.at < 10000) return saved.value;
  const value = Promise.all([
    directoryBytes(at('temp')),
    fs.statfs(at('temp')),
    directoryBytes(at('review-sessions')),
    directoryBytes(at('output', 'raw_transcriptions')),
    directoryBytes(at('data', 'subtitle-reviews')),
  ]).then(([temporaryBytes, disk, screeningBytes, transcriptBytes, correctionBytes]) => ({
    temporaryBytes,
    availableBytes: disk.bavail * disk.bsize,
    screeningBytes,
    transcriptBytes,
    correctionBytes,
  }));
  if (snapshots.size >= 1000) snapshots.delete(snapshots.keys().next().value!);
  snapshots.set(key, { at: Date.now(), value });
  void value.catch(() => {
    if (snapshots.get(key)?.value === value) snapshots.delete(key);
  });
  return value;
}

export async function withTempBudget(bytes: number, action: any, settings = config) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('Invalid storage reservation');
  await fs.mkdir(at('temp'), { recursive: true });
  await serialized('temporary-storage-budget', async () => {
    const used = await directoryBytes(at('temp'));
    const disk = await fs.statfs(at('temp'));
    if (
      used + reserved + bytes > settings.MAX_TEMP_BYTES ||
      disk.bavail * disk.bsize - reserved - bytes < settings.MIN_FREE_DISK_BYTES
    ) {
      throw Object.assign(
        new Error(
          'Insufficient temporary storage budget. Clean completed job intermediates or raise MAX_TEMP_BYTES.',
        ),
        { status: 507 },
      );
    }
    reserved += bytes;
  });
  try {
    return await action();
  } finally {
    await serialized('temporary-storage-budget', async () => {
      reserved -= bytes;
    });
  }
}
