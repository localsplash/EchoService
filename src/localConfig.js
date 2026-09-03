'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The bootstrap file — the one piece of configuration that cannot live in
 * the configuration store, because it is how the store is found.
 *
 * Everything else about this service is a row in `echo_tbl_Settings`, and the
 * one value read from outside it — `trustedCIDR` — is a row in the NocoDB base
 * `IdentityBase`. The address of that NocoDB obviously cannot be either. That
 * is the whole content of this file: where it is, and the token to read it
 * with.
 *
 * This is deliberately the same shape, the same two keys and the same
 * precedence as identity's `src/localConfig.ts`. Two services that bootstrap
 * the same way can share one file, which is what makes a single-host install
 * zero-config: identity's `/setup` writes it, this service finds it already
 * there. See localsplash/EchoOrchestrator#7.
 *
 * It is NOT a second place to configure the service. Two keys, no more — the
 * moment the store is reachable, the store is the answer to everything. In
 * particular `trustedCIDR` is never written here: identity owns that row, and
 * this service only reads it.
 *
 * Precedence is environment first: a deployment that already states these as
 * variables keeps doing so and never grows a file it did not ask for.
 */

const LOCAL_CONFIG_DIR = process.env.ECHO_CONFIG_DIR || '/data';
const LOCAL_CONFIG_PATH = path.join(LOCAL_CONFIG_DIR, 'config.json');

/** The only keys this file may carry. Anything else is a settings row. */
const LOCAL_CONFIG_KEYS = ['NOCODB_BASE_URL', 'NOCODB_API_TOKEN'];

/** Raised when the bootstrap file exists but cannot be believed. */
class LocalConfigError extends Error {
  constructor(file, detail) {
    super(
      `${file} could not be read (${detail}). It holds the address of the ` +
        'settings store, so this service will not guess past it: repair the file, ' +
        'delete it to start the first-run wizard again, or state ' +
        'NOCODB_BASE_URL and NOCODB_API_TOKEN in the environment instead.'
    );
    this.name = 'LocalConfigError';
  }
}

/**
 * Read the bootstrap file. A missing file is the ordinary first-run state and
 * reads as "nothing set yet"; a corrupt one is an operator's problem and is
 * raised rather than silently treated as empty, which would look to them
 * exactly like a wizard that forgot what they typed.
 */
function readLocalConfig(file = LOCAL_CONFIG_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new LocalConfigError(file, String(err && err.message ? err.message : err));
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LocalConfigError(file, 'not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LocalConfigError(file, 'not a JSON object');
  }
  const out = {};
  for (const key of LOCAL_CONFIG_KEYS) {
    const value = parsed[key];
    // Blank counts as unset, matching how the environment is read.
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out;
}

/**
 * Write the bootstrap file, replacing it whole. Written to a temporary name in
 * the same directory and renamed over the target, so a crash mid-write leaves
 * the previous file intact rather than a half one — this is the file the
 * service needs in order to start at all.
 *
 * Mode 0600: it carries an API token.
 */
function writeLocalConfig(values, file = LOCAL_CONFIG_PATH) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(values, null, 2) + '\n';
  const tmp = path.join(dir, `.config.json.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* the temp file may not exist; the original error is the one to raise */
    }
    throw err;
  }
}

/**
 * Can the wizard persist what it collects? Checked before it offers to.
 *
 * A test of the directory as it stands, never an attempt to create it: this
 * runs on every status call, and a creating variant would put a blocking mkdir
 * of an operator-supplied path in a request handler.
 *
 * Note this is also how a shared, read-only mount announces itself. When
 * identity's config volume is mounted here `:ro`, the file is present and
 * readable but the directory is not writable — which is correct, and the
 * wizard never runs because there is nothing left to ask.
 */
function localConfigWritable(dir = LOCAL_CONFIG_DIR) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exit so the supervisor starts us again on the file we just wrote.
 *
 * The process reads its configuration once, at boot, and hands pieces of it to
 * things that hold it for their lifetime — the settings cache, the database
 * pool. Rebuilding all of that in place would be a second, less travelled way
 * to be configured; coming back up is the same path every other start takes.
 * Deliberately a named export so tests can stub it, and delayed so the
 * response reaches the browser first.
 */
function restartToApplyConfig(delayMs = 250) {
  setTimeout(() => process.exit(0), delayMs).unref();
}

/**
 * Fold the bootstrap file into an environment, without overriding anything
 * already stated there. Applied once at startup so every later reader sees one
 * merged picture and none of them has to know this file exists.
 */
function applyLocalConfig(env = process.env, file = LOCAL_CONFIG_PATH) {
  const local = readLocalConfig(file);
  for (const [key, value] of Object.entries(local)) {
    const stated = env[key];
    if (typeof stated !== 'string' || stated.trim() === '') env[key] = value;
  }
  return local;
}

/** Does this process know where its settings store is? */
function isBootstrapped(env = process.env) {
  return Boolean(
    (env.NOCODB_BASE_URL || '').trim() && (env.NOCODB_API_TOKEN || '').trim()
  );
}

module.exports = {
  LOCAL_CONFIG_DIR,
  LOCAL_CONFIG_PATH,
  LOCAL_CONFIG_KEYS,
  LocalConfigError,
  readLocalConfig,
  writeLocalConfig,
  localConfigWritable,
  restartToApplyConfig,
  applyLocalConfig,
  isBootstrapped,
};
