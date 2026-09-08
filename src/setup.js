'use strict';

const {
  LOCAL_CONFIG_PATH,
  localConfigWritable,
  writeLocalConfig,
  restartToApplyConfig,
  isBootstrapped,
} = require('./localConfig');
const { parseCidrList, ipv4ToNumber } = require('./trust');
const { sendOperatorPage } = require('./operatorPage');
const { NocoSettingsStore, settingsMode } = require('./nocoSettings');

/**
 * The first-run wizard: where the settings store is, and nothing else.
 *
 * Optional service-owned bootstrap for deployments without injected NocoDB
 * credentials. No shared Identity volume is required.
 *
 * It asks for two values, the same two identity's wizard asks for:
 * `NOCODB_BASE_URL` and `NOCODB_API_TOKEN`. It does NOT ask for `trustedCIDR`.
 * identity owns that row and writes it; this service only reads it. A second
 * place to set it would be a second way for two services to disagree about the
 * network policy, which is exactly what one shared row prevents.
 */

/** Only reachable while unconfigured — the wizard disappears once answered. */
function requireUnconfigured(req, res, next) {
  if (isBootstrapped()) {
    return res
      .status(409)
      .json({ error: 'This service already knows where its settings live.' });
  }
  return next();
}

/**
 * Setup is reachable from the deployment's own network only.
 *
 * An unconfigured service cannot consult `trustedCIDR` to decide who to trust
 * — the whole point of the wizard is that it does not know where that row
 * lives yet. So this uses a fixed rule instead of a configured one: loopback
 * and the RFC1918 ranges, which is where a first-run operator actually is
 * (an SSH tunnel, `docker exec`, or another container on the compose network).
 *
 * It matters because whoever answers this wizard chooses the NocoDB that
 * supplies `trustedCIDR` — and `trustedCIDR` is what lets a caller skip
 * webhook basic auth. An open first-run endpoint on a public interface would
 * hand that decision to whoever arrived first.
 *
 * `SETUP_ALLOW_FROM` widens it for an exotic deployment, and is the operator
 * saying so out loud.
 */
const DEFAULT_SETUP_CIDRS = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';

function setupPeerAllowed(req) {
  const raw = (process.env.SETUP_ALLOW_FROM || '').trim() || DEFAULT_SETUP_CIDRS;
  const cidrs = parseCidrList(raw);
  if (!cidrs.length) return false;
  const peerRaw = (req.socket && req.socket.remoteAddress) || '';
  // A dual-stack ::ffff:a.b.c.d peer is the kernel reporting IPv4.
  const peer = ipv4ToNumber(peerRaw.startsWith('::ffff:') ? peerRaw.slice(7) : peerRaw);
  if (peer === null) return false;
  return cidrs.some(({ network, mask }) => ((peer & mask) >>> 0) === network);
}

function requireLocalPeer(req, res, next) {
  if (setupPeerAllowed(req)) return next();
  return res.status(403).json({
    error:
      'Setup is reachable from the deployment network only. Run it from the host ' +
      '(the port is published on loopback), or set SETUP_ALLOW_FROM to widen it.',
  });
}

/** Trim to a bare origin: no trailing slash, no path, http(s) only. */
function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.origin;
}

/** Use the runtime reader to verify the selected store before saving. */
async function verifyStore(baseUrl, token) {
  const values = await new NocoSettingsStore({ baseUrl, token, mode: settingsMode() }).get();
  const trustedCIDR = values.trustedCIDR || '';
  return { trustedCIDR, trustedCIDRSet: parseCidrList(trustedCIDR).length > 0 };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EchoService setup</title>
<style>
 :root{color-scheme:light dark}
 body{font:15px/1.55 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1.25rem}
 h1{font-size:1.3rem;margin:0 0 .25rem}
 p.sub{color:#666;margin:0 0 1.75rem}
 label{display:block;margin:1.1rem 0 .3rem;font-weight:600}
 input{width:100%;padding:.55rem .65rem;font:inherit;border:1px solid #999;border-radius:6px;box-sizing:border-box}
 small{color:#666;display:block;margin-top:.3rem}
 button{margin-top:1.6rem;padding:.6rem 1.1rem;font:inherit;font-weight:600;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
 button[disabled]{opacity:.55;cursor:default}
 .msg{margin-top:1.2rem;padding:.75rem .9rem;border-radius:6px;white-space:pre-wrap}
 .err{background:#fee2e2;color:#991b1b}
 .ok{background:#dcfce7;color:#166534}
 .warn{background:#fef9c3;color:#854d0e}
</style></head><body>
<h1>EchoService setup</h1>
<p class="sub">Where the settings store is. Two values, asked once.</p>
<form id="f">
  <label for="u">NocoDB URL</label>
  <input id="u" name="u" placeholder="https://nocodb.example.com" autocomplete="off">
  <small>The same NocoDB the identity service uses.</small>
  <label for="t">NocoDB API token</label>
  <input id="t" name="t" type="password" autocomplete="off">
  <small>NocoDB &rarr; Account &rarr; Tokens. Stored at <code id="cp"></code>, mode 0600.</small>
  <button id="b" type="submit">Verify and save</button>
</form>
<div id="m"></div>
<script>
const m = document.getElementById('m'), b = document.getElementById('b');
function say(cls, text){ m.className = 'msg ' + cls; m.textContent = text; }
fetch('/api/setup/status').then(r => r.json()).then(s => {
  document.getElementById('cp').textContent = s.configPath || '/data/config.json';
  if (s.configured) say('ok', 'Already configured. This page has nothing left to ask.');
  else if (!s.configWritable) say('warn', s.configPath + ' is not writable, so this cannot be saved. Mount a writable volume there, or set NOCODB_BASE_URL and NOCODB_API_TOKEN in the environment instead.');
});
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  b.disabled = true; say('', 'Checking\\u2026');
  try {
    const r = await fetch('/api/setup/bootstrap', {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({ nocodbBaseUrl: document.getElementById('u').value, nocodbApiToken: document.getElementById('t').value })
    });
    const d = await r.json();
    if (!r.ok) { say('err', d.error || ('Failed with ' + r.status)); b.disabled = false; return; }
    say('ok', d.trustedCIDRSet
      ? 'Saved. Restarting to read it\\u2026'
      : 'Saved, and restarting \\u2014 but the selected settings store has no trustedCIDR value yet. Finish the identity service\\u2019s setup; this service reads that value, it does not set it.');
  } catch (err) { say('err', String(err)); b.disabled = false; }
});
</script></body></html>`;

/** Mount the wizard. Safe to call unconditionally; it gates itself. */
function mountSetup(app) {
  app.get('/setup', requireLocalPeer, (_req, res) => sendOperatorPage(res, PAGE));

  app.get('/api/setup/status', requireLocalPeer, (_req, res) => {
    res.json({
      configured: isBootstrapped(),
      configPath: LOCAL_CONFIG_PATH,
      configWritable: localConfigWritable(),
    });
  });

  app.post('/api/setup/bootstrap', requireLocalPeer, requireUnconfigured, async (req, res, next) => {
    try {
      if (!localConfigWritable()) {
        return res.status(503).json({
          error:
            `${LOCAL_CONFIG_PATH} is not writable, so this cannot be saved. Mount a ` +
            'writable volume there, or set NOCODB_BASE_URL and NOCODB_API_TOKEN in ' +
            "this service's environment instead.",
        });
      }

      const body = req.body || {};
      const token = String(body.nocodbApiToken || '').trim();
      const baseUrl = normalizeBaseUrl(body.nocodbBaseUrl);
      if (!baseUrl) {
        return res
          .status(400)
          .json({ error: 'Enter the NocoDB URL, e.g. https://nocodb.example.com.' });
      }
      if (!token) {
        return res.status(400).json({ error: 'Enter a NocoDB API token (Account → Tokens).' });
      }

      let probe;
      try {
        probe = await verifyStore(baseUrl, token);
      } catch (err) {
        return res.status(400).json({ error: err && err.message ? err.message : String(err) });
      }

      writeLocalConfig({ NOCODB_BASE_URL: baseUrl, NOCODB_API_TOKEN: token });
      console.log(`[setup] settings store recorded at ${LOCAL_CONFIG_PATH}; restarting to read it`);

      res.json({ ok: true, restarting: true, ...probe });
      res.on('finish', () => restartToApplyConfig());
      return undefined;
    } catch (err) {
      return next(err);
    }
  });
}

module.exports = { mountSetup, normalizeBaseUrl, setupPeerAllowed, verifyStore };
