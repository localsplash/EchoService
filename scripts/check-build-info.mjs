import process from 'node:process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./write-build-info.mjs', import.meta.url));
const timestamp = '2026-01-02T03:04:59+05:00';
const epoch = String(Date.parse(timestamp) / 1000);

test('build identity is stable, Pacific, revision-specific, and marks uncommitted changes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'aida-build-'));
  const env = { ...process.env };
  delete env.BUILD_REVISION;
  delete env.SOURCE_DATE_EPOCH;
  delete env.BUILD_DIRTY;
  const git = (...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const build = (overrides = {}) => JSON.parse(execFileSync(process.execPath, [script], { cwd, env: { ...env, ...overrides }, encoding: 'utf8', stdio: 'pipe' }));
  try {
    git('init');
    git('config', 'user.name', 'Build test');
    git('config', 'user.email', 'build@example.invalid');
    writeFileSync(join(cwd, '.gitignore'), 'dist/\n');
    git('add', '.');
    execFileSync('git', ['commit', '-m', 'fixture'], { cwd, env: { ...env, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp }, stdio: 'pipe' });
    const clean = build();
    assert.deepEqual(clean, { version: '2026.1.1.14.4', revision: git('rev-parse', 'HEAD'), sourceUpdatedAt: '2026-01-01T14:04:59-08:00', timeZone: 'America/Los_Angeles', dirty: false });
    const artifact = readFileSync(join(cwd, 'dist/build-info.json'), 'utf8');
    assert.deepEqual(build({ TZ: 'Pacific/Honolulu' }), clean);
    assert.equal(readFileSync(join(cwd, 'dist/build-info.json'), 'utf8'), artifact);
    writeFileSync(join(cwd, 'new-source'), 'uncommitted');
    assert.equal(build().version, '2026.1.1.14.4-dirty');
    assert.equal(build().dirty, true);
    git('add', 'new-source');
    assert.equal(build().dirty, true);
    execFileSync('git', ['commit', '-m', 'same minute'], { cwd, env: { ...env, GIT_AUTHOR_DATE: timestamp, GIT_COMMITTER_DATE: timestamp }, stdio: 'pipe' });
    assert.equal(build().version, clean.version);
    assert.notEqual(build().revision, clean.revision);
    rmSync(join(cwd, '.git'), { recursive: true });
    assert.deepEqual(build({ BUILD_REVISION: clean.revision, SOURCE_DATE_EPOCH: epoch, BUILD_DIRTY: 'false' }), clean);
    for (const [utc, version, local] of [
      ['2026-09-14T21:30:42Z', '2026.9.14.14.30', '2026-09-14T14:30:42-07:00'],
      ['2026-03-08T09:59:00Z', '2026.3.8.1.59', '2026-03-08T01:59:00-08:00'],
      ['2026-03-08T10:00:00Z', '2026.3.8.3.0', '2026-03-08T03:00:00-07:00'],
      ['2026-11-01T08:30:00Z', '2026.11.1.1.30', '2026-11-01T01:30:00-07:00'],
      ['2026-11-01T09:30:00Z', '2026.11.1.1.30', '2026-11-01T01:30:00-08:00'],
      ['2026-01-02T08:00:00Z', '2026.1.2.0.0', '2026-01-02T00:00:00-08:00'],
    ]) {
      const info = build({ BUILD_REVISION: clean.revision, SOURCE_DATE_EPOCH: String(Date.parse(utc) / 1000), BUILD_DIRTY: 'false', TZ: 'UTC' });
      assert.equal(info.version, version);
      assert.equal(info.sourceUpdatedAt, local);
    }
    assert.throws(() => build());
    assert.throws(() => build({ BUILD_REVISION: clean.revision }));
    assert.throws(() => build({ BUILD_REVISION: clean.revision, SOURCE_DATE_EPOCH: 'invalid', BUILD_DIRTY: 'false' }));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Test defaults and explicit overrides in fresh processes, before application imports.
test('runtime defaults to Pacific and honors an explicit timezone', () => {
  const modulePath = fileURLToPath(new URL('../src/timezone.js', import.meta.url));
  for (const [configured, expected] of [['', 'America/Los_Angeles'], ['UTC', 'UTC']]) {
    const output = execFileSync(process.execPath, [ '-e', `require(${JSON.stringify(modulePath)}); console.log(process.env.TZ)`], {
      env: { ...process.env, TZ: configured }, encoding: 'utf8',
    }).trim();
    assert.equal(output, expected);
  }
});
