'use strict';

const CACHE_TTL_MS = 30_000;
const SCOPES = ['*', 'echo', 'echo-service'];

class SettingsUnavailableError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = 'SettingsUnavailableError';
    this.reason = reason;
  }
}

function settingsMode(env = process.env) {
  const mode = env.SETTINGS_MODE || 'platform';
  if (!['platform', 'legacy'].includes(mode)) {
    throw new SettingsUnavailableError('unconfigured', 'SETTINGS_MODE must be platform or legacy');
  }
  return mode;
}

function sourceNames(mode = settingsMode()) {
  return mode === 'legacy'
    ? { base: 'IdentityBase', table: 'auth_tbl_Settings' }
    : { base: 'PlatformConfig', table: 'cfg_tbl_Setting' };
}

/** Read-only discovery by name, scoped values, and a bounded cache. */
class NocoSettingsStore {
  constructor({ baseUrl, token, mode = settingsMode() }) {
    this.baseUrl = (baseUrl || '').replace(/\/+$/, '');
    this.token = token || '';
    this.mode = settingsMode({ SETTINGS_MODE: mode });
    this.invalidate();
  }

  invalidate() {
    this.ids = null;
    this.cache = null;
  }

  async api(path) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: { 'xc-token': this.token, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`NocoDB request failed (${response.status})`);
    const page = await response.json();
    if (!Array.isArray(page.list)) throw new Error('NocoDB returned an invalid record list');
    return page;
  }

  async resolveTable() {
    if (this.ids && Date.now() - this.ids.at < CACHE_TTL_MS) return this.ids.tableId;
    if (!this.baseUrl || !this.token) {
      throw new SettingsUnavailableError('unconfigured', 'NOCODB_BASE_URL and NOCODB_API_TOKEN are required');
    }
    const { base, table } = sourceNames(this.mode);
    const bases = await this.api('/api/v2/meta/bases');
    const matches = bases.list.filter((item) => item.title === base);
    if (matches.length !== 1) {
      throw new SettingsUnavailableError('unreachable', `Expected one NocoDB base named ${base}, found ${matches.length}`);
    }
    const tables = await this.api(`/api/v2/meta/bases/${encodeURIComponent(matches[0].id)}/tables`);
    const matchingTables = tables.list.filter((item) => item.title === table);
    if (matchingTables.length !== 1) {
      throw new SettingsUnavailableError('unreachable', `Expected one ${table} table in ${base}, found ${matchingTables.length}`);
    }
    this.ids = { at: Date.now(), tableId: matchingTables[0].id };
    return this.ids.tableId;
  }

  async get() {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.values;
    try {
      const tableId = await this.resolveTable();
      const rows = [];
      for (let offset = 0; ; offset += 200) {
        const page = await this.api(`/api/v2/tables/${encodeURIComponent(tableId)}/records?limit=200&offset=${offset}`);
        rows.push(...page.list);
        if (page.list.length < 200 || page.pageInfo?.isLastPage === true) break;
      }
      const relevant = this.mode === 'legacy'
        ? rows.filter((row) => row.Key === 'trustedCIDR')
        : rows.filter((row) => SCOPES.includes(row.app));
      const seen = new Set();
      for (const row of relevant) {
        const key = this.mode === 'legacy' ? row.Key : row.settingKey;
        if (typeof key !== 'string' || !key.trim()) throw new Error('Invalid scoped configuration key');
        const scopedKey = JSON.stringify([this.mode === 'legacy' ? 'legacy' : row.app, key]);
        if (seen.has(scopedKey)) throw new Error('Duplicate scoped configuration key');
        seen.add(scopedKey);
      }
      // Configuration keys must not change object inheritance.
      const values = Object.create(null);
      for (const scope of this.mode === 'legacy' ? [undefined] : SCOPES) {
        for (const row of relevant.filter((item) => this.mode === 'legacy' || item.app === scope)) {
          const key = this.mode === 'legacy' ? row.Key : row.settingKey;
          const raw = this.mode === 'legacy' ? row.Value : row.settingValue;
          if (raw != null && String(raw).trim()) values[key] = String(raw).trim();
        }
      }
      this.cache = { at: Date.now(), values };
      return values;
    } catch (error) {
      this.invalidate();
      if (error instanceof SettingsUnavailableError) throw error;
      // Do not include response bodies, configuration values, or the API token.
      throw new SettingsUnavailableError('unreachable', `Settings store could not be read: ${error.message}`);
    }
  }
}

module.exports = { CACHE_TTL_MS, SCOPES, SettingsUnavailableError, settingsMode, sourceNames, NocoSettingsStore };
