import { abortError } from './process.js';

let draining = false;
const pending = new Set<Promise<unknown>>();
export function assertPaidSubmissionAllowed() {
  if (draining) throw abortError();
}
export async function trackPaidWork<T>(operation: () => Promise<T>): Promise<T> {
  const work = operation();
  pending.add(work);
  try {
    return await work;
  } finally {
    pending.delete(work);
  }
}
// Stop new submissions immediately; let already-submitted responses reach disk.
export async function drainPaidWork(graceMs: number) {
  draining = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled([...pending]),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
