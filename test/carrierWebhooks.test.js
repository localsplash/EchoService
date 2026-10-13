const test = require('node:test');
const assert = require('node:assert/strict');

const { carrierWebhookUrls } = require('../src/carrierWebhooks');

test('carrier webhook URLs derive from PARENT_DOMAIN', () => {
  const urls = carrierWebhookUrls({ PARENT_DOMAIN: ' Example.Test ' });
  assert.equal(urls.baseUrl, 'https://echo-webhook.example.test');
  assert.equal(urls.bandwidth.inbound, 'https://echo-webhook.example.test/v1/bandwidth/inbound');
  assert.equal(urls.bandwidth.status, 'https://echo-webhook.example.test/v1/bandwidth/status');
  assert.equal(urls.tychron.sms, 'https://echo-webhook.example.test/v1/tychron/sms');
  assert.equal(urls.tychron.mms, 'https://echo-webhook.example.test/v1/tychron/mms');
  assert.equal(urls.bandwidth.basicAuth.user, 'BANDWIDTH_WEBHOOK_BASIC_USER');
  assert.equal(urls.tychron.basicAuth.password, 'TYCHRON_WEBHOOK_BASIC_PASS');
});

test('carrier webhook URLs accept PARENT_DOMAIN written as a URL', () => {
  for (const value of ['https://example.test/', 'example.test.', 'example.test:443', 'HTTPS://Example.Test/path']) {
    assert.equal(carrierWebhookUrls({ PARENT_DOMAIN: value }).baseUrl, 'https://echo-webhook.example.test', value);
  }
});

test('carrier webhook URLs are absent without a usable domain', () => {
  assert.equal(carrierWebhookUrls({}), null);
  assert.equal(carrierWebhookUrls({ PARENT_DOMAIN: '' }), null);
  assert.equal(carrierWebhookUrls({ PARENT_DOMAIN: 'localhost' }), null);
  assert.equal(carrierWebhookUrls({ PARENT_DOMAIN: 'bad domain.test' }), null);
  assert.equal(carrierWebhookUrls({ PARENT_DOMAIN: 'user@evil.test' }), null);
});
