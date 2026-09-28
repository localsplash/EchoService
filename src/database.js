'use strict';
const { SettingsUnavailableError } = require('./settings');

/** Coordinates are PlatformConfig settings; the first pool keeps them until restart. */
function poolCoordinates(config) {
  const parent = (config.PARENT_DOMAIN || '').trim();
  const host = (config.DB_HOST || '').trim() || (parent ? `lsdb.${parent}` : '');
  const user = (config.DB_USER || '').trim();
  const database = (config.DB_NAME || '').trim();
  if (!host || !user || !database) {
    throw new SettingsUnavailableError('unconfigured',
      'Configure DB_HOST (or PARENT_DOMAIN), DB_USER and DB_NAME in PlatformConfig for echo-service');
  }
  const port = Number(config.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SettingsUnavailableError('unconfigured', 'DB_PORT must be an integer from 1 to 65535 in PlatformConfig');
  }
  return { host, port, user, password: config.DB_PASSWORD || '', database,
    waitForConnections: true, connectionLimit: 10, timezone: 'Z' };
}

module.exports = { poolCoordinates };
