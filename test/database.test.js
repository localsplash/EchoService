'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { poolCoordinates } = require('../src/database');

test('database coordinates use scoped settings, derive the host, and ignore environment pins', () => {
  const prior = process.env.DB_HOST;
  process.env.DB_HOST = 'stale-environment';
  try {
    const config = { PARENT_DOMAIN: 'example.org', DB_USER: 'echo_service', DB_NAME: 'echo_db', DB_PASSWORD: 'row-secret' };
    assert.equal(poolCoordinates(config).host, 'lsdb.example.org');
    assert.equal(poolCoordinates(config).password, 'row-secret');
    assert.equal(poolCoordinates(config).port, 3306);
    assert.equal(poolCoordinates({ ...config, DB_HOST: 'private-db', DB_PORT: '3307' }).host, 'private-db');
    for (const port of ['3306oops', '0', '-1', '65536', '3.5']) {
      assert.throws(() => poolCoordinates({ ...config, DB_PORT: port }), /DB_PORT/);
    }
    assert.throws(() => poolCoordinates({ PARENT_DOMAIN: 'example.org' }), /PlatformConfig/);
  } finally {
    if (prior === undefined) delete process.env.DB_HOST; else process.env.DB_HOST = prior;
  }
});
