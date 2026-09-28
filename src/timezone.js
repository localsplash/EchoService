// Default local dates/logs to Pacific; honor an explicit deployment override.
process.env.TZ ||= 'America/Los_Angeles';
