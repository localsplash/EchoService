'use strict';

/**
 * Settings live in NocoDB, not in the environment.
 *
 * Every application on the platform reads the same table: the base
 * `IdentityBase` (one base per repository, named `{Repo}Base`), table
 * `auth_tbl_Settings`. See localsplash/identify#15 for the standard; the
 * rules that matter here are:
 *
 *   - the base is found by NAME at runtime. A base name is unique because we
 *     say it is — NocoDB does not enforce it — and a base ID in a config file
 *     survives a rename and outlives a restore;
 *   - values AND the resolved base/table IDs sit on one 30-second clock, so a
 *     change in NocoDB — a rename or a restore included — reaches a running
 *     app without a restart;
 *   - any failure drops the cache, so the next attempt re-detects rather than
 *     reusing an ID it could not confirm;
 *   - there is no fallback. An app that cannot read its configuration says so.
 *
 * Only the identity service creates this base. Here a missing base is always
 * an error: a second base appearing by accident is exactly what the
 * unique-name convention exists to prevent.
 */

const SETTINGS_BASE_NAME = 'IdentityBase';
const SETTINGS_TABLE_NAME = 'auth_tbl_Settings';
const CACHE_TTL_MS = 30_000;

/** Keys this service reads. Any of them may be pinned in the environment. */
const SETTING_KEYS = [
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'CORS_ORIGINS',
  'WEBHOOK_BASIC_USER',
  'WEBHOOK_BASIC_PASS',
  'MEDIA_ROOT',
  'BANDWIDTH_ACCOUNT_ID',
  'BANDWIDTH_API_TOKEN',
  'BANDWIDTH_API_SECRET',
  'BANDWIDTH_APPLICATION_ID',
  'BANDWIDTH_MESSAGING_API_BASE_URL',
  // One value for the whole platform, not a per-app spelling of the same
  // network: the servers inside it are the first-party ones.
  'trustedCIDR',
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
  const take = (key, from) => {
    if (key in overrides) return;
    const raw = env[from];
    if (typeof raw === 'string' && raw.trim() !== '') overrides[key] = raw.trim();
  };
  for (const key of SETTING_KEYS) take(key, key);
  // `trustedCIDR` reads oddly as a variable name.
  take('trustedCIDR', 'IDENTITY_TRUSTED_NETWORK');
  return overrides;
}

let ids = null; // { at, baseId, tableId }
let cache = null; // { at, settings }

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

/** The base and table IDs, found by name. Cached, and dropped on failure. */
async function resolveIds() {
  if (ids && Date.now() - ids.at < CACHE_TTL_MS) return ids;
  const { baseUrl, token } = nocodb();
  if (!baseUrl || !token) {
    throw new SettingsUnavailableError(
      'unconfigured',
      'NOCODB_BASE_URL and NOCODB_API_TOKEN must both be set — they are the only two ' +
        'things this service reads from its environment.'
    );
  }
  try {
    const bases = await api('/api/v2/meta/bases');
    const matches = (bases.list || []).filter((b) => b.title === SETTINGS_BASE_NAME);
    if (matches.length === 0) {
      throw new SettingsUnavailableError(
        'base_missing',
        `No NocoDB base named ${SETTINGS_BASE_NAME} at ${baseUrl}. The base is found by ` +
          'name, so a renamed base looks like a missing one.'
      );
    }
    if (matches.length > 1) {
      throw new SettingsUnavailableError(
        'base_ambiguous',
        `${matches.length} NocoDB bases are named ${SETTINGS_BASE_NAME}. The name must be ` +
          'unique — this service will not guess which one holds its settings.'
      );
    }
    const baseId = matches[0].id;
    const tables = await api(`/api/v2/meta/bases/${baseId}/tables`);
    const table = (tables.list || []).find((t) => t.title === SETTINGS_TABLE_NAME);
    if (!table) {
      throw new SettingsUnavailableError(
        'table_missing',
        `The base ${SETTINGS_BASE_NAME} has no table named ${SETTINGS_TABLE_NAME}.`
      );
    }
    ids = { at: Date.now(), baseId, tableId: table.id };
    return ids;
  } catch (err) {
    ids = null; // never reuse an ID we could not confirm
    throw asUnavailable(err);
  }
}

/** Every row, with the environment overriding the store. */
async function refreshSettings() {
  const { tableId } = await resolveIds();
  try {
    const settings = {};
    let offset = 0;
    for (;;) {
      const page = await api(`/api/v2/tables/${tableId}/records?limit=200&offset=${offset}`);
      for (const row of page.list || []) {
        if (row.Key && row.Value != null && String(row.Value).trim() !== '') {
          settings[row.Key] = String(row.Value).trim();
        }
      }
      if ((page.list || []).length < 200 || (page.pageInfo && page.pageInfo.isLastPage !== false)) {
        break;
      }
      offset += 200;
    }
    Object.assign(settings, overridesFromEnv());
    cache = { at: Date.now(), settings };
    return settings;
  } catch (err) {
    ids = null; // the table ID may have gone stale with the base
    throw asUnavailable(err);
  }
}

/** Refresh only when the cache has aged out. */
async function ensureFreshSettings() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;
  return refreshSettings();
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
      'Settings have not been read yet — the settings store was unreachable at startup.'
    );
  }
  return cache.settings;
}

/** Drop the values and the resolved IDs; the retry path. */
function invalidateSettings() {
  cache = null;
  ids = null;
}

module.exports = {
  SETTINGS_BASE_NAME,
  SETTINGS_TABLE_NAME,
  CACHE_TTL_MS,
  SETTING_KEYS,
  SettingsUnavailableError,
  refreshSettings,
  ensureFreshSettings,
  settings,
  invalidateSettings,
};
