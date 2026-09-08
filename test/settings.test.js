'use strict';
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { NocoSettingsStore, settingsMode, CACHE_TTL_MS } = require('../src/nocoSettings');
const { refreshSettings, ensureFreshSettings, settings, invalidateSettings } = require('../src/settings');
const { verifyStore } = require('../src/setup');
const { applyLocalConfig } = require('../src/localConfig');
const originalFetch = global.fetch;
const originalNow = Date.now;
const originalEnv = { ...process.env };
afterEach(() => {
  global.fetch = originalFetch;
  Date.now = originalNow;
  process.env = { ...originalEnv };
  invalidateSettings();
});
const row = (app, settingKey, settingValue) => ({ app, settingKey, settingValue });
function mockStore(rows = [], options = {}) {
  const requests = [];
  global.fetch = async (url, init) => {
    requests.push({ url, init });
    let page;
    if (url.endsWith('/meta/bases')) page = { list: options.bases || [{ id: 'base', title: options.legacy ? 'IdentityBase' : 'PlatformConfig' }] };
    else if (url.endsWith('/tables')) page = { list: options.tables || [{ id: 'table', title: options.legacy ? 'auth_tbl_Settings' : 'cfg_tbl_Setting' }] };
    else {
      const offset = Number(new URL(url).searchParams.get('offset'));
      page = { list: rows.slice(offset, offset + 200), pageInfo: { isLastPage: offset + 200 >= rows.length } };
    }
    return { ok: true, json: async () => page };
  };
  return requests;
}
function store(mode = 'platform') {
  return new NocoSettingsStore({ baseUrl: 'http://nocodb/', token: 'test-token', mode });
}
function bootstrap() {
  for (const key of ['SETTINGS_MODE', 'CORS_ORIGINS', 'IDENTITY_TRUSTED_NETWORK']) delete process.env[key];
  process.env.NOCODB_BASE_URL = 'http://nocodb';
  process.env.NOCODB_API_TOKEN = 'test-token';
}
const noSql = { query: async () => { throw new Error('Platform mode must not query SQL'); } };

test('scopes are global < echo < echo-service; blanks inherit and siblings are excluded', async () => {
  const requests = mockStore([
    row('*', 'CORS_ORIGINS', 'global'), row('echo', 'CORS_ORIGINS', 'echo'),
    row('echo-service', 'CORS_ORIGINS', 'service'), row('*', 'trustedCIDR', '10.0.0.0/8'),
    row('echo-service', 'trustedCIDR', '  '), row('echo-web', 'IDENTITY_CLIENT_SECRET', 'private'),
  ]);
  assert.deepEqual({ ...await store().get() }, { CORS_ORIGINS: 'service', trustedCIDR: '10.0.0.0/8' });
  for (const request of requests) {
    assert.equal(request.init.redirect, 'error');
    assert.ok(request.init.signal instanceof AbortSignal);
    assert.equal(request.init.headers['xc-token'], 'test-token');
  }
});

test('paginates before applying precedence and ignores unrelated duplicate keys', async () => {
  const rows = Array.from({ length: 200 }, () => row('identity', 'PRIVATE', 'private'));
  rows.push(row('*', 'KEY', 'global'), row('echo-service', 'KEY', 'scoped'));
  const requests = mockStore(rows);
  assert.deepEqual({ ...await store().get() }, { KEY: 'scoped' });
  assert.ok(requests.some((request) => request.url.endsWith('offset=200')));
});

test('duplicate scoped keys fail, including duplicates on later pages', async () => {
  const rows = [row('echo', 'KEY', 'one'), ...Array.from({ length: 199 }, (_, i) => row('identity', String(i), 'x')), row('echo', 'KEY', 'two')];
  mockStore(rows);
  await assert.rejects(store().get(), /Duplicate scoped configuration key/);
});

test('missing and ambiguous names fail instead of selecting a legacy source', async () => {
  for (const options of [
    { bases: [] }, { bases: [{ id: 'a', title: 'PlatformConfig' }, { id: 'b', title: 'PlatformConfig' }] },
    { tables: [] }, { tables: [{ id: 'a', title: 'cfg_tbl_Setting' }, { id: 'b', title: 'cfg_tbl_Setting' }] },
    { legacy: true },
  ]) {
    mockStore([], options);
    await assert.rejects(store().get(), /Expected one/);
  }
});

test('cache expires after 30 seconds; failure discards IDs and values and recovers', async () => {
  let now = 100_000;
  Date.now = () => now;
  const requests = mockStore([row('*', 'KEY', 'first')]);
  const reader = store();
  await reader.get();
  now += CACHE_TTL_MS - 1;
  await reader.get();
  assert.equal(requests.length, 3);
  now += 1;
  global.fetch = async () => ({ ok: false, status: 503, text: async () => 'secret-body' });
  await assert.rejects(reader.get(), (error) => /503/.test(error.message) && !error.message.includes('secret-body'));
  const recovered = mockStore([row('*', 'KEY', 'second')]);
  assert.equal((await reader.get()).KEY, 'second');
  assert.equal(recovered.length, 3);
});

test('platform refresh does not use SQL; environment overrides do not bypass its source', async () => {
  bootstrap();
  process.env.CORS_ORIGINS = 'env';
  mockStore([row('echo-service', 'CORS_ORIGINS', 'row')]);
  assert.equal((await refreshSettings(noSql)).CORS_ORIGINS, 'env');
  invalidateSettings();
  global.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(refreshSettings(noSql), /offline/);
  assert.throws(settings, /not been read/);
});

test('expired runtime snapshots are unavailable after a failed refresh', async () => {
  bootstrap();
  let now = 100_000;
  Date.now = () => now;
  mockStore([row('echo-service', 'WEBHOOK_BASIC_PASS', 'old')]);
  await refreshSettings(noSql);
  now += CACHE_TTL_MS;
  global.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(ensureFreshSettings(noSql), /offline/);
  assert.throws(settings, /not been read/);
  mockStore([row('echo-service', 'WEBHOOK_BASIC_PASS', 'new')]);
  assert.equal((await ensureFreshSettings(noSql)).WEBHOOK_BASIC_PASS, 'new');
});

test('legacy SQL and IdentityBase require the explicit mode', async () => {
  bootstrap();
  process.env.SETTINGS_MODE = 'legacy';
  mockStore([{ Key: 'trustedCIDR', Value: '10.0.0.0/8' }], { legacy: true });
  let queries = 0;
  const pool = { query: async (sql, params) => {
    queries++;
    assert.match(sql, /echo_tbl_Settings/);
    assert.deepEqual(params, ['service', 'service']);
    return [[{ sKey: 'CORS_ORIGINS', sValue: 'legacy' }]];
  } };
  const values = await refreshSettings(pool);
  assert.equal(queries, 1);
  assert.equal(values.CORS_ORIGINS, 'legacy');
  assert.equal(values.trustedCIDR, '10.0.0.0/8');
  assert.throws(() => settingsMode({ SETTINGS_MODE: 'typo' }), /platform or legacy/);
});

test('setup verifies the same scoped platform source and rejects legacy-only configuration', async () => {
  bootstrap();
  mockStore([row('*', 'trustedCIDR', '10.0.0.0/8'), row('echo-service', 'trustedCIDR', '')]);
  assert.deepEqual(await verifyStore('http://nocodb', 'token'), { trustedCIDR: '10.0.0.0/8', trustedCIDRSet: true });
  mockStore([{ Key: 'trustedCIDR', Value: '10.0.0.0/8' }], { legacy: true });
  await assert.rejects(verifyStore('http://nocodb', 'token'), /PlatformConfig/);
});

test('complete environment bootstrap skips the optional config file', () => {
  const env = { NOCODB_BASE_URL: 'http://nocodb', NOCODB_API_TOKEN: 'token' };
  // A directory is deliberately not a valid bootstrap file.
  assert.deepEqual(applyLocalConfig(env, __dirname), {});
  assert.throws(() => applyLocalConfig({ NOCODB_BASE_URL: 'http://nocodb' }, __dirname), /could not be read/);
});
