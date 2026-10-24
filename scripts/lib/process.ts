import './environment.js';
import { spawn } from 'node:child_process';
import { setPriority } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcess } from 'node:child_process';
import type { Settings } from '../../types/pipeline.js';

export const PYTHON =
  process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
export const WHISPER_PYTHON = () =>
  process.env.WHISPER_PYTHON_BIN || process.env.PYTHON_BIN || PYTHON;
const children = new Set<ChildProcess>();
export function trackChild<T extends ChildProcess>(child: T): T {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}
export function terminateChildren() {
  for (const child of children) terminate(child);
}
process.once('exit', terminateChildren);
export function abortError() {
  return Object.assign(new Error('Job cancelled'), { name: 'AbortError' });
}
export function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw abortError();
}
export function childEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const name of Object.keys(env))
    if (/API_KEY|MASTER_KEY|TOKEN|PASSWORD|SECRET|YOUTUBE_COOKIES/i.test(name)) delete env[name];
  return env;
}
export function terminate(child?: ChildProcess | null) {
  if (!child?.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}
export interface RunOptions {
  signal?: AbortSignal;
  timeout?: number;
  maxOutput?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  priority?: number;
  input?: string | Uint8Array;
  onStderr?: (message: string) => void;
  onStdout?: (chunk: Buffer) => void;
}
export function run(
  command: string,
  args: (string | number)[],
  {
    signal,
    timeout = 120000,
    maxOutput = 16 * 1024 * 1024,
    onStderr,
    env = {},
    cwd,
    input,
    onStdout,
    priority,
  }: RunOptions = {},
): Promise<{ stdout: string; stderr: string }> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    // Every media input is local. Playlists must never open network protocols.
    if (['ffmpeg', 'ffprobe'].includes(command)) {
      const restricted: (string | number)[] = [];
      for (const arg of args) {
        if (arg === '-i') restricted.push('-protocol_whitelist', 'file,pipe');
        restricted.push(arg);
      }
      if (command === 'ffprobe') restricted.unshift('-protocol_whitelist', 'file,pipe');
      args = restricted;
    }
    const child = trackChild(
      spawn(command, args.map(String), {
        shell: false,
        cwd,
        env: childEnvironment(env),
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    if (priority !== undefined && child.pid) {
      try {
        setPriority(child.pid, priority);
      } catch {}
    }
    let stdout = '',
      stderr = '',
      failure: unknown,
      size = 0;
    const decoder = new StringDecoder('utf8'),
      errorDecoder = new StringDecoder('utf8');
    const stop = (error: any) => {
      failure ||= error;
      terminate(child);
    };
    const abort = () => stop(abortError());
    const timer = setTimeout(
      () => stop(new Error(`${command} exceeded its ${Math.round(timeout / 1000)}s deadline`)),
      timeout,
    );
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      if (onStdout) {
        try {
          onStdout(chunk);
        } catch (error) {
          stop(error);
        }
      } else {
        size += chunk.length;
        if (size > maxOutput) stop(new Error(`${command} returned too much output`));
        else stdout += decoder.write(chunk);
      }
    });
    child.stderr.on('data', (chunk) => {
      const message = errorDecoder.write(chunk);
      stderr = (stderr + message).slice(-65536);
      try {
        onStderr?.(message);
      } catch (error) {
        stop(error);
      }
    });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') stop(error);
    });
    child.stdin.end(input);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      stdout += decoder.end();
      stderr += errorDecoder.end();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`));
      else resolve({ stdout, stderr });
    });
    if (signal?.aborted) abort();
  });
}
export async function probe(file: string, options: RunOptions = {}) {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
    { timeout: 30000, ...options },
  );
  const data = JSON.parse(stdout);
  const duration = Number(data.format?.duration);
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !data.streams?.some((s: any) => s.codec_type === 'audio')
  ) {
    throw new Error('The input must contain audio with a finite, positive duration');
  }
  return { ...data, duration };
}
export function pythonEnv(config: Settings): NodeJS.ProcessEnv {
  return {
    PYTHONIOENCODING: 'utf-8',
    WHISPER_MODEL: config.LOCAL_WHISPER_MODEL,
    WHISPER_DEVICE: config.LOCAL_WHISPER_DEVICE,
    WHISPER_COMPUTE_TYPE: config.LOCAL_WHISPER_COMPUTE_TYPE,
    WHISPER_CPU_THREADS: String(config.LOCAL_WHISPER_CPU_THREADS),
    WHISPER_WORKERS: String(config.LOCAL_WHISPER_WORKERS),
    OMP_NUM_THREADS: String(config.LOCAL_WHISPER_CPU_THREADS || 2),
  };
}
export function whisperEnv(config: Settings) {
  const env = pythonEnv(config);
  if (process.env.WHISPER_LIBRARY_PATH) env.LD_LIBRARY_PATH = process.env.WHISPER_LIBRARY_PATH;
  return env;
}
