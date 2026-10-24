import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Settings } from '../../types/pipeline.js';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { at } from './files.js';
import {
  WHISPER_PYTHON,
  whisperEnv,
  childEnvironment,
  terminate,
  abortError,
  checkAbort,
  trackChild,
} from './process.js';

// Owned by one job, with one in-flight request and explicit correlation IDs.
export class WhisperWorker {
  settings: Settings;
  signal?: AbortSignal;
  child: ChildProcessWithoutNullStreams | null;
  pending: {
    id: string;
    resolve: (response: any) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null;
  buffer: string;
  tail: Promise<unknown>;
  exit?: Promise<void>;
  abort: () => void = () => {};
  runtime: any;
  constructor(settings: Settings, signal?: AbortSignal) {
    this.settings = settings;
    this.signal = signal;
    this.child = null;
    this.pending = null;
    this.buffer = '';
    this.tail = Promise.resolve();
  }
  async start() {
    checkAbort(this.signal);
    if (this.child) throw new Error('Worker already started');
    const child = (this.child = trackChild(
      spawn(WHISPER_PYTHON(), [at('scripts', 'whisper_worker.py')], {
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnvironment(whisperEnv(this.settings)),
      }),
    ));
    this.exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
    child.stdin.on('error', (error) => this.fail(error));
    child.stderr.on('data', (data) => process.stderr.write(data));
    const decoder = new StringDecoder('utf8');
    child.stdout.on('data', (data) => {
      this.buffer += decoder.write(data);
      if (this.buffer.length > 2 * 1024 * 1024) {
        this.fail(new Error('Whisper response exceeds limit'));
        return;
      }
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (
            !this.pending ||
            (this.pending.id === 'ready'
              ? response.status !== 'ready'
              : response.id !== this.pending.id)
          ) {
            throw new Error(response.error || 'Unexpected Whisper response ID');
          }
          const pending = this.pending;
          this.pending = null;
          clearTimeout(pending.timer);
          response.error ? pending.reject(new Error(response.error)) : pending.resolve(response);
        } catch (error) {
          this.fail(error);
        }
      }
    });
    child.once('error', (error) => this.fail(error));
    child.once('close', (code) => {
      this.fail(new Error(`Whisper worker exited (${code})`), false);
      this.child = null;
    });
    this.abort = () => this.fail(abortError());
    this.signal?.addEventListener('abort', this.abort, { once: true });
    const ready = this.waitFor('ready', this.settings.WORKER_START_TIMEOUT_MS);
    if (this.signal?.aborted) this.abort();
    this.runtime = (await ready).runtime;
  }
  waitFor(id: string, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      this.pending = {
        id,
        resolve,
        reject,
        timer: setTimeout(
          () => this.fail(new Error(`Whisper ${id === 'ready' ? 'startup' : 'request'} timed out`)),
          timeout,
        ),
      };
    });
  }
  fail(error: Error, kill = true) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = null;
    }
    if (kill) terminate(this.child);
  }
  transcribe(file: string, language: string | null, prompt: string | null) {
    const operation = this.tail
      .catch(() => {})
      .then(async () => {
        checkAbort(this.signal);
        if (!this.child || this.child.exitCode !== null)
          throw new Error('Whisper worker is unavailable');
        const id = randomUUID(),
          response = this.waitFor(id, this.settings.TRANSCRIPTION_TIMEOUT_MS);
        this.child.stdin.write(
          JSON.stringify({
            id,
            file,
            language,
            prompt,
            word_timestamps: this.settings.WORD_TIMESTAMPS,
          }) + '\n',
        );
        return response;
      });
    this.tail = operation;
    return operation;
  }
  async stop() {
    this.signal?.removeEventListener('abort', this.abort);
    if (!this.child) return;
    this.fail(new Error('Whisper worker stopped'), false);
    const child = this.child;
    try {
      child.stdin.end(JSON.stringify({ command: 'quit' }) + '\n');
    } catch {
      terminate(child);
    }
    const timer = setTimeout(() => terminate(child), 3000);
    try {
      await this.exit;
    } finally {
      clearTimeout(timer);
    }
  }
}
