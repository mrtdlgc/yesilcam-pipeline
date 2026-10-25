import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Request, RequestHandler, Router } from 'express';
import { DATA_ROOT, at } from './files.js';
import { asIdentity, hosted } from './identity.js';

export const SESSION_MS = 12 * 60 * 60 * 1000;
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
let db: DatabaseSync | undefined;
const revocations = new Set<(sessionId: string) => void>();
export const onSessionRevoked = (callback: (sessionId: string) => void) =>
  revocations.add(callback);
function revokeSessions(userId: string, onlySession?: string) {
  const rows = onlySession
    ? accountDatabase()
        .prepare('DELETE FROM sessions WHERE user_id = ? AND id = ? RETURNING id')
        .all(userId, onlySession)
    : accountDatabase().prepare('DELETE FROM sessions WHERE user_id = ? RETURNING id').all(userId);
  for (const row of rows) for (const callback of revocations) callback(String(row.id));
}
export function accountDatabase() {
  if (!db) throw new Error('Hosted account database is unavailable');
  return db;
}
export async function initializeAccounts() {
  if (!hosted) return;
  const maximum = Number(process.env.MAX_ACCOUNTS || 1000);
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 100000)
    throw new Error('MAX_ACCOUNTS must be 1–100000');
  const file = path.join(DATA_ROOT, 'data', 'private', 'accounts.sqlite');
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await (await fs.open(file, 'a', 0o600)).close();
  await fs.chmod(file, 0o600);
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE, password TEXT NOT NULL,
      recovery TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS connections (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL, envelope TEXT NOT NULL, updated INTEGER NOT NULL,
      PRIMARY KEY(user_id, name)
    );`);
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(Date.now());
}
export const validPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 1024;
const derive = (value: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(value, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
async function passwordHash(value: string) {
  const salt = randomBytes(32).toString('hex');
  return `${salt}:${(await derive(value, salt)).toString('hex')}`;
}
async function passwordMatches(value: unknown, record: string) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 1024) return false;
  const [salt, hash] = record.split(':');
  return (
    /^[a-f0-9]{64}$/.test(salt) &&
    /^[a-f0-9]{128}$/.test(hash) &&
    timingSafeEqual(Buffer.from(hash, 'hex'), await derive(value, salt))
  );
}
interface Account {
  id: string;
  email: string;
  username: string;
  password: string;
  recovery: string;
}
const failures = new Map<string, { count: number; reset: number }>();
let hashing = 0;
const busy = new Set<string>();
const COOKIE = 'yesilcam_account';
export function sessionId(req: Request) {
  const value = req.headers.cookie
    ?.split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(COOKIE + '='))
    ?.slice(COOKIE.length + 1);
  return value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : '';
}
export function sessionValid(id: string, userId: string) {
  return Boolean(
    accountDatabase()
      .prepare('SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND expires > ?')
      .get(id, userId, Date.now()),
  );
}
export function accountSession(req: Request) {
  const id = sessionId(req);
  const row = accountDatabase()
    .prepare(
      `SELECT users.id, email, username, expires FROM sessions
    JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND expires > ?`,
    )
    .get(id, Date.now());
  return row
    ? {
        id: String(row.id),
        email: String(row.email),
        username: String(row.username),
        sessionId: id,
        expires: Number(row.expires),
      }
    : null;
}
export function accountExists(id: string) {
  return Boolean(accountDatabase().prepare('SELECT id FROM users WHERE id = ?').get(id));
}
export function installAccounts(router: Router, origin: URL, base: string): RequestHandler {
  const cookie = {
    httpOnly: true,
    secure: origin.protocol === 'https:',
    sameSite: 'lax' as const,
    path: `${base}/`,
  };
  const publicAccount = (account: ReturnType<typeof accountSession>) =>
    account && {
      id: account.id,
      username: account.username,
      email: account.email,
      expires: account.expires,
    };
  router.get('/api/auth/session', (req, res) => {
    const account = accountSession(req);
    res.json({
      authenticated: Boolean(account),
      mode: 'hosted',
      user: publicAccount(account),
      signupEnabled: process.env.SIGNUP_ENABLED !== 'false',
    });
  });
  router.get('/login', (req, res) =>
    accountSession(req) ? res.redirect(`${base}/`) : res.sendFile(at('public', 'login.html')),
  );
  for (const file of ['login.js', 'style.css', 'favicon.svg'])
    router.get(`/${file}`, (_req, res) => res.sendFile(at('public', file)));
  const gate: RequestHandler = (req, res, next) => {
    const account = accountSession(req);
    if (!account) {
      if (req.method === 'GET' && (req.path === '/' || req.path.endsWith('.html')))
        res.redirect(`${base}/login`);
      else res.status(401).json({ error: 'Sign in to continue' });
      return;
    }
    asIdentity({ userId: account.id, sessionId: account.sessionId }, next);
  };
  const limited: RequestHandler = async (req, res, next) => {
    const now = Date.now(),
      ip = req.ip || req.socket.remoteAddress || 'unknown';
    for (const [key, value] of failures) if (value.reset <= now) failures.delete(key);
    const prior = failures.get(ip) ?? { count: 0, reset: now + 15 * 60 * 1000 };
    if (prior.count >= 20 || hashing >= 4 || busy.has(ip)) {
      res
        .set('Retry-After', '60')
        .status(429)
        .json({ error: 'Too many sign-in attempts. Try again later.' });
      return;
    }
    if (failures.size >= 10000 && !failures.has(ip)) {
      res.status(429).json({ error: 'Sign-in is busy. Try again shortly.' });
      return;
    }
    prior.count++;
    failures.set(ip, prior);
    hashing++;
    busy.add(ip);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        hashing--;
        busy.delete(ip);
      }
    };
    res.once('finish', release);
    res.once('close', release);
    next();
  };
  const issue = (req: Request, userId: string) => {
    const token = randomBytes(32).toString('hex'),
      database = accountDatabase();
    database
      .prepare('DELETE FROM sessions WHERE expires <= ? OR id = ?')
      .run(Date.now(), sessionId(req));
    // Bound sessions per account without evicting other users.
    database
      .prepare(
        'DELETE FROM sessions WHERE user_id = ? AND id NOT IN (SELECT id FROM sessions WHERE user_id = ? ORDER BY expires DESC LIMIT 4)',
      )
      .run(userId, userId);
    database
      .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(digest(token), userId, Date.now() + SESSION_MS);
    return token;
  };
  router.post('/api/auth/signup', limited, async (req, res) => {
    if (process.env.SIGNUP_ENABLED === 'false') {
      res.status(403).json({ error: 'New registrations are closed' });
      return;
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
    if (
      email.length > 254 ||
      !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ||
      !/^[a-zA-Z0-9_]{3,30}$/.test(username) ||
      !validPassword(req.body?.password)
    ) {
      res.status(400).json({
        error:
          'Use a valid email, a 3–30 character username (letters, numbers, underscores), and a password of at least 12 characters.',
      });
      return;
    }
    const password = await passwordHash(req.body.password),
      id = randomUUID(),
      recoveryCode = randomBytes(24).toString('hex');
    const database = accountDatabase();
    if (
      Number(database.prepare('SELECT count(*) AS count FROM users').get()!.count) >=
      Number(process.env.MAX_ACCOUNTS || 1000)
    ) {
      res.status(503).json({ error: 'Registration capacity has been reached' });
      return;
    }
    try {
      database
        .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, email, username, password, digest(recoveryCode), Date.now());
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        res.status(409).json({ error: 'This email or username is unavailable' });
        return;
      }
      throw error;
    }
    res.cookie(COOKIE, issue(req, id), { ...cookie, maxAge: SESSION_MS });
    res.status(201).json({ success: true, recoveryCode });
  });
  router.post('/api/auth/login', limited, async (req, res) => {
    const login = typeof req.body?.login === 'string' ? req.body.login.trim().slice(0, 254) : '';
    const account = accountDatabase()
      .prepare('SELECT * FROM users WHERE email = ? OR username = ?')
      .get(login, login) as unknown as Account | undefined;
    // Perform the same expensive operation for unknown accounts.
    const matches = await passwordMatches(
      req.body?.password,
      account?.password ?? `${'0'.repeat(64)}:${'0'.repeat(128)}`,
    );
    if (!account || !matches) {
      res.status(401).json({ error: 'Email, username or password is incorrect' });
      return;
    }
    res.cookie(COOKIE, issue(req, account.id), { ...cookie, maxAge: SESSION_MS });
    res.json({ success: true });
  });
  router.post('/api/auth/recover', limited, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, 254) : '';
    const code = typeof req.body?.recoveryCode === 'string' ? req.body.recoveryCode.trim() : '';
    const account = accountDatabase()
      .prepare('SELECT * FROM users WHERE email = ?')
      .get(email) as unknown as Account | undefined;
    if (
      !validPassword(req.body?.newPassword) ||
      !/^[a-f0-9]{48}$/.test(code) ||
      !account ||
      !timingSafeEqual(Buffer.from(digest(code)), Buffer.from(account.recovery))
    ) {
      res.status(400).json({
        error: 'Check the email, recovery code and new password (at least 12 characters)',
      });
      return;
    }
    const password = await passwordHash(req.body.newPassword),
      recoveryCode = randomBytes(24).toString('hex');
    const updated = accountDatabase()
      .prepare('UPDATE users SET password = ?, recovery = ? WHERE id = ? AND recovery = ?')
      .run(password, digest(recoveryCode), account.id, account.recovery);
    if (!updated.changes) {
      res.status(409).json({ error: 'This recovery code was already used' });
      return;
    }
    revokeSessions(account.id);
    res.clearCookie(COOKIE, cookie).json({ success: true, recoveryCode });
  });
  router.post('/api/auth/logout', gate, (req, res) => {
    revokeSessions(accountSession(req)!.id, sessionId(req));
    res.clearCookie(COOKIE, cookie).json({ success: true });
  });
  router.put('/api/auth/password', gate, limited, async (req, res) => {
    const account = accountSession(req)!;
    const record = accountDatabase()
      .prepare('SELECT password FROM users WHERE id = ?')
      .get(account.id)!;
    if (
      !validPassword(req.body?.newPassword) ||
      !(await passwordMatches(req.body?.currentPassword, String(record.password)))
    ) {
      res.status(400).json({
        error: 'Check the current password and use at least 12 characters for the new password',
      });
      return;
    }
    const password = await passwordHash(req.body.newPassword);
    const result = accountDatabase()
      .prepare('UPDATE users SET password = ? WHERE id = ? AND password = ?')
      .run(password, account.id, record.password);
    if (!result.changes) {
      res.status(409).json({ error: 'Password changed in another session. Sign in again.' });
      return;
    }
    revokeSessions(account.id);
    res.clearCookie(COOKIE, cookie).json({ success: true });
  });
  return gate;
}
