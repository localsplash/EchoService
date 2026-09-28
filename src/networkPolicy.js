'use strict';

/**
 * Who is allowed to talk to this service.
 *
 * The service answers on a public hostname behind a shared reverse proxy, and
 * until now every route except the carrier webhooks was open to the internet —
 * `GET /api/conversations?businessNumber=...` returned customer numbers and
 * message bodies to anyone who knew the name. CORS did not prevent that; CORS
 * is a browser policy and a non-browser client ignores it.
 *
 * The rule is `trustedCIDR`, the platform-wide network policy that `identity`
 * owns in `PlatformConfig.cfg_tbl_Setting` (global scope) and every application reads. One
 * value, spelled once, rather than an allow-list per service that drifts.
 *
 * ── Two deliberate exceptions ───────────────────────────────────────────────
 *
 * **The carrier webhooks stay open.** Tychron and Bandwidth call from their own
 * networks, which are by definition outside `trustedCIDR`. Putting them behind
 * it would close the inbound message path permanently. They keep the control
 * they already had — basic auth, from the selected settings store — and `webhookWatch`
 * records what happens on them so a silent carrier stays visible.
 *
 * **`/ping` stays open.** It is settings-free by design so that "the process is
 * up" stays answerable when everything else is not, and it reveals nothing.
 *
 * ── The lifecycle ───────────────────────────────────────────────────────────
 *
 * The policy is read once at launch and then held. It is not re-read per
 * request and it does not age out: this value changes about never, and a
 * dependency on NocoDB being reachable *right now* would make the policy less
 * available than the service it protects. Reloading is something an operator
 * asks for — `POST /api/policy/reload`, or the button on the error screen.
 *
 * Until it loads, the service refuses gated traffic and says which of the two
 * things went wrong, because they have different fixes: NocoDB could not be
 * reached (check the URL, the token, the network) versus NocoDB answered and
 * has no `trustedCIDR` row (finish `identity`'s setup — this service reads that
 * row, it does not write it).
 */

const { readTrustedCidr, SettingsUnavailableError } = require('./settings');
const { sourceNames } = require('./nocoSettings');
const policySource = () => { const { base, table } = sourceNames(); return `${base}.${table}`; };
const {
  clientIp,
  clientInTrustedNetwork,
  formatIpv4,
  parseCidrList,
  DEFAULT_TRUSTED_PROXIES,
} = require('./trust');
const { sendOperatorPage } = require('./operatorPage');

/**
 * Where a reverse proxy may sit. Kept separate from `trustedCIDR`: one says
 * "this address may speak for another", the other says "this address may use
 * the service". Conflating them is how a proxy's own subnet accidentally
 * becomes an allow-list.
 */
function trustedProxies() {
  return (process.env.TRUSTED_PROXIES || '').trim() || DEFAULT_TRUSTED_PROXIES;
}

/**
 * Who may see failure detail, and who may ask for a reload, while the policy
 * is unknown.
 *
 * The policy cannot gate the screen that explains why the policy is missing,
 * so this uses the fixed deployment bootstrap networks:
 * loopback and the RFC1918 ranges, which is where an operator actually is. It
 * is applied to the *resolved* client address, not the socket peer — behind
 * the proxy every peer is RFC1918 and the check would pass for the whole
 * internet.
 */
const BOOTSTRAP_CIDRS = '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16';

let state = {
  status: 'loading', // loading | ready | unreachable | unset
  trustedCIDR: '',
  networks: [],
  loadedAt: null,
  error: null,
};

function isReady() {
  return state.status === 'ready';
}

function policyState() {
  return { ...state, trustedProxies: trustedProxies() };
}

/**
 * Read the policy and adopt it.
 *
 * A read that succeeds but returns nothing is `unset`, not an empty allow-list
 * — the difference between "nobody is allowed" and "nobody has said yet" is
 * the whole content of the error screen. A failed reload never discards a
 * policy already in force; the service keeps running on what it had.
 */
async function loadPolicy() {
  try {
    const raw = await readTrustedCidr();
    const networks = parseCidrList(raw);
    if (!networks.length) {
      if (isReady()) {
        console.warn(
          '[policy] reload found no trustedCIDR; keeping the policy already in force'
        );
        return policyState();
      }
      state = {
        status: 'unset',
        trustedCIDR: '',
        networks: [],
        loadedAt: null,
        error:
          `${policySource()} has no trustedCIDR value. The identity ` +
          'service owns that row — this service reads it and will not invent a ' +
          'network policy of its own.',
      };
      console.error('[policy] no trustedCIDR set — refusing all non-webhook traffic');
      return policyState();
    }
    state = {
      status: 'ready',
      trustedCIDR: raw,
      networks,
      loadedAt: new Date().toISOString(),
      error: null,
    };
    console.log(`[policy] trusted network: ${raw}`);
    return policyState();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (isReady()) {
      console.warn(`[policy] reload failed, keeping the policy in force: ${message}`);
      return policyState();
    }
    state = {
      status: 'unreachable',
      trustedCIDR: '',
      networks: [],
      loadedAt: null,
      error: message,
      reason: err instanceof SettingsUnavailableError ? err.reason : 'unreachable',
    };
    console.error(`[policy] could not read trustedCIDR — refusing all non-webhook traffic: ${message}`);
    return policyState();
  }
}

function fromBootstrapNetwork(req) {
  return clientInTrustedNetwork(req, BOOTSTRAP_CIDRS, trustedProxies());
}

function callerAddress(req) {
  return formatIpv4(clientIp(req, trustedProxies()).ip);
}

// ─── The screens ─────────────────────────────────────────────────────────────

function wantsHtml(req) {
  return String((req.headers && req.headers.accept) || '').includes('text/html');
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

const SCREEN_CSS = `
 :root{color-scheme:light dark}
 body{font:15px/1.6 system-ui,sans-serif;max-width:38rem;margin:3.5rem auto;padding:0 1.25rem}
 h1{font-size:1.25rem;margin:0 0 .4rem}
 p{margin:0 0 1rem;color:#555}
 .detail{background:#fef9c3;color:#854d0e;padding:.8rem .95rem;border-radius:6px;white-space:pre-wrap;font:13px/1.5 ui-monospace,monospace}
 .addr{font:13px ui-monospace,monospace;color:#666}
 button{margin-top:1.4rem;padding:.55rem 1rem;font:inherit;font-weight:600;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
 button[disabled]{opacity:.55;cursor:default}
 .msg{margin-top:1rem;padding:.7rem .9rem;border-radius:6px;white-space:pre-wrap}
 .err{background:#fee2e2;color:#991b1b}
 .ok{background:#dcfce7;color:#166534}
`;

/** The screen shown while the policy is unknown; retry is the only action. */
function unavailableScreen({ title, lead, detail }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EchoService — ${escapeHtml(title)}</title>
<style>${SCREEN_CSS}</style></head><body>
<h1>${escapeHtml(title)}</h1>
<p>${lead}</p>
${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ''}
<button id="r" type="button">Retry now</button>
<div id="m"></div>
<script>
const m = document.getElementById('m'), b = document.getElementById('r');
b.addEventListener('click', async () => {
  b.disabled = true; m.className = 'msg'; m.textContent = 'Re-reading the policy\\u2026';
  try {
    const res = await fetch('/api/policy/reload', { method: 'POST' });
    const d = await res.json();
    if (d.status === 'ready') { m.className = 'msg ok'; m.textContent = 'Loaded. Reloading\\u2026'; setTimeout(() => location.reload(), 700); return; }
    m.className = 'msg err'; m.textContent = d.error || ('Still ' + d.status + '.');
  } catch (err) { m.className = 'msg err'; m.textContent = String(err); }
  b.disabled = false;
});
</script></body></html>`;
}

/** The screen shown to a caller the policy has excluded. Deliberately terse. */
function refusedScreen(address) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EchoService — not available here</title>
<style>${SCREEN_CSS}</style></head><body>
<h1>Not available from this network</h1>
<p>EchoService answers its own network only. Reach it from inside the platform,
or through the application that fronts it.</p>
<p class="addr">Your address: ${escapeHtml(address)}</p>
</body></html>`;
}

function refuse(req, res) {
  const address = callerAddress(req);
  console.warn(`[policy] refused ${req.method} ${req.originalUrl || req.url} from ${address}`);
  if (wantsHtml(req)) return sendOperatorPage(res, refusedScreen(address), 403);
  return res.status(403).json({
    ok: false,
    error: 'EchoService answers its own network only.',
    address,
  });
}

function unavailable(req, res) {
  // Only a caller who could plausibly fix this sees what is wrong; to anyone
  // else the NocoDB address and the failure mode are reconnaissance.
  const privileged = fromBootstrapNetwork(req);
  const detail = privileged ? state.error : null;
  const [title, lead] =
    state.status === 'unset'
      ? [
          'No network policy has been set',
          'This service decides who may reach it from <code>trustedCIDR</code> in ' +
            `<code>${policySource()}</code>, and that row has no value yet. ` +
            'Until it does, it refuses everything except the carrier webhooks.',
        ]
      : [
          'The network policy could not be read',
          'This service decides who may reach it from <code>trustedCIDR</code> in ' +
            `<code>${policySource()}</code>, and NocoDB did not answer. ` +
            'Until it does, it refuses everything except the carrier webhooks.',
        ];

  if (wantsHtml(req)) {
    return sendOperatorPage(res, unavailableScreen({ title, lead, detail }), 503);
  }
  return res.status(503).json({
    ok: false,
    status: state.status,
    error: detail || title,
  });
}

// ─── The gate ────────────────────────────────────────────────────────────────

/**
 * Refuse anyone the policy does not name. Mount it once, high in the stack;
 * the exempt routes are mounted above it.
 */
function requireTrustedNetwork(req, res, next) {
  if (!isReady()) return unavailable(req, res);
  if (clientInTrustedNetwork(req, state.trustedCIDR, trustedProxies())) return next();
  return refuse(req, res);
}

/**
 * Reachable while the policy is not, since it is the way out of that state.
 * Once a policy is in force it is an ordinary privileged endpoint.
 */
function canReload(req) {
  return isReady()
    ? clientInTrustedNetwork(req, state.trustedCIDR, trustedProxies())
    : fromBootstrapNetwork(req);
}

function mountPolicy(app) {
  app.get('/api/policy', (req, res) => {
    if (!canReload(req)) return refuse(req, res);
    const { networks, ...rest } = policyState();
    return res.json({ ...rest, caller: callerAddress(req) });
  });

  app.post('/api/policy/reload', async (req, res, next) => {
    if (!canReload(req)) return refuse(req, res);
    try {
      console.log(`[policy] reload requested by ${callerAddress(req)}`);
      const { networks, ...rest } = await loadPolicy();
      return res.json(rest);
    } catch (err) {
      return next(err);
    }
  });
}

module.exports = {
  loadPolicy,
  policyState,
  requireTrustedNetwork,
  mountPolicy,
  trustedProxies,
  callerAddress,
  isReady,
};
