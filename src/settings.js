'use strict';

const {
  CACHE_TTL_MS, SettingsUnavailableError, NocoSettingsStore,
} = require('./nocoSettings');

/**
 * Runtime keys, read only from PlatformConfig.
 *
 * A same-named environment variable is ignored. These used to be pinnable in
 * the environment, where a nonblank value won over the row — and because most
 * of them are credentials, a stale pin meant rotating WEBHOOK_BASIC_PASS or a
 * Bandwidth secret in the store appeared to work while the old value stayed in
 * force, with nothing on the host to say why.
 *
 * IDENTITY_TRUSTED_NETWORK is deliberately not one of these: it is a
 * deployment network-policy pin resolved ahead of the store in
 * readTrustedCidr(), not a runtime setting. Leave it where it is.
 */
const SETTING_KEYS = [
  'PARENT_DOMAIN',
  'CORS_ORIGINS',
  'TYCHRON_SMS_URL',
  'TYCHRON_MMS_URL',
  'WEBHOOK_BASIC_USER',
  'WEBHOOK_BASIC_PASS',
  'BANDWIDTH_ACCOUNT_ID',
  'BANDWIDTH_API_TOKEN',
  'BANDWIDTH_API_SECRET',
  'BANDWIDTH_APPLICATION_ID',
  'BANDWIDTH_MESSAGING_API_BASE_URL',
];

let cache = null;
let store = null;

function nocoStore() {
  if (!store) store = new NocoSettingsStore({
    baseUrl: process.env.NOCODB_BASE_URL,
    token: process.env.NOCODB_API_TOKEN,
  });
  return store;
}

/** No configured policy means trust nobody. Platform reads never fall back. */
async function readTrustedCidr() {
  const pinned = (process.env.IDENTITY_TRUSTED_NETWORK || '').trim();
  if (pinned) return pinned;
  return (await nocoStore().get()).trustedCIDR || '';
}

async function refreshSettings() {
  try {
    const values = { ...(await nocoStore().get()) };
    values.trustedCIDR = (process.env.IDENTITY_TRUSTED_NETWORK || '').trim() || values.trustedCIDR || '';
    cache = { at: Date.now(), settings: values };
    return values;
  } catch (error) {
    // Expired settings must not remain available through the synchronous reader.
    invalidateSettings();
    if (error instanceof SettingsUnavailableError) throw error;
    throw new SettingsUnavailableError('unreachable', 'Echo settings could not be read');
  }
}

async function ensureFreshSettings() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.settings;
  return refreshSettings();
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
  CACHE_TTL_MS, SETTING_KEYS,
  SettingsUnavailableError, readTrustedCidr, refreshSettings,
  ensureFreshSettings, settings, invalidateSettings,
};
