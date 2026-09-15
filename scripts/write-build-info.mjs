import process from 'node:process';
import console from 'node:console';
import { dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let revision, epoch, dirty;
if (process.env.BUILD_REVISION || process.env.SOURCE_DATE_EPOCH) {
  // Source archives/containers have no Git metadata. Require a complete identity.
  revision = process.env.BUILD_REVISION;
  epoch = process.env.SOURCE_DATE_EPOCH;
  if (!['true', 'false'].includes(process.env.BUILD_DIRTY)) {
    throw new Error('Explicit metadata requires BUILD_DIRTY=true or false');
  }
  dirty = process.env.BUILD_DIRTY === 'true';
} else {
  revision = git('rev-parse', 'HEAD');
  epoch = git('show', '-s', '--format=%ct', 'HEAD');
  dirty = git('status', '--porcelain', '--untracked-files=normal').length > 0;
}
if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(revision ?? '') || !/^\d+$/.test(epoch ?? '')) {
  throw new Error('Build requires a full BUILD_REVISION and integer SOURCE_DATE_EPOCH, or a Git checkout');
}
const date = new Date(Number(epoch) * 1000);
if (!Number.isSafeInteger(Number(epoch)) || !Number.isFinite(date.getTime())) {
  throw new Error('Invalid SOURCE_DATE_EPOCH');
}
// Pin the display zone so developer machines and CI produce the same identity.
const timeZone = 'America/Los_Angeles';
const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23', timeZoneName: 'longOffset',
}).formatToParts(date).map(({ type, value }) => [type, value]));
const version = ['year', 'month', 'day', 'hour', 'minute'].map(key => Number(parts[key])).join('.');
const sourceUpdatedAt = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${parts.timeZoneName.replace('GMT', '')}`;
const buildInfo = { version: version + (dirty ? '-dirty' : ''), revision, sourceUpdatedAt, timeZone, dirty };
const output = process.argv[2] || 'dist/build-info.json';
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(buildInfo, null, 2) + '\n');
console.log(JSON.stringify(buildInfo));
