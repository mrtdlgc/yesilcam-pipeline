import { inspectRequests, reconcileRequest } from './lib/request-recovery.js';
import { parseArgs } from 'node:util';
import { at, readJson } from './lib/files.js';
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
const requests = await inspectRequests(args.job);
console.log(
  JSON.stringify(
    requests.filter((request) => String(request.chunkId) === args.chunk),
    null,
    2,
  ),
);
if (!args.unlock && !args['remote-id'] && !args['allow-new-request']) process.exit(0);
const queue = await readJson(at('data', 'processing-queue.json'), { jobs: [] });
if (
  queue.jobs.some(
    (job: { id: string; status: string }) =>
      job.id === args.job && ['queued', 'processing'].includes(job.status),
  )
)
  throw new Error('Cancel the queued/active job before reconciling');
await reconcileRequest(args.job, args.chunk, {
  remoteId: args['remote-id'],
  allowNewRequest: args['allow-new-request'],
  note: args.note,
});
console.log('Reconciliation saved. Retry from Job Details; prior billing evidence is retained.');
