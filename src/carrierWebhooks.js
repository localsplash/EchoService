'use strict';

const { settings } = require('./settings');

/**
 * The callback URLs operators register with each carrier.
 *
 * Built from PARENT_DOMAIN on the published `echo-webhook.<PARENT_DOMAIN>`
 * proxy host (see deploy/nginx/echo-webhook.X.TLD.conf), so the Carrier
 * Applications page can show the exact addresses for this environment instead
 * of a template the operator has to fill in by hand. Returns null when the
 * domain is unset or not a hostname, rather than a URL that cannot work.
 */
function carrierWebhookUrls(platform = settings()) {
  const domain = String(platform?.PARENT_DOMAIN || '').trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  const baseUrl = `https://echo-webhook.${domain}`;
  return {
    baseUrl,
    bandwidth: {
      inbound: `${baseUrl}/v1/bandwidth/inbound`,
      status: `${baseUrl}/v1/bandwidth/status`,
      basicAuth: { user: 'BANDWIDTH_WEBHOOK_BASIC_USER', password: 'BANDWIDTH_WEBHOOK_BASIC_PASS' },
    },
    tychron: {
      sms: `${baseUrl}/v1/tychron/sms`,
      mms: `${baseUrl}/v1/tychron/mms`,
      basicAuth: { user: 'TYCHRON_WEBHOOK_BASIC_USER', password: 'TYCHRON_WEBHOOK_BASIC_PASS' },
    },
  };
}

module.exports = { carrierWebhookUrls };
