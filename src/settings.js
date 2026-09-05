'use strict';

/**
 * Where EchoService's configuration comes from.
 *
 * Two sources, and the split is deliberate:
 *
 *   - **`echo_tbl_Settings` in the Echo database** holds everything about
 *     this service — the Bandwidth credentials, the webhook basic-auth pair,
 *     the CORS origins, the media root. Settings sit next to the data they
 *     describe, in the database EchoDatabase owns. Rows are keyed by `sApp`:
 *     `'*'` is read by every Echo app, `'service'` by this one, and this
 *     one's own row wins over the general one.
 *
 *   - **`trustedCIDR` in the IdentityBase NocoDB base** is the single
 *     exception, and the only thing read from outside the Echo database. It
 *     is platform-wide network policy that identity and every application
 *     have to agree on, so it is spelled once rather than copied into each
 *     application's own settings.
 *
 * Both are cached for 30 seconds, so a change reaches a running service
 * without a restart; both drop their cache on failure; and neither has a
 * fallback, because a service that cannot read its configuration should say
 * so rather than run on blanks.
 */

const CACHE_TTL_MS = 30_000;

/** This service's `sApp` in `echo_tbl_Settings`. */
const APP_NAME = 'service';

/** The NocoDB base holding the platform-wide network policy. */
const IDENTITY_BASE_NAME = 'IdentityBase';
const IDENTITY_TABLE_NAME = 'auth_tbl_Settings';

/** Keys that may be pinned in the environment, overriding their row. */
const SETTING_KEYS = [
  'CORS_ORIGINS',
  'WEBHOOK_BASIC_USER',
  'WEBHOOK_BASIC_PASS',
  'MEDIA_ROOT',
  'BANDWIDTH_ACCOUNT_ID',
  'BANDWIDTH_API_TOKEN',
  'BANDWIDTH_API_SECRET',
  'BANDWIDTH_APPLICATION_ID',
  'BANDWIDTH_MESSAGING_API_BASE_URL',
];

class SettingsUnavailableError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SettingsUnavailableError';
    this.reason = reason;
  }
}

function overridesFromEnv(env = process.env) {
  const overrides = {};
  for (const key of SETTING_KEYS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '') overrides[key] = raw.trim();
  }
  return overrides;
}

let cache = null; // { at, settings }
let identityIds = null; // { at, tableId }
let cidrCache = null; // { at, value }

// ─── The Echo database ────────────────────────────────────────────────────────

/**
 * This service's settings: the general rows, then its own on top.
 *
 * An empty value is "not set" rather than an empty string, so a blank row
 * never shadows a real value.
 */
async function readEchoSettings(pool, app = APP_NAME) {
  const [rows] = await pool.query(
    `SELECT sApp, sKey, sValue FROM echo_tbl_Settings
      WHERE sApp IN ('*', ?)
      ORDER BY sApp = ?`, // the service's own row sorts last, so it wins
    [app, app]
  );
  const settings = {};
  for (const row of rows) {
    if (row.sValue != null && String(row.sValue).trim() !== '') {
      settings[row.sKey] = String(row.sValue).trim();
    }
  }
  return settings;
}

// ─── IdentityBase, for the trusted network only ──────────────────────────────

function nocodb() {
  return {
    baseUrl: process.env.NOCODB_BASE_URL || '',
    token: process.env.NOCODB_API_TOKEN || '',
  };
}

async function api(path) {
  const { baseUrl, token } = nocodb();
  const resp = await fetch(`${baseUrl}${path}`, {
    headers: { 'xc-token': token, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`NocoDB GET ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

function asUnavailable(err) {
  if (err instanceof SettingsUnavailableError) return err;
  const { baseUrl } = nocodb();
  return new SettingsUnavailableError(
    'unreachable',
    `NocoDB at ${baseUrl} did not answer or rejected the token: ` +
      String(err && err.message ? err.message : err).slice(0, 200)
  );
}

/**
 * The IdentityBase settings table, found by NAME at runtime — never by an ID
 * from a config file, which survives a rename and outlives a restore. Two
 * bases with the name is a configuration error rather than a coin toss.
 */
async function resolveIdentityTable() {
  if (identityIds && Date.now() - identityIds.at < CACHE_TTL_MS) return identityIds.tableId;
  const { baseUrl, token } = nocodb();
  if (!baseUrl || !token) {
    throw new SettingsUnavailableError(
      'unconfigured',
      'NOCODB_BASE_URL and NOCODB_API_TOKEN must be set to read trustedCIDR from ' +
        `${IDENTITY_BASE_NAME}.`
    );
  }
  try {
    const bases = await api('/api/v2/meta/bases');
    const matches = (bases.list || []).filter((b) => b.title === IDENTITY_BASE_NAME);
    if (matches.length === 0) {
      throw new SettingsUnavailableError(
        'base_missing',
        `No NocoDB base named ${IDENTITY_BASE_NAME} at ${baseUrl}. The base is found by ` +
          'name, so a renamed base looks like a missing one.'
      );
    }
    if (matches.length > 1) {
      throw new SettingsUnavailableError(
        'base_ambiguous',
        `${matches.length} NocoDB bases are named ${IDENTITY_BASE_NAME}. The name must be ` +
          'unique — this service will not guess which one carries the network policy.'
      );
    }
    const tables = await api(`/api/v2/meta/bases/${matches[0].id}/tables`);
    const table = (tables.list || []).find((t) => t.title === IDENTITY_TABLE_NAME);
    if (!table) {
      throw new SettingsUnavailableError(
        'table_missing',
        `The base ${IDENTITY_BASE_NAME} has no table named ${IDENTITY_TABLE_NAME}.`
      );
    }
    identityIds = { at: Date.now(), tableId: table.id };
    return table.id;
  } catch (err) {
    identityIds = null; // never reuse an ID we could not confirm
    throw asUnavailable(err);
  }
}

/** The trusted network, or '' when the platform has not set one. */
async function readTrustedCidr() {
  const pinned = (process.env.IDENTITY_TRUSTED_NETWORK || '').trim();
  if (pinned) return pinned;
  if (cidrCache && Date.now() - cidrCache.at < CACHE_TTL_MS) return cidrCache.value;
  const tableId = await resolveIdentityTable();
  try {
    const page = await api(`/api/v2/tables/${tableId}/records?limit=200`);
    const row = (page.list || []).find((r) => r.Key === 'trustedCIDR');
    const value = row && row.Value != null ? String(row.Value).trim() : '';
    cidrCache = { at: Date.now(), value };
    return value;
  } catch (err) {
    identityIds = null; // the table ID may have gone stale with the base
    throw asUnavailable(err);
  }
}

// ─── The snapshot every call site reads ──────────────────────────────────────

/**
 * Read both sources and replace the snapshot.
 *
 * A failure to read the Echo database is fatal to the refresh: those rows are
 * this service's own configuration and running on the previous ones would be
 * running on a guess.
 *
 * `trustedCIDR` is never fatal here, which is a change of stance. It used to
 * throw, which meant NocoDB being briefly unreachable answered every request
 * with a 503 and — at startup — exited the process, so the one screen able to
 * explain the problem could never be drawn. It is now reported rather than
 * raised, in two ways:
 *
 *   - A failed *re-read* keeps the last known value and records why it is
 *     stale. This value is platform-wide policy that changes about never, and
 *     a blip in a second system should not make the policy less available than
 *     the service it protects.
 *   - A failure with nothing cached yields `''`, which every check in
 *     `trust.js` treats as "trust nobody". That is fail-closed, and
 *     `networkPolicy` turns it into a screen naming the cause with a retry.
 */
async function refreshSettings(pool) {
  const settings = { ...(await readEchoSettings(pool)), ...overridesFromEnv() };
  const previous = cache && cache.settings ? cache.settings.trustedCIDR : undefined;
  try {
    settings.trustedCIDR = await readTrustedCidr();
  } catch (err) {
    settings.trustedCIDR = previous === undefined ? '' : previous;
    settings.trustedCIDRError = err && err.message ? err.message : String(err);
  }
  cache = { at: Date.now(), settings };
  return settings;
}

/** Refresh only when the cache has aged out. */
async function ensureFreshSettings(pool) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;
  return refreshSettings(pool);
}

/**
 * The settings as last read, synchronously. Throws when nothing has been read
 * yet — a service that cannot read its configuration says so rather than
 * carrying on with blanks.
 */
function settings() {
  if (!cache) {
    throw new SettingsUnavailableError(
      'unreachable',
      'Settings have not been read yet — echo_tbl_Settings was unreachable at startup.'
    );
  }
  return cache.settings;
}

/** Drop the values and the resolved IdentityBase IDs; the retry path. */
function invalidateSettings() {
  cache = null;
  identityIds = null;
  cidrCache = null;
}

module.exports = {
  APP_NAME,
  IDENTITY_BASE_NAME,
  IDENTITY_TABLE_NAME,
  CACHE_TTL_MS,
  SETTING_KEYS,
  SettingsUnavailableError,
  readEchoSettings,
  readTrustedCidr,
  refreshSettings,
  ensureFreshSettings,
  settings,
  invalidateSettings,
};
