import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Router } from 'express';
import { identity, hosted } from './identity.js';
import { accountConnection, saveAccountConnection, clearAccountConnection } from './credentials.js';
import { serialized } from './files.js';

const ISSUER = 'https://auth.openai.com';
const KEY = 'CHATGPT_OAUTH';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const enabled = () =>
  hosted &&
  process.env.CHATGPT_PLAN_USAGE_ENABLED === 'true' &&
  /^oaiapp_[a-zA-Z0-9_-]+$/.test(process.env.CHATGPT_OAUTH_CLIENT_ID || '');
interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expires: number;
  subject: string;
  email?: string;
  clientId: string;
  scopes: string[];
}
interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  sessionId: string;
  expires: number;
  redirect: string;
  mode: 'session' | 'saved';
}
const pending = new Map<string, Pending>();
let discovery:
  | Promise<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
      revocation_endpoint?: string;
    }>
  | undefined;
async function metadata() {
  discovery ??= (async () => {
    const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('ChatGPT sign-in discovery is unavailable');
    const data: any = await response.json();
    if (data.issuer !== ISSUER) throw new Error('Unexpected OAuth issuer');
    for (const field of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'revocation_endpoint',
    ]) {
      if (field === 'revocation_endpoint' && !data[field]) continue;
      if (typeof data[field] !== 'string' || new URL(data[field]).origin !== ISSUER)
        throw new Error('Unexpected OAuth endpoint');
    }
    return data;
  })();
  try {
    return (await discovery)!;
  } catch (error) {
    discovery = undefined;
    throw error;
  }
}
function clientBody(fields: Record<string, string>) {
  const clientId = process.env.CHATGPT_OAUTH_CLIENT_ID!;
  const secret = process.env.CHATGPT_OAUTH_CLIENT_SECRET;
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };
  if (secret) {
    const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
    headers.Authorization = `Basic ${Buffer.from(`${encode(clientId)}:${encode(secret)}`).toString('base64')}`;
  }
  return {
    headers,
    body: new URLSearchParams({ ...(!secret ? { client_id: clientId } : {}), ...fields }),
  };
}
async function exchange(fields: Record<string, string>) {
  const endpoints = await metadata();
  const response = await fetch(endpoints.token_endpoint, {
    method: 'POST',
    ...clientBody(fields),
    signal: AbortSignal.timeout(20000),
    redirect: 'error',
  });
  if (!response.ok) {
    const body: any = await response.json().catch(() => ({}));
    throw Object.assign(new Error('ChatGPT authorization failed. Reconnect the account.'), {
      terminal: [
        'invalid_grant',
        'invalid_refresh_token',
        'refresh_token_reused',
        'token_expired',
      ].includes(body.error),
    });
  }
  const data: any = await response.json();
  if (
    typeof data.access_token !== 'string' ||
    data.token_type?.toLowerCase() !== 'bearer' ||
    !Number.isFinite(data.expires_in) ||
    data.expires_in <= 0
  )
    throw new Error('Invalid ChatGPT token response');
  return data;
}
export function chatGPTStatus() {
  const connection = identity() ? accountConnection(KEY) : null;
  const saved = connection ? (JSON.parse(connection.value) as Tokens) : null;
  return {
    enabled: enabled(),
    connected: Boolean(
      enabled() && saved && saved.clientId === process.env.CHATGPT_OAUTH_CLIENT_ID,
    ),
    email: saved?.email ?? null,
    storage: connection?.mode ?? null,
    message: enabled()
      ? 'Connect your approved ChatGPT plan. Usage is charged to your plan; API billing is separate.'
      : 'ChatGPT subscription connections are awaiting approval for this hosted service. Use your OpenAI API key meanwhile.',
  };
}
export async function chatGPTToken() {
  if (!enabled())
    throw new Error('ChatGPT subscription usage is not enabled for this hosted service');
  return serialized(`chatgpt-refresh:${identity()?.userId}`, async () => {
    const connection = accountConnection(KEY);
    if (!connection) throw new Error('Connect your ChatGPT account in Connections');
    const tokens = JSON.parse(connection.value) as Tokens;
    if (
      tokens.clientId !== process.env.CHATGPT_OAUTH_CLIENT_ID ||
      !tokens.scopes.includes('chatgpt.tokens.use.direct')
    )
      throw new Error('Reconnect ChatGPT and authorize plan usage');
    if (tokens.expires > Date.now() + 60000) return tokens.accessToken;
    if (!tokens.refreshToken) throw new Error('Your ChatGPT connection expired. Reconnect it.');
    try {
      const fresh = await exchange({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        resource: 'https://api.openai.com/v1',
      });
      const granted = typeof fresh.scope === 'string' ? fresh.scope.split(' ') : tokens.scopes;
      if (!granted.includes('chatgpt.tokens.use.direct'))
        throw new Error('ChatGPT plan usage was not authorized');
      saveAccountConnection(
        KEY,
        JSON.stringify({
          ...tokens,
          accessToken: fresh.access_token,
          refreshToken: fresh.refresh_token ?? tokens.refreshToken,
          scopes: granted,
          expires: Date.now() + fresh.expires_in * 1000,
        }),
        connection.mode,
      );
      return fresh.access_token as string;
    } catch (error) {
      if (error.terminal) clearAccountConnection(KEY);
      throw error;
    }
  });
}
export function installChatGPT(router: Router, origin: URL, base: string) {
  router.get('/api/oauth/chatgpt', (_req, res) => res.json(chatGPTStatus()));
  router.post('/api/oauth/chatgpt/start', async (req, res) => {
    if (!enabled()) {
      res.status(503).json({ error: chatGPTStatus().message });
      return;
    }
    const mode = req.body?.storage ?? 'session';
    if (!['session', 'saved'].includes(mode)) {
      res.status(400).json({ error: 'Choose session or saved storage' });
      return;
    }
    for (const [key, value] of pending) if (value.expires <= Date.now()) pending.delete(key);
    if (pending.size >= 1000) {
      res.status(429).json({ error: 'Sign-in is busy' });
      return;
    }
    const state = randomBytes(32).toString('hex'),
      verifier = randomBytes(64).toString('base64url'),
      nonce = randomBytes(32).toString('hex');
    const redirect = `${origin.origin}${base}/api/oauth/chatgpt/callback`;
    pending.set(identity()!.userId, {
      state,
      verifier,
      nonce,
      sessionId: identity()!.sessionId!,
      expires: Date.now() + 10 * 60 * 1000,
      redirect,
      mode,
    });
    const url = new URL((await metadata()).authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: process.env.CHATGPT_OAUTH_CLIENT_ID!,
      redirect_uri: redirect,
      response_type: 'code',
      scope: scopes,
      resource: 'https://api.openai.com/v1',
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    }).toString();
    res.json({ url: url.toString() });
  });
  router.get('/api/oauth/chatgpt/callback', async (req, res) => {
    const value = pending.get(identity()!.userId);
    if (
      !enabled() ||
      !value ||
      value.expires <= Date.now() ||
      value.sessionId !== identity()!.sessionId ||
      req.query.state !== value.state
    ) {
      res.status(400).send('Sign-in could not be verified. Return to Connections and try again.');
      return;
    }
    pending.delete(identity()!.userId);
    if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 8192) {
      res.redirect(`${base}/#connections`);
      return;
    }
    const data = await exchange({
      grant_type: 'authorization_code',
      code: req.query.code,
      code_verifier: value.verifier,
      redirect_uri: value.redirect,
      resource: 'https://api.openai.com/v1',
    });
    const endpoints = await metadata();
    const { payload } = await jwtVerify(
      data.id_token,
      createRemoteJWKSet(new URL(endpoints.jwks_uri)),
      {
        issuer: ISSUER,
        audience: process.env.CHATGPT_OAUTH_CLIENT_ID!,
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      },
    );
    if (payload.nonce !== value.nonce || !payload.sub)
      throw new Error('ChatGPT identity could not be verified');
    const granted = String(data.scope ?? '').split(' ');
    if (!granted.includes('chatgpt.tokens.use.direct')) {
      res
        .status(400)
        .send(
          'Plan usage was not authorized. Return to Connections to use an API key or reconnect.',
        );
      return;
    }
    const prior = accountConnection(KEY);
    if (prior && JSON.parse(prior.value).subject !== payload.sub) {
      res
        .status(409)
        .send('Disconnect the previous ChatGPT account before linking a different one.');
      return;
    }
    const tokens: Tokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      subject: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      expires: Date.now() + data.expires_in * 1000,
      scopes: granted,
      clientId: process.env.CHATGPT_OAUTH_CLIENT_ID!,
    };
    saveAccountConnection(KEY, JSON.stringify(tokens), value.mode);
    res.redirect(`${base}/#connections`);
  });
  router.delete('/api/oauth/chatgpt', async (_req, res) => {
    const connection = accountConnection(KEY);
    let revoked = true;
    try {
      if (connection) {
        const tokens = JSON.parse(connection.value) as Tokens;
        if (tokens.refreshToken) {
          const endpoint = (await metadata()).revocation_endpoint;
          if (!endpoint) revoked = false;
          else {
            const response = await fetch(endpoint, {
              method: 'POST',
              ...clientBody({ token: tokens.refreshToken, token_type_hint: 'refresh_token' }),
              signal: AbortSignal.timeout(10000),
              redirect: 'error',
            });
            revoked = response.ok;
          }
        }
      }
    } catch {
      revoked = false;
    }
    clearAccountConnection(KEY);
    pending.delete(identity()!.userId);
    res.json({
      success: true,
      message: revoked
        ? 'Disconnected.'
        : 'Disconnected here. Remote revocation was not confirmed; remove the app in ChatGPT Settings → Usage.',
    });
  });
}
