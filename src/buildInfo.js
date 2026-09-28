const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const metadataPath = join(__dirname, 'build-info.json');
module.exports = Object.freeze(existsSync(metadataPath)
  ? JSON.parse(readFileSync(metadataPath, 'utf8'))
  : { version: 'unbuilt', revision: null, sourceUpdatedAt: null, timeZone: 'America/Los_Angeles', dirty: null });
