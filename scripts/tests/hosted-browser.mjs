import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chromium } from 'playwright';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesilcam-hosted-browser-'));
const socket = net.createServer().listen(0, '127.0.0.1');
await once(socket, 'listening');
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const env = { ...process.env };
for (const key of Object.keys(env))
  if (/API_KEY|TOKEN|SECRET|PASSWORD|MASTER_KEY|COOKIES|CHATGPT_/i.test(key)) delete env[key];
const server = spawn(process.execPath, ['build/server.js'], {
  env: {
    ...env,
    APP_MODE: 'hosted',
    DATA_DIR: root,
    HOST: '127.0.0.1',
    PORT: String(port),
    PUBLIC_ORIGIN: origin,
    BASE_PATH: '',
    SOURCE_URL: 'https://github.com/mrtdlgc/yesilcam-pipeline',
    SCANNER_ENABLED: 'false',
    SHUTDOWN_GRACE_MS: '1000',
    CODEX_BIN: '/not-available',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '',
  browser;
server.stderr.on('data', (chunk) => (logs += chunk));
server.stdout.on('data', (chunk) => (logs += chunk));
const deadline = setTimeout(() => {
  server.kill('SIGKILL');
  process.exitCode = 1;
}, 45000);
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(logs);
    if (
      await fetch(origin + '/health')
        .then((r) => r.ok)
        .catch(() => false)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE || '/usr/bin/brave-browser',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error('Browser script:', error.message);
  });
  await page.goto(origin);
  await page.locator('#signUpMode').click();
  await page.locator('#email').fill('browser@example.com');
  await page.locator('#username').fill('browser_user');
  await page.locator('#password').fill('browser-fixture-password');
  await page.locator('#loginForm button[type=submit]').click();
  await page.locator('#newRecoveryCode').waitFor({ state: 'visible' });
  const recovery = await page.locator('#newRecoveryCode').inputValue();
  assert.match(recovery, /^[a-f0-9]{48}$/);
  await page.locator('#continueLink').click();
  await page.waitForFunction(() =>
    document.querySelector('#accountIdentity')?.textContent.includes('browser_user'),
  );
  await page.locator('[data-view=connections]').click();
  await page.locator('#connection-OPENAI_API_KEY').waitFor();
  assert.equal(await page.locator('#connectChatGPT').isDisabled(), true);
  assert.match(await page.locator('#chatGPTConnectionStatus').textContent(), /awaiting approval/);
  const key = page.locator('#connection-OPENAI_API_KEY');
  await key.fill('browser-fixture-key-not-a-real-secret');
  const card = key.locator('..');
  await card.locator('button[type=submit]').click();
  await card.locator('.connection-feedback').filter({ hasText: 'Saved.' }).waitFor();
  assert.equal(await key.inputValue(), '');
  assert.equal(
    await page.evaluate(() =>
      [...Object.values(localStorage), ...Object.values(sessionStorage)].some((value) =>
        value.includes('browser-fixture-key'),
      ),
    ),
    false,
  );
  assert.equal(await page.locator('[data-view=library]').isVisible(), false);
  await page.screenshot({ path: '/tmp/yesilcam-hosted-connections.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    true,
    'mobile has no horizontal overflow',
  );
  await page.screenshot({ path: '/tmp/yesilcam-hosted-mobile.png', fullPage: true });
  await page.locator('#logoutBtn').click();
  await page.locator('#login').fill('browser_user');
  await page.locator('#password').fill('browser-fixture-password');
  await page.locator('#loginForm button[type=submit]').click();
  await page.waitForFunction(() =>
    document.querySelector('#accountIdentity')?.textContent.includes('browser_user'),
  );
  await page.locator('[data-view=connections]').click();
  await page.locator('#connection-OPENAI_API_KEY').waitFor();
  assert.match(
    await page
      .locator('#connection-OPENAI_API_KEY')
      .locator('..')
      .locator('.connection-badge')
      .textContent(),
    /Not connected/,
  );
  await page.locator('#logoutBtn').click();
  await page.locator('#recoverMode').click();
  await page.locator('#email').fill('browser@example.com');
  await page.locator('#recoveryCode').fill(recovery);
  await page.locator('#password').fill('recovered-browser-password');
  await page.locator('#loginForm button[type=submit]').click();
  await page.locator('#newRecoveryCode').waitFor({ state: 'visible' });
  assert.notEqual(await page.locator('#newRecoveryCode').inputValue(), recovery);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Brave signup, recovery code rotation, BYOK key clearing, logout, disabled unapproved OAuth, desktop/mobile layouts',
  );
} finally {
  clearTimeout(deadline);
  await browser?.close();
  if (server.exitCode === null) {
    const exited = once(server, 'exit');
    server.kill('SIGTERM');
    const force = setTimeout(() => server.kill('SIGKILL'), 3000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
    }
  }
  await fs.rm(root, { recursive: true, force: true });
}
