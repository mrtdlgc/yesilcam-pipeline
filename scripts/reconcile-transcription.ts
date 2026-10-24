import { processLockContents, processLockIsLive } from './lib/process-identity.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { at, jobId, readJson, writeJson } from './lib/files.js';

const { values: args } = parseArgs({
  options: {
    job: { type: 'string' },
    chunk: { type: 'string' },
    'allow-new-request': { type: 'boolean' },
    'remote-id': { type: 'string' },
    note: { type: 'string' },
    unlock: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});
if (args.help || !args.job || !args.chunk) {
  console.log(
    'Usage: node build/scripts/reconcile-transcription.js --job ID --chunk ID [--unlock] [--remote-id PROVIDER_JOB_ID | --allow-new-request --note "dashboard checked; accept another charge"]\nDefault: inspect request status only. Stop the affected job/comparison before changing its checkpoint.',
  );
  process.exit(args.help ? 0 : 1);
}
const dir = at('output', 'raw_transcriptions', jobId(args.job));
if (!/^[a-zA-Z0-9_-]{1,60}$/.test(args.chunk)) throw new Error('Invalid chunk ID');
const file = path.join(dir, `chunk_${args.chunk}.request.json`),
  lockFile = path.join(dir, `chunk_${args.chunk}.request.lock`);
let state = await readJson(file);
console.log(
  JSON.stringify(
    {
      provider: state.provider,
      model: state.model,
      status: state.status,
      requestId: state.requestId,
      remoteId: state.remoteId,
      estimate: state.estimate,
      error: state.error,
    },
    null,
    2,
  ),
);
if (!args.unlock && !args['remote-id'] && !args['allow-new-request']) process.exit(0);
if (args['remote-id'] && args['allow-new-request'])
  throw new Error('Choose resuming a remote job or allowing a new request');
const queue = await readJson(at('data', 'processing-queue.json'), { jobs: [] });
if (queue.jobs.some((j: any) => j.id === args.job && ['queued', 'processing'].includes(j.status)))
  throw new Error('Cancel the queued/active job before reconciling');
try {
  const alive = await processLockIsLive(await fs.readFile(lockFile, 'utf8'));
  if (alive) throw new Error('A live process still owns this request');
  if (!args.unlock)
    throw new Error('Stale request lock; add --unlock after checking the process has stopped');
  await fs.unlink(lockFile);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const lock = await fs.open(lockFile, 'wx', 0o600);
await lock.writeFile(await processLockContents());
try {
  state = await readJson(file);
  if (args['remote-id']) {
    if (
      !['assemblyai', 'speechmatics', 'gladia'].includes(state.provider) ||
      !['submitting', 'uncertain'].includes(state.status)
    )
      throw new Error('Remote IDs can only recover uncertain asynchronous submissions');
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(args['remote-id']))
      throw new Error('Invalid provider job ID');
    state.submissionResponse = { id: args['remote-id'] };
    state.remoteId = args['remote-id'];
    state.status = 'accepted';
    await writeJson(file, state);
    console.log(
      'Existing remote job attached. Retry will poll it without a new transcription submission.',
    );
  } else if (args['allow-new-request']) {
    if (
      !args.note?.trim() ||
      !['uncertain', 'submitting', 'accepted', 'complete'].includes(state.status)
    )
      throw new Error(
        'A reconciliation note and an existing potentially billed request are required',
      );
    state.reconciliation = {
      at: new Date().toISOString(),
      note: args.note.slice(0, 2000),
      newAttemptAuthorized: true,
    };
    await writeJson(file, state);
    await fs.rename(file, path.join(dir, `chunk_${args.chunk}.attempt-${Date.now()}.request.json`));
    const raw = path.join(dir, `chunk_${args.chunk}.json`);
    try {
      await fs.rename(raw, path.join(dir, `chunk_${args.chunk}.superseded-${Date.now()}.json`));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.log(
      'Prior evidence retained. The next retry may submit and charge again; its estimate includes the archived attempt.',
    );
  }
} finally {
  await lock.close();
  await fs.rm(lockFile, { force: true });
}
