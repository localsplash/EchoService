'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

async function fixture(t, missing = false) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'echo-startup-test-'));
  t.after(() => fs.rm(tempDir, { recursive: true, force: true }));
  const requests = [];
  const api = http.createServer((req, res) => {
    requests.push(req.url);
    const list = missing ? [] : req.url.endsWith('/meta/bases')
      ? [{ id: 'base', title: 'PlatformConfig' }]
      : req.url.endsWith('/tables') ? [{ id: 'table', title: 'cfg_tbl_Setting' }]
      : [
        { app: '*', settingKey: 'PARENT_DOMAIN', settingValue: 'example.org' },
        { app: 'echo-service', settingKey: 'CORS_ORIGINS', settingValue: 'https://operator.example.net, http://localhost:3160' },
        { app: '*', settingKey: 'trustedCIDR', settingValue: '10.0.0.0/8' },
        { app: 'echo-service', settingKey: 'WEBHOOK_BASIC_USER', settingValue: 'test-user' },
        { app: 'echo-service', settingKey: 'WEBHOOK_BASIC_PASS', settingValue: 'test-pass' },
      ];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ list, pageInfo: { isLastPage: true } }));
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const env = {
    ...process.env, PORT: String(port),
    NOCODB_BASE_URL: `http://127.0.0.1:${api.address().port}`, NOCODB_API_TOKEN: 'test-token',
    // No MySQL server exists here: default startup must not query settings SQL.
    DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'unused', DB_USER: 'unused', DB_PASSWORD: '',
    MEDIA_ROOT: path.join(tempDir, 'media'), LOG_DIR: path.join(tempDir, 'logs'),
    ECHO_CONFIG_DIR: path.join(tempDir, 'no-bootstrap-file'),
  };
  for (const key of ['IDENTITY_TRUSTED_NETWORK', 'WEBHOOK_BASIC_USER', 'WEBHOOK_BASIC_PASS']) delete env[key];
  const child = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(__dirname, '..'), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  return { port, requests, child, exited, output: () => output };
}

test('real service starts from PlatformConfig without SQL settings and applies scoped webhook credentials', { timeout: 10_000 }, async (t) => {
  const f = await fixture(t);
  while (!f.output().includes('listening on')) {
    assert.equal(f.child.exitCode, null, f.output());
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.match(f.output(), /PlatformConfig\/cfg_tbl_Setting read/);
  const origin = `http://127.0.0.1:${f.port}`;
  for (const endpoint of ['/ping', '/healthz']) {
    const health = await fetch(origin + endpoint);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { message: 'pong', service: 'EchoService', ...require('../src/buildInfo') });
  }
  for (const path of ['/v1/bandwidth/status', '/v1/tychron/sms', '/v1/tychron/mms']) {
    const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 401, path);
  }
  for (const path of ['/webhooks/bandwidth/inbound', '/webhooks/tychron/sms', '/v1/unrelated/action', '/api/carrier-applications']) {
    const response = await fetch(origin + path, { method: 'POST' });
    assert.equal(response.status, 403, path);
  }
  const denied = await fetch(`${origin}/v1/bandwidth/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' });
  assert.equal(denied.status, 401);
  const accepted = await fetch(`${origin}/v1/bandwidth/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from('test-user:test-pass').toString('base64')}` }, body: '[]' });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).ok, true);
  for (const allowed of ['https://echo.example.org', 'https://operator.example.net', 'http://localhost:3160']) {
    const response = await fetch(`${origin}/v1/bandwidth/inbound`, { method: 'OPTIONS', headers: { Origin: allowed, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), allowed);
  }
  for (const blocked of ['https://wisp.net', 'https://echo.wisp.net', 'https://unknown.local', 'https://unknown.test', 'https://unknown.internal', 'http://localhost:9999', 'https://echo.example.org.attacker.test']) {
    const response = await fetch(`${origin}/v1/bandwidth/inbound`, { method: 'OPTIONS', headers: { Origin: blocked, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.notEqual(response.status, 204);
  }
  assert.equal(f.requests.length, 3);
});

test('configured startup retries once then exits when PlatformConfig is missing', { timeout: 12_000 }, async (t) => {
  const f = await fixture(t, true);
  const [code] = await f.exited;
  assert.equal(code, 1, f.output());
  assert.equal(f.requests.length, 2);
  assert.match(f.output(), /retrying once in 5s/);
  assert.doesNotMatch(f.output(), /listening on/);
});
