import './environment.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { at, atomicWrite, readJson, serialized, writeJson } from './files.js';
import { hosted, identity } from './identity.js';
import { accountDatabase, onSessionRevoked, sessionValid, SESSION_MS } from './accounts.js';

export const credentialFields = [
  ['OPENROUTER_API_KEY', 'OpenRouter', true],
  ['OPENAI_API_KEY', 'OpenAI', true],
  ['GROQ_API_KEY', 'Groq', true],
  ['MISTRAL_API_KEY', 'Mistral', true],
  ['DEEPGRAM_API_KEY', 'Deepgram', true],
  ['ASSEMBLYAI_API_KEY', 'AssemblyAI', true],
  ['ELEVENLABS_API_KEY', 'ElevenLabs', true],
  ['GEMINI_API_KEY', 'Google Gemini', true],
  ['XAI_API_KEY', 'Grok / xAI', true],
  ['SPEECHMATICS_API_KEY', 'Speechmatics', true],
  ['GLADIA_API_KEY', 'Gladia', true],
  ['TRANSCRIPTION_API_KEY', 'Custom endpoint key', true],
  ['TRANSCRIPTION_API_URL', 'Custom transcription URL', false],
  ['SPEECHMATICS_REGION', 'Speechmatics region (eu1 or us1)', false],
  ['OPENSUBTITLES_API_KEY', 'OpenSubtitles API key', true],
  ['OPENSUBTITLES_TOKEN', 'OpenSubtitles token', true],
  ['OPENSUBTITLES_USER_AGENT', 'OpenSubtitles user agent', false],
  ['YOUTUBE_COOKIES', 'YouTube cookies (Netscape format)', true],
] as const;
export type CredentialName = (typeof credentialFields)[number][0];
interface Envelope {
  iv: string;
  tag: string;
  data: string;
  updatedAt: string;
}
interface Vault {
  version: 1;
  values: Partial<Record<CredentialName, Envelope | null>>;
}
const directory = at('data', 'private');
const vaultFile = path.join(directory, 'credentials.json');
const keyFile = path.join(directory, 'master.key');
let masterKey: Buffer | undefined;
const temporary = new Map<string, { envelope: Envelope; sessionId: string; expires: number }>();
onSessionRevoked((id) => {
  for (const [key, value] of temporary) if (value.sessionId === id) temporary.delete(key);
});
const expiryTimer = setInterval(() => {
  for (const [key, value] of temporary) if (value.expires <= Date.now()) temporary.delete(key);
}, 60000);
expiryTimer.unref();
const accountScope = () => {
  const value = identity();
  if (!value)
    throw Object.assign(new Error('An account is required for this connection'), { status: 401 });
  return value;
};
export function sealConnection(name: string, text: string): Envelope {
  if (!masterKey) throw new Error('Credential encryption is not initialized');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(`${accountScope().userId}:${name}`));
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    updatedAt: new Date().toISOString(),
  };
}
function unsealConnection(name: string, value: Envelope) {
  if (!masterKey) throw new Error('Credential encryption is not initialized');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(`${accountScope().userId}:${name}`));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
export function accountConnection(
  name: string,
): { value: string; mode: 'session' | 'saved'; expires: number | null; updatedAt: string } | null {
  const scope = accountScope(),
    key = `${scope.userId}:${scope.sessionId}:${name}`;
  const value = temporary.get(key);
  if (
    value &&
    value.expires > Date.now() &&
    scope.sessionId &&
    sessionValid(scope.sessionId, scope.userId)
  )
    return {
      value: unsealConnection(name, value.envelope),
      mode: 'session',
      expires: value.expires,
      updatedAt: value.envelope.updatedAt,
    };
  temporary.delete(key);
  const row = accountDatabase()
    .prepare('SELECT envelope FROM connections WHERE user_id = ? AND name = ?')
    .get(scope.userId, name);
  if (!row) return null;
  const envelope = JSON.parse(String(row.envelope)) as Envelope;
  return {
    value: unsealConnection(name, envelope),
    mode: 'saved',
    expires: null,
    updatedAt: envelope.updatedAt,
  };
}
export function saveAccountConnection(name: string, text: string, mode: unknown = 'session') {
  if (!['session', 'saved'].includes(String(mode)))
    throw Object.assign(new Error('Choose session or saved storage'), { status: 400 });
  const scope = accountScope(),
    envelope = sealConnection(name, text);
  if (mode === 'session') {
    if (!scope.sessionId || !sessionValid(scope.sessionId, scope.userId))
      throw Object.assign(new Error('Sign in again before connecting a provider'), { status: 401 });
    // Replacing a remembered key with a temporary one must not resurrect the old key later.
    accountDatabase()
      .prepare('DELETE FROM connections WHERE user_id = ? AND name = ?')
      .run(scope.userId, name);
    if (temporary.size >= 20000)
      throw Object.assign(new Error('Temporary connection capacity reached'), { status: 429 });
    temporary.set(`${scope.userId}:${scope.sessionId}:${name}`, {
      envelope,
      sessionId: scope.sessionId,
      expires: Date.now() + SESSION_MS,
    });
  } else {
    accountDatabase()
      .prepare(
        `INSERT INTO connections VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, name) DO UPDATE SET envelope=excluded.envelope, updated=excluded.updated`,
      )
      .run(scope.userId, name, JSON.stringify(envelope), Date.now());
    temporary.delete(`${scope.userId}:${scope.sessionId}:${name}`);
  }
}
export function clearAccountConnection(name: string) {
  const scope = accountScope();
  accountDatabase()
    .prepare('DELETE FROM connections WHERE user_id = ? AND name = ?')
    .run(scope.userId, name);
  for (const key of temporary.keys())
    if (key.startsWith(`${scope.userId}:`) && key.endsWith(`:${name}`)) temporary.delete(key);
}

export function credentialName(name: string): CredentialName {
  if (!credentialFields.some((field) => field[0] === name))
    throw Object.assign(new Error('Unknown connection field'), { status: 400 });
  return name as CredentialName;
}
export async function initializeCredentials(): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  if (process.env.CREDENTIALS_MASTER_KEY) {
    if (!/^[a-fA-F0-9]{64}$/.test(process.env.CREDENTIALS_MASTER_KEY))
      throw new Error('CREDENTIALS_MASTER_KEY must be 32 bytes encoded as hex');
    masterKey = Buffer.from(process.env.CREDENTIALS_MASTER_KEY, 'hex');
    const existing = await fs.readFile(keyFile).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !existing.equals(masterKey))
      throw new Error('External vault key differs from the existing key; restore the original key');
    return;
  }
  try {
    masterKey = await fs.readFile(keyFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Never silently replace a lost encryption key for an existing vault.
    if (
      await Promise.all(
        [vaultFile, path.join(directory, 'accounts.sqlite')].map((file) =>
          fs.stat(file).then(
            () => true,
            (failure) => {
              if (failure.code === 'ENOENT') return false;
              throw failure;
            },
          ),
        ),
      ).then((values) => values.some(Boolean))
    )
      throw new Error('Credential encryption key is missing; restore data/private from backup');
    const candidate = randomBytes(32);
    try {
      const handle = await fs.open(keyFile, 'wx', 0o600);
      try {
        await handle.writeFile(candidate);
        await handle.sync();
      } finally {
        await handle.close();
      }
      masterKey = candidate;
    } catch (failure) {
      if (failure.code !== 'EEXIST') throw failure;
      masterKey = await fs.readFile(keyFile);
    }
  }
  if (masterKey.length !== 32) throw new Error('Invalid credential encryption key');
  await fs.chmod(keyFile, 0o600);
}
async function readVault(): Promise<Vault> {
  const vault = await readJson<Vault>(vaultFile, { version: 1, values: {} });
  if (
    vault.version !== 1 ||
    !vault.values ||
    typeof vault.values !== 'object' ||
    Array.isArray(vault.values)
  )
    throw new Error('Invalid credential vault');
  return vault;
}
export async function credential(name: string | null): Promise<string | undefined> {
  if (!name) return undefined;
  const field = credentialName(name);
  if (hosted) return identity() ? accountConnection(field)?.value : undefined;
  const vault = await readVault();
  const value = vault.values[field];
  // A clear action masks an old environment key, instead of resurrecting it.
  if (value === null) return undefined;
  if (value === undefined) return process.env[field] || undefined;
  if (!masterKey) await initializeCredentials();
  const decipher = createDecipheriv('aes-256-gcm', masterKey!, Buffer.from(value.iv, 'base64'));
  decipher.setAAD(Buffer.from(field));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(value.data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
export async function credentialStatus() {
  if (hosted)
    return credentialFields
      .filter(
        ([name]) =>
          !['TRANSCRIPTION_API_URL', 'TRANSCRIPTION_API_KEY', 'YOUTUBE_COOKIES'].includes(name),
      )
      .map(([name, label, secret]) => {
        const connection = accountConnection(name);
        return {
          name,
          label,
          secret,
          configured: Boolean(connection),
          source: connection?.mode ?? 'missing',
          updatedAt: connection?.updatedAt ?? null,
          expires: connection?.expires ?? null,
          value: secret ? undefined : (connection?.value ?? ''),
        };
      });
  const vault = await readVault();
  return Promise.all(
    credentialFields.map(async ([name, label, secret]) => ({
      name,
      label,
      secret,
      configured: Boolean(await credential(name)),
      source:
        vault.values[name] === null
          ? 'cleared'
          : vault.values[name]
            ? 'saved'
            : process.env[name]
              ? 'environment'
              : 'missing',
      updatedAt: vault.values[name]?.updatedAt ?? null,
      // Only non-secret settings may be read back into the form.
      value: secret ? undefined : ((await credential(name)) ?? ''),
    })),
  );
}
function validateValue(name: CredentialName, value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw Object.assign(new Error('Enter a value, or use Clear to remove it'), { status: 400 });
  const text = value.trim();
  if (Buffer.byteLength(text) > (name === 'YOUTUBE_COOKIES' ? 256 * 1024 : 8192))
    throw Object.assign(new Error('Connection value is too large'), { status: 400 });
  if (name === 'YOUTUBE_COOKIES') {
    if (!/^# (?:Netscape HTTP Cookie File|HTTP Cookie File)/.test(text) || text.includes('\0'))
      throw Object.assign(new Error('Use a Netscape cookies.txt export'), { status: 400 });
  } else if (/[\x00-\x1f\x7f]/.test(text))
    throw Object.assign(new Error('Connection value contains invalid characters'), { status: 400 });
  if (name === 'SPEECHMATICS_REGION' && !['eu1', 'us1'].includes(text))
    throw Object.assign(new Error('Choose eu1 or us1'), { status: 400 });
  if (name === 'TRANSCRIPTION_API_URL') {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw Object.assign(new Error('Enter a complete transcription endpoint URL'), {
        status: 400,
      });
    }
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    ) {
      throw Object.assign(
        new Error('Use HTTPS (or loopback HTTP), without URL credentials or query parameters'),
        { status: 400 },
      );
    }
  }
  return text;
}
export async function saveCredential(
  name: string,
  value: unknown,
  mode: unknown = 'session',
): Promise<void> {
  const field = credentialName(name),
    text = validateValue(field, value);
  if (hosted) {
    if (['TRANSCRIPTION_API_URL', 'TRANSCRIPTION_API_KEY', 'YOUTUBE_COOKIES'].includes(field))
      throw Object.assign(
        new Error('This connection is available only in personal installations'),
        { status: 403 },
      );
    saveAccountConnection(field, text, mode);
    return;
  }
  if (!masterKey) await initializeCredentials();
  await serialized(vaultFile, async () => {
    const vault = await readVault(),
      iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey!, iv);
    cipher.setAAD(Buffer.from(field));
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    vault.values[field] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      updatedAt: new Date().toISOString(),
    };
    await writeJson(vaultFile, vault);
  });
}
export async function clearCredential(name: string): Promise<void> {
  const field = credentialName(name);
  if (hosted) {
    clearAccountConnection(field);
    return;
  }
  await serialized(vaultFile, async () => {
    const vault = await readVault();
    vault.values[field] = null;
    await writeJson(vaultFile, vault);
  });
}
export async function withYouTubeCookies<T>(operation: (file?: string) => Promise<T>): Promise<T> {
  const cookies = await credential('YOUTUBE_COOKIES');
  if (!cookies) return operation();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = await fs.mkdtemp(path.join(directory, 'youtube-'));
  try {
    const file = path.join(temp, 'cookies.txt');
    await atomicWrite(file, cookies + '\n');
    return await operation(file);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}
export async function clearStaleCookieFiles(): Promise<void> {
  for (const name of await fs.readdir(directory))
    if (/^youtube-[a-zA-Z0-9]+$/.test(name))
      await fs.rm(path.join(directory, name), { recursive: true, force: true });
}
