import type { RequestState } from '../../types/checkpoints.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { at, jobId, readJson, writeJson } from './files.js';
import { acquireProcessLock } from './process-identity.js';

export async function inspectRequests(id: string) {
  const dir = at('output', 'raw_transcriptions', jobId(id));
  const files = await fs.readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return Promise.all(
    files
      .filter((file) => /^chunk_[a-zA-Z0-9_-]+\.request\.json$/.test(file))
      .map(async (file) => {
        const state = await readJson(path.join(dir, file));
        return Object.fromEntries(
          [
            'chunkId',
            'provider',
            'model',
            'status',
            'requestId',
            'remoteId',
            'estimate',
            'error',
          ].map((name) => [name, state[name]]),
        );
      }),
  );
}
export async function reconcileRequest(
  id: string,
  chunk: string,
  options: {
    remoteId?: string;
    allowNewRequest?: boolean;
    note?: string;
  },
) {
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(chunk))
    throw Object.assign(new Error('Invalid chunk ID'), { status: 400 });
  if (
    options.remoteId !== undefined &&
    (typeof options.remoteId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(options.remoteId))
  )
    throw Object.assign(new Error('Invalid provider transcript ID'), { status: 400 });
  if (options.remoteId && options.allowNewRequest)
    throw Object.assign(new Error('Choose retrieval or a new request'), { status: 400 });
  const dir = at('output', 'raw_transcriptions', jobId(id));
  const file = path.join(dir, `chunk_${chunk}.request.json`);
  const release = await acquireProcessLock(path.join(dir, `chunk_${chunk}.request.lock`));
  try {
    const state = await readJson<RequestState>(file);
    if (options.remoteId) {
      if (
        !['elevenlabs', 'assemblyai', 'speechmatics', 'gladia'].includes(state.provider) ||
        !['submitting', 'uncertain', 'accepted'].includes(state.status)
      )
        throw Object.assign(new Error('This request cannot be recovered by remote ID'), {
          status: 409,
        });
      Object.assign(state, {
        remoteId: options.remoteId,
        submissionResponse: { id: options.remoteId },
        status: 'accepted',
      });
      await writeJson(file, state);
    } else if (options.allowNewRequest) {
      if (
        typeof options.note !== 'string' ||
        !options.note.trim() ||
        !['uncertain', 'submitting', 'accepted', 'complete'].includes(state.status)
      )
        throw Object.assign(
          new Error('A reconciliation note and a potentially billed request are required'),
          { status: 400 },
        );
      state.reconciliation = {
        at: new Date().toISOString(),
        note: options.note.trim().slice(0, 2000),
        newAttemptAuthorized: true,
      };
      await writeJson(file, state);
      const stamp = Date.now();
      // Archive any normalized cache before allowing a new submission. A crash
      // here retains the old request, so it cannot accidentally charge again.
      await fs
        .rename(
          path.join(dir, `chunk_${chunk}.json`),
          path.join(dir, `chunk_${chunk}.superseded-${stamp}.json`),
        )
        .catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      await fs.rename(file, path.join(dir, `chunk_${chunk}.attempt-${stamp}.request.json`));
    }
  } finally {
    await release();
  }
}
