import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import express from 'express';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

test(
  'approved OAuth verifies one-use state, session, PKCE, identity and scope and rotates tokens once',
  { timeout: 15000 },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-oauth-'));
    process.env.APP_MODE = 'hosted';
    process.env.DATA_DIR = root;
    process.env.CHATGPT_PLAN_USAGE_ENABLED = 'true';
    process.env.CHATGPT_OAUTH_CLIENT_ID = 'oaiapp_fixture';
    delete process.env.CHATGPT_OAUTH_CLIENT_SECRET;
    delete process.env.CREDENTIALS_MASTER_KEY;
    const { initializeAccounts, accountDatabase } = await import('../lib/accounts.js');
    const { initializeCredentials, accountConnection } = await import('../lib/credentials.js');
    const { asIdentity } = await import('../lib/identity.js');
    const { installChatGPT, chatGPTToken } = await import('../lib/chatgpt-oauth.js');
    await initializeCredentials();
    await initializeAccounts();
    const alice = randomUUID(),
      bob = randomUUID();
    for (const id of [alice, bob]) {
      accountDatabase()
        .prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, `${id}@example.com`, id, 'unused-fixture-hash', 'unused-recovery', Date.now());
      for (const suffix of ['1', '2'])
        accountDatabase()
          .prepare('INSERT INTO sessions VALUES (?, ?, ?)')
          .run(id + suffix, id, Date.now() + 100000);
    }
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'fixture', alg: 'RS256', use: 'sig' };
    const originalFetch = globalThis.fetch;
    let nonce = '',
      challenge = '',
      exchanges = 0,
      refreshes = 0;
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      if (target.endsWith('/.well-known/openid-configuration'))
        return Response.json({
          issuer: 'https://auth.openai.com',
          authorization_endpoint: 'https://auth.openai.com/authorize',
          token_endpoint: 'https://auth.openai.com/token',
          jwks_uri: 'https://auth.openai.com/jwks',
          revocation_endpoint: 'https://auth.openai.com/revoke',
        });
      if (target.endsWith('/jwks')) return Response.json({ keys: [jwk] });
      if (target.endsWith('/revoke')) return new Response('', { status: 200 });
      assert.equal(target, 'https://auth.openai.com/token');
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('client_id'), 'oaiapp_fixture');
      if (body.get('grant_type') === 'refresh_token') {
        refreshes++;
        assert.equal(body.get('refresh_token'), 'refresh-fixture');
        return Response.json({
          access_token: 'renewed-fixture',
          refresh_token: 'rotated-fixture',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      }
      exchanges++;
      assert.equal(
        createHash('sha256').update(body.get('code_verifier')!).digest('base64url'),
        challenge,
      );
      const code = body.get('code');
      const idToken = await new SignJWT({
        nonce: code === 'wrong-nonce' ? 'wrong' : nonce,
        email: 'provider@example.com',
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer('https://auth.openai.com')
        .setAudience('oaiapp_fixture')
        .setSubject('verified-subject')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
      return Response.json({
        access_token: 'access-fixture',
        refresh_token: 'refresh-fixture',
        token_type: 'Bearer',
        expires_in: 1,
        id_token: idToken,
        scope:
          code === 'no-scope'
            ? 'openid email'
            : 'openid email offline_access resource.invoke chatgpt.tokens.use.direct',
      });
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) =>
      asIdentity(
        {
          userId: req.headers['x-test-user'] === 'bob' ? bob : alice,
          sessionId:
            (req.headers['x-test-user'] === 'bob' ? bob : alice) +
            (req.headers['x-test-session'] === '2' ? '2' : '1'),
        },
        next,
      ),
    );
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const router = express.Router();
    installChatGPT(router, new URL(origin), '');
    app.use(router);
    app.use(((error, _req, res, _next) =>
      res.status(400).json({ error: 'Authorization rejected' })) as express.ErrorRequestHandler);
    const request = (
      route: string,
      method = 'GET',
      body?: unknown,
      user = 'alice',
      session = '1',
    ) =>
      originalFetch(origin + route, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'x-test-user': user,
          'x-test-session': session,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        redirect: 'manual',
      });
    const start = async () => {
      const data = (await (
        await request('/api/oauth/chatgpt/start', 'POST', { storage: 'saved' })
      ).json()) as { url: string };
      const url = new URL(data.url);
      nonce = url.searchParams.get('nonce')!;
      challenge = url.searchParams.get('code_challenge')!;
      assert.equal(url.searchParams.get('redirect_uri'), origin + '/api/oauth/chatgpt/callback');
      return url.searchParams.get('state')!;
    };
    try {
      let state = await start();
      const callback = (code: string, value = state) =>
        `/api/oauth/chatgpt/callback?code=${code}&state=${value}`;
      assert.equal((await request(callback('ok', 'forged'))).status, 400);
      assert.equal((await request(callback('ok'), 'GET', undefined, 'bob')).status, 400);
      assert.equal((await request(callback('ok'), 'GET', undefined, 'alice', '2')).status, 400);
      assert.equal(exchanges, 0);
      assert.equal((await request(callback('wrong-nonce'))).status, 400);
      assert.equal((await request(callback('ok'))).status, 400, 'failed callback is one-use');
      state = await start();
      assert.equal((await request(callback('no-scope'))).status, 400);
      assert.equal(
        asIdentity({ userId: alice }, () => accountConnection('CHATGPT_OAUTH')),
        null,
      );
      state = await start();
      assert.equal((await request(callback('ok'))).status, 302);
      const exchanged = exchanges;
      assert.equal((await request(callback('ok'))).status, 400);
      assert.equal(exchanges, exchanged);
      const access = await asIdentity({ userId: alice }, () =>
        Promise.all([chatGPTToken(), chatGPTToken()]),
      );
      assert.deepEqual(access, ['renewed-fixture', 'renewed-fixture']);
      assert.equal(refreshes, 1);
      assert.equal(
        asIdentity({ userId: bob }, () => accountConnection('CHATGPT_OAUTH')),
        null,
      );
      const status = await (await request('/api/oauth/chatgpt')).text();
      assert.ok(!status.includes('fixture') && !status.includes('rotated'));
      assert.equal((await request('/api/oauth/chatgpt', 'DELETE')).status, 200);
      assert.equal(
        asIdentity({ userId: alice }, () => accountConnection('CHATGPT_OAUTH')),
        null,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      accountDatabase().close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
