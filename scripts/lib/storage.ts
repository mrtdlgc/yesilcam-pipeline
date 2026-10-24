import fs from 'node:fs/promises';
import path from 'node:path';
import { at, serialized } from './files.js';
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

let snapshot: Promise<{ temporaryBytes: number; availableBytes: number }> | undefined;
let snapshotAt = 0;
export function storageStatus() {
  if (!snapshot || Date.now() - snapshotAt > 10000) {
    snapshotAt = Date.now();
    snapshot = Promise.all([directoryBytes(at('temp')), fs.statfs(at('temp'))]).then(
      ([temporaryBytes, disk]) => ({ temporaryBytes, availableBytes: disk.bavail * disk.bsize }),
    );
    void snapshot.catch(() => {
      snapshot = undefined;
    });
  }
  return snapshot;
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
