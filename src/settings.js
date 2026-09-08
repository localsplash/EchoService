'use strict';

const {
  CACHE_TTL_MS, SettingsUnavailableError, settingsMode, NocoSettingsStore,
} = require('./nocoSettings');

// Legacy SQL names are used only with explicit SETTINGS_MODE=legacy.
const APP_NAME = 'service';
const IDENTITY_BASE_NAME = 'IdentityBase';
const IDENTITY_TABLE_NAME = 'auth_tbl_Settings';
const SETTING_KEYS = [
  'CORS_ORIGINS',
  'WEBHOOK_BASIC_USER',
  'WEBHOOK_BASIC_PASS',
  'BANDWIDTH_ACCOUNT_ID',
  'BANDWIDTH_API_TOKEN',
  'BANDWIDTH_API_SECRET',
  'BANDWIDTH_APPLICATION_ID',
  'BANDWIDTH_MESSAGING_API_BASE_URL',
];

function overridesFromEnv(env = process.env) {
  const overrides = {};
  for (const key of SETTING_KEYS) {
    const raw = env[key];
    if (typeof raw === 'string' && raw.trim() !== '') overrides[key] = raw.trim();
  }
  return overrides;
}

let cache = null;
let store = null;

function nocoStore() {
  if (!store) store = new NocoSettingsStore({
    baseUrl: process.env.NOCODB_BASE_URL,
    token: process.env.NOCODB_API_TOKEN,
    mode: settingsMode(),
  });
  return store;
}

/** Legacy reader is retained for an operator-selected rollback only. */
async function readEchoSettings(pool, app = APP_NAME) {
  const [rows] = await pool.query(
    `SELECT sApp, sKey, sValue FROM echo_tbl_Settings
      WHERE sApp IN ('*', ?)
      ORDER BY sApp = ?`,
    [app, app]
  );
  const values = {};
  for (const row of rows) {
    if (row.sValue != null && String(row.sValue).trim() !== '') {
      values[row.sKey] = String(row.sValue).trim();
    }
  }
  return values;
}

/** No configured policy means trust nobody. Platform reads never fall back. */
async function readTrustedCidr() {
  const pinned = (process.env.IDENTITY_TRUSTED_NETWORK || '').trim();
  if (pinned) return pinned;
  return (await nocoStore().get()).trustedCIDR || '';
}

async function refreshSettings(pool) {
  try {
    let values;
    if (settingsMode() === 'legacy') {
      values = { ...(await readEchoSettings(pool)), ...overridesFromEnv() };
      // Preserve the legacy rollback's separate network-policy availability.
      const previous = cache?.settings.trustedCIDR;
      try {
        values.trustedCIDR = await readTrustedCidr();
      } catch (error) {
        values.trustedCIDR = previous === undefined ? '' : previous;
        values.trustedCIDRError = error.message;
      }
    } else {
      values = { ...(await nocoStore().get()), ...overridesFromEnv() };
      values.trustedCIDR = (process.env.IDENTITY_TRUSTED_NETWORK || '').trim() || values.trustedCIDR || '';
    }
    cache = { at: Date.now(), settings: values };
    return values;
  } catch (error) {
    // Expired settings must not remain available through the synchronous reader.
    invalidateSettings();
    if (error instanceof SettingsUnavailableError) throw error;
    throw new SettingsUnavailableError('unreachable', 'Echo settings could not be read');
  }
}

async function ensureFreshSettings(pool) {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;
  return refreshSettings(pool);
}

function settings() {
  if (!cache) throw new SettingsUnavailableError('unreachable', 'Application settings have not been read yet');
  return cache.settings;
}

function invalidateSettings() {
  cache = null;
  store?.invalidate();
  store = null;
}

module.exports = {
  APP_NAME, IDENTITY_BASE_NAME, IDENTITY_TABLE_NAME, CACHE_TTL_MS, SETTING_KEYS,
  SettingsUnavailableError, readEchoSettings, readTrustedCidr, refreshSettings,
  ensureFreshSettings, settings, invalidateSettings,
};
