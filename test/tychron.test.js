'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tychronEndpoints, sendTychronSms, sendTychronMms } = require('../src/tychron');
const { refreshSettings, invalidateSettings } = require('../src/settings');

test('Tychron defaults use messaging APIs and platform/application overrides are independent', () => {
  assert.deepEqual(tychronEndpoints({}, {}), {
    smsUrl: 'https://sms.tychron.online/sms',
    mmsUrl: 'https://mms.tychron.online/api/v1/mms',
  });
  const platform = { TYCHRON_SMS_URL: 'https://sms.example/send', TYCHRON_MMS_URL: 'https://mms.example/send' };
  assert.deepEqual(tychronEndpoints({ smsUrl: 'https://staging.example/sms' }, platform), {
    smsUrl: 'https://staging.example/sms', mmsUrl: 'https://mms.example/send',
  });
  assert.throws(() => tychronEndpoints({}, { TYCHRON_SMS_URL: 'invalid' }), /TYCHRON_SMS_URL/);
  assert.throws(() => tychronEndpoints({ mmsUrl: 'file:///tmp/secret' }, {}), /carrier application mmsUrl/);
});

test('Tychron sends SMS and MMS with only a tenant API key and scoped platform endpoints', async (t) => {
  const oldFetch = global.fetch;
  const oldUrl = process.env.NOCODB_BASE_URL;
  const oldToken = process.env.NOCODB_API_TOKEN;
  t.after(() => {
    global.fetch = oldFetch;
    for (const [key, value] of [['NOCODB_BASE_URL', oldUrl], ['NOCODB_API_TOKEN', oldToken]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    invalidateSettings();
  });
  process.env.NOCODB_BASE_URL = 'http://settings.example';
  process.env.NOCODB_API_TOKEN = 'test-token';
  global.fetch = async (url) => {
    const list = String(url).endsWith('/meta/bases') ? [{ id: 'base', title: 'PlatformConfig' }]
      : String(url).endsWith('/tables') ? [{ id: 'table', title: 'cfg_tbl_Setting' }]
        : [
          { app: '*', settingKey: 'TYCHRON_SMS_URL', settingValue: 'https://global.example/sms' },
          { app: 'echo-service', settingKey: 'TYCHRON_SMS_URL', settingValue: 'https://sms.example/send' },
          { app: 'echo', settingKey: 'TYCHRON_MMS_URL', settingValue: 'https://mms.example/send' },
        ];
    return new Response(JSON.stringify({ list, pageInfo: { isLastPage: true } }));
  };
  await refreshSettings();
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(url.includes('sms.example')
      ? { '12025550123': { id: 'sms-id' } } : { records: [{ id: 'mms-id' }] }));
  };
  const message = { from: '+12025550124', to: '+12025550123', text: 'hello', settings: { apiToken: 'tenant-key' } };
  assert.equal((await sendTychronSms(message)).id, 'sms-id');
  assert.equal((await sendTychronMms({ ...message, attachments: [{ buffer: Buffer.from('image'), displayName: 'image.jpg', contentType: 'image/jpeg' }] })).id, 'mms-id');
  assert.deepEqual(calls.map((call) => call.url), ['https://sms.example/send', 'https://mms.example/send']);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tenant-key');
  assert.equal(JSON.parse(calls[1].options.body).parts[1].body, Buffer.from('image').toString('base64'));
  await assert.rejects(sendTychronSms({ ...message, settings: { applicationName: 'Test tenant' } }), /No Tychron API key on carrier application Test tenant/);
  assert.equal(calls.length, 2);
});
