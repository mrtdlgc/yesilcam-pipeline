import './environment.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { identity } from './identity.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PROJECT_ROOT = existsSync(path.join(ROOT, 'package.json')) ? ROOT : path.dirname(ROOT);
export const DATA_ROOT = path.resolve(process.env.DATA_DIR || PROJECT_ROOT);
export const workspaceRoot = () =>
  identity() ? path.join(DATA_ROOT, 'accounts', identity()!.userId) : DATA_ROOT;
const persistent = new Set(['data', 'temp', 'movies', 'found', 'output', 'review-sessions']);
export const at = (...parts: string[]) =>
  path.join(
    persistent.has(parts[0]?.split('/')[0])
      ? workspaceRoot()
      : parts[0] === '.env'
        ? PROJECT_ROOT
        : ROOT,
    ...parts,
  );
export function leaf(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 220 ||
    value.startsWith('.') ||
    /[\\/\x00-\x1f\x7f]/.test(value) ||
    path.basename(value) !== value
  ) {
    throw Object.assign(new Error('Invalid filename'), { status: 400 });
  }
  return value;
}
export function jobId(value: unknown = randomUUID()): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw Object.assign(new Error('Invalid job ID'), { status: 400 });
  }
  return value;
}
export function titleSlug(title: unknown): string {
  const cleaned = String(title || 'movie')
    .normalize('NFC')
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '');
  let slug = '';
  for (const character of cleaned) {
    if (Buffer.byteLength(slug + character) > 80) break;
    slug += character;
  }
  return slug || 'movie';
}
// Validate every existing component, including the leaf: symlinks must not escape
// the intended root. Writers use atomic replacement after this check.
export async function contained(root: string, ...parts: string[]): Promise<string> {
  parts.forEach(leaf);
  const base = await fs.realpath(root);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const real = await fs.realpath(current);
      if (real !== base && !real.startsWith(base + path.sep))
        throw new Error('Path escapes its directory');
      current = real;
    } catch (error) {
      if (error.code !== 'ENOENT') throw Object.assign(error, { status: 400 });
    }
  }
  return current;
}
export async function atomicWrite(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: FileHandle | null | undefined;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
    // Persist the rename as well as the file contents before making a paid request.
    if (process.platform !== 'win32') {
      const directory = await fs.open(path.dirname(file), 'r');
      try {
        await directory.sync();
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
      } finally {
        await directory.close();
      }
    }
  } finally {
    await handle?.close();
    await fs.rm(temp, { force: true });
  }
}
const pathFields = new Set([
  'file',
  'input',
  'profileFile',
  'originalFile',
  '_original_file',
  'sourceAudio',
  'speakerContextFile',
  'editorialContextFile',
]);
export function persistentPath(file: string) {
  const relative = path.relative(DATA_ROOT, file);
  return relative &&
    !relative.startsWith('..' + path.sep) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
    ? `@data/${relative.split(path.sep).join('/')}`
    : file;
}
function portableDocument(value: unknown, decode: boolean, enabled = false, key = ''): unknown {
  if (typeof value === 'string' && enabled && pathFields.has(key)) {
    if (!decode) return path.isAbsolute(value) ? persistentPath(value) : value;
    if (value.startsWith('@data/')) {
      const parts = value.slice(6).split('/');
      parts.forEach(leaf);
      return path.join(DATA_ROOT, ...parts);
    }
  }
  if (Array.isArray(value))
    return value.map((item) => portableDocument(item, decode, enabled, key));
  if (value && typeof value === 'object') {
    enabled ||= (value as { pathSchema?: number }).pathSchema === 1;
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        name,
        portableDocument(item, decode, enabled, name),
      ]),
    );
  }
  return value;
}
export const writeJson = (file: string, value: unknown) =>
  atomicWrite(file, JSON.stringify(portableDocument(value, false), null, 2) + '\n');
// Persisted/provider JSON is validated by its owning subsystem before use.
export async function readJson<T = any>(file: string, fallback?: NoInfer<T>): Promise<T> {
  try {
    return portableDocument(JSON.parse(await fs.readFile(file, 'utf8')), true) as T;
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return structuredClone(fallback);
    throw error;
  }
}
const locks = new Map<string, Promise<unknown>>();
export function serialized<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
  const previous = locks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  const settled = next.catch(() => {});
  locks.set(key, settled);
  settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key);
  });
  return next;
}
export class JsonStore<T> {
  constructor(
    public file: string,
    public initial: T,
  ) {}
  read() {
    return serialized(this.file, () => readJson<T>(this.file, this.initial));
  }
  update<R>(change: (value: T) => R | Promise<R>): Promise<R> {
    return serialized(this.file, async () => {
      const value = await readJson<T>(this.file, this.initial);
      const before = JSON.stringify(value);
      const result = await change(value);
      if (JSON.stringify(value) !== before) await writeJson(this.file, value);
      return result;
    });
  }
}
