import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Router, Request, RequestHandler } from 'express';
import { at, readJson, serialized, writeJson } from './files.js';

interface PasswordRecord {
  version: 1;
  salt: string;
  hash: string;
}
interface Session {
  expires: number;
  created: number;
}
const passwordFile = at('data', 'private', 'password.json');
const sessions = new Map<string, Session>();
const failures = new Map<string, { count: number; until: number }>();
const SESSION_MS = 12 * 60 * 60 * 1000;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const derive = (password: string, salt: string): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value) <= 1024;
}
async function recordFor(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(32).toString('hex');
  return { version: 1, salt, hash: (await derive(password, salt)).toString('hex') };
}
async function verify(password: unknown): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) return false;
  const record = await readJson<PasswordRecord>(passwordFile);
  if (
    record.version !== 1 ||
    !/^[a-f0-9]{128}$/.test(record.hash) ||
    !/^[a-f0-9]{64}$/.test(record.salt)
  )
    throw new Error('Invalid password record');
  return timingSafeEqual(Buffer.from(record.hash, 'hex'), await derive(password, record.salt));
}
export async function initializePassword(): Promise<void> {
  const existing = await readJson<PasswordRecord | null>(passwordFile, null);
  if (existing) return;
  if (!validPassword(process.env.APP_PASSWORD))
    throw new Error('Set APP_PASSWORD to at least 12 characters for the first startup');
  await writeJson(passwordFile, await recordFor(process.env.APP_PASSWORD));
}
export function installAuth(router: Router, origin: URL, base: string): RequestHandler {
  const name = 'yesilcam_session';
  const cookieOptions = {
    httpOnly: true,
    secure: origin.protocol === 'https:',
    sameSite: 'strict' as const,
    path: `${base}/`,
  };
  const token = (req: Request) => {
    const value = req.headers.cookie
      ?.split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith(name + '='))
      ?.slice(name.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? sha(value) : '';
  };
  const authenticated = (req: Request) => {
    const id = token(req),
      session = sessions.get(id);
    if (!session || session.expires <= Date.now()) {
      sessions.delete(id);
      return false;
    }
    return true;
  };
  router.get('/api/auth/session', (req, res) => res.json({ authenticated: authenticated(req) }));
  router.get('/login', (req, res) =>
    authenticated(req) ? res.redirect(`${base}/`) : res.sendFile(at('public', 'login.html')),
  );
  for (const file of ['login.js', 'style.css', 'favicon.svg'])
    router.get(`/${file}`, (req, res) => res.sendFile(at('public', file)));
  router.post('/api/auth/login', async (req, res) => {
    const now = Date.now();
    for (const [key, value] of failures) if (value.until <= now) failures.delete(key);
    for (const [key, value] of sessions) if (value.expires <= now) sessions.delete(key);
    // Global cap also covers reverse proxies whose remote address is shared.
    const keys = ['global', req.socket.remoteAddress ?? 'unknown'];
    if (keys.some((key) => (failures.get(key)?.count ?? 0) >= (key === 'global' ? 30 : 10))) {
      res.set('Retry-After', '60');
      res.status(429).json({ error: 'Too many login attempts. Try again in one minute.' });
      return;
    }
    for (const key of keys) {
      const entry = failures.get(key) ?? { count: 0, until: now + 60000 };
      entry.count++;
      failures.set(key, entry);
    }
    await serialized(passwordFile, async () => {
      if (!(await verify(req.body?.password))) {
        res.status(401).json({ error: 'Incorrect password' });
        return;
      }
      sessions.delete(token(req));
      if (sessions.size >= 100) sessions.delete(sessions.keys().next().value!);
      const value = randomBytes(32).toString('hex');
      sessions.set(sha(value), { created: now, expires: now + SESSION_MS });
      res.cookie(name, value, { ...cookieOptions, maxAge: SESSION_MS });
      res.json({ success: true });
    });
  });
  const gate: RequestHandler = (req, res, next) => {
    if (authenticated(req)) {
      next();
      return;
    }
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
      res.redirect(`${base}/login`);
      return;
    }
    res.status(401).json({ error: 'Sign in to continue' });
  };
  router.post('/api/auth/logout', gate, (req, res) => {
    sessions.delete(token(req));
    res.clearCookie(name, cookieOptions);
    res.json({ success: true });
  });
  router.put('/api/auth/password', gate, async (req, res) => {
    // Shared rate limit prevents using this authenticated route as a password oracle.
    const key = 'password-change',
      now = Date.now(),
      prior = failures.get(key);
    if (prior && prior.until > now && prior.count >= 5) {
      res.status(429).json({ error: 'Try again in one minute' });
      return;
    }
    failures.set(key, {
      count: prior && prior.until > now ? prior.count + 1 : 1,
      until: prior && prior.until > now ? prior.until : now + 60000,
    });
    await serialized(passwordFile, async () => {
      if (!(await verify(req.body?.currentPassword))) {
        res.status(400).json({ error: 'Current password is incorrect' });
        return;
      }
      if (!validPassword(req.body?.newPassword)) {
        res
          .status(400)
          .json({ error: 'Use a password of at least 12 characters (maximum 1024 bytes)' });
        return;
      }
      await writeJson(passwordFile, await recordFor(req.body.newPassword));
      sessions.clear();
      res.clearCookie(name, cookieOptions);
      res.json({ success: true });
    });
  });
  return gate;
}
