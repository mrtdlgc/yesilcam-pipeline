import fs from 'node:fs/promises';

interface ProcessIdentity {
  version: 2;
  pid: number;
  boot: string;
  start: string;
}
async function linuxIdentity(pid: number): Promise<ProcessIdentity> {
  const [stat, boot] = await Promise.all([
    fs.readFile(`/proc/${pid}/stat`, 'utf8'),
    fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
  ]);
  // comm (field 2) can contain spaces and parentheses; fields after it start at 3.
  const fields = stat
    .slice(stat.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Cannot identify request owner');
  return { version: 2, pid, boot: boot.trim(), start: fields[19] };
}
export async function processLockContents(): Promise<string> {
  return JSON.stringify(await linuxIdentity(process.pid)) + '\n';
}
export async function processLockIsLive(contents: string): Promise<boolean> {
  const record: unknown = JSON.parse(contents);
  const pid = typeof record === 'number' ? record : (record as ProcessIdentity)?.pid;
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error('Invalid request lock; inspect it manually');
  // Legacy locks contain only a PID; retain their conservative live-PID rule.
  if (typeof record === 'number') {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code !== 'ESRCH';
    }
  }
  const identity = record as ProcessIdentity;
  if (
    identity.version !== 2 ||
    typeof identity.boot !== 'string' ||
    typeof identity.start !== 'string'
  )
    throw new Error('Invalid request lock identity');
  try {
    const current = await linuxIdentity(pid);
    return current.boot === identity.boot && current.start === identity.start;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    throw error; // Permission/read errors never authorize unlocking.
  }
}
