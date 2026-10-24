import { createHash } from 'node:crypto';
import { at, jobId, readJson, serialized, writeJson } from './files.js';
import type { Job, QueueState, Settings } from '../../types/pipeline.js';

// One server owns the volume. Keep its hot state in memory, small progress records
// in the queue, and bounded logs in per-job files. Preserve the original defaults
// in the queue so a config change cannot change old jobs on restart.
export class QueueStore {
  private value?: QueueState;
  private defaults?: Settings;
  private logHashes = new Map<string, string>();
  constructor(
    public file: string,
    public initial: QueueState,
  ) {}
  private async load() {
    if (this.value) return this.value;
    const stored = await readJson<QueueState & { settingsDefaults?: Settings }>(
      this.file,
      this.initial,
    );
    this.defaults = stored.settingsDefaults;
    for (const job of stored.jobs) {
      if (this.defaults) job.settings = { ...this.defaults, ...job.settings };
      if (!job.logs) job.logs = await readJson(at('data', 'job-logs', `${jobId(job.id)}.json`), []);
    }
    delete stored.settingsDefaults;
    return (this.value = stored);
  }
  read(): Promise<QueueState> {
    return serialized(this.file, async () => structuredClone(await this.load()));
  }
  update<R>(change: (state: QueueState) => R | Promise<R>): Promise<R> {
    return serialized(this.file, async () => {
      const prior = await this.load();
      const state = structuredClone(prior);
      const result = await change(state);
      this.defaults ??= state.jobs[0]?.settings;
      const jobs = [];
      for (const job of state.jobs) {
        const logs = JSON.stringify(job.logs ?? []);
        const hash = createHash('sha256').update(logs).digest('hex');
        if (this.logHashes.get(job.id) !== hash) {
          await writeJson(at('data', 'job-logs', `${jobId(job.id)}.json`), job.logs ?? []);
          this.logHashes.set(job.id, hash);
        }
        const { logs: _logs, settings, ...summary } = job;
        jobs.push({
          ...summary,
          settings: Object.fromEntries(
            Object.entries(settings).filter(
              ([key, value]) =>
                JSON.stringify(value) !== JSON.stringify(this.defaults?.[key as keyof Settings]),
            ),
          ),
        });
      }
      if (JSON.stringify(prior) !== JSON.stringify(state) || !this.value?.jobs.length)
        await writeJson(this.file, { ...state, settingsDefaults: this.defaults, jobs });
      this.value = state;
      return result;
    });
  }
}

export function progressWriter(update: (mutate: (job: Job) => void) => Promise<unknown>) {
  let last = 0;
  let pending: ((job: Job) => void)[] = [];
  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    last = Date.now();
    await update((job) => {
      for (const mutate of batch) mutate(job);
    });
  };
  return {
    async push(mutate: (job: Job) => void, urgent = false) {
      pending.push(mutate);
      if (urgent || Date.now() - last >= 1000) await flush();
    },
    flush,
  };
}
