'use strict';

/**
 * The page that shows this service its own log.
 *
 * Server-rendered from one string, like `setup.js`, and for the same reason:
 * this repo has no build step and an operator page that needs one is a page
 * that stops working exactly when the build is what broke. No dependencies, no
 * assets, no framework — it has to open when things are bad.
 *
 * Two halves, and the top one is the point:
 *
 *   - **A status strip** answering the questions asked when something is
 *     wrong. Is the database reachable, what network policy is in force,
 *     and — the one that prompted all of this — *when did each carrier last
 *     call our webhook, and what did it get?* "Tychron: never" is a complete
 *     diagnosis, and it is not something the message log can say, because the
 *     evidence for it is an absence.
 *
 *   - **The log itself**, all lines or errors only, searchable, with a live
 *     tail over SSE so a webhook can be watched as it arrives rather than
 *     hunted for afterwards.
 *
 * Everything here is mounted behind the `trustedCIDR` gate in `server.js`.
 * It reports credentials-adjacent detail and belongs on the private side.
 */

const logbook = require('./logbook');
const webhookWatch = require('./webhookWatch');
const { sendOperatorPage } = require('./operatorPage');

const STARTED_AT = Date.now();

function humanDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(seconds / 86400), 'd'],
    [Math.floor((seconds % 86400) / 3600), 'h'],
    [Math.floor((seconds % 3600) / 60), 'm'],
    [seconds % 60, 's'],
  ].filter(([value], index) => value > 0 || index === 3);
  return parts
    .slice(0, 2)
    .map(([value, unit]) => `${value}${unit}`)
    .join(' ');
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EchoService logs</title>
<style>
 :root{color-scheme:light dark;--fg:#e6e6e6;--bg:#14161a;--dim:#8b949e;--line:#262b33}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
 header{padding:.9rem 1.1rem;border-bottom:1px solid var(--line)}
 h1{font-size:1rem;margin:0 0 .7rem;font-weight:600}
 h1 span{color:var(--dim);font-weight:400}
 .cards{display:flex;flex-wrap:wrap;gap:.5rem}
 .card{background:#1b1f26;border:1px solid var(--line);border-radius:7px;padding:.5rem .7rem;min-width:8.5rem}
 .card .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
 .card .v{font:13px ui-monospace,monospace;margin-top:.15rem;word-break:break-all}
 .good{color:#4ade80}.bad{color:#f87171}.warn{color:#fbbf24}
 table{border-collapse:collapse;margin-top:.7rem;font:12px ui-monospace,monospace;width:100%;max-width:56rem}
 th{text-align:left;color:var(--dim);font-weight:500;padding:.25rem .8rem .25rem 0;border-bottom:1px solid var(--line)}
 td{padding:.25rem .8rem .25rem 0;border-bottom:1px solid var(--line)}
 nav{display:flex;flex-wrap:wrap;gap:.45rem;align-items:center;padding:.6rem 1.1rem;border-bottom:1px solid var(--line)}
 button,select,input{font:inherit;background:#1b1f26;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:.32rem .6rem}
 button{cursor:pointer}
 button.on{background:#2563eb;border-color:#2563eb;color:#fff}
 input[type=search]{flex:1;min-width:9rem;max-width:22rem}
 a{color:#60a5fa}
 #log{margin:0;padding:.7rem 1.1rem;font:12px/1.55 ui-monospace,monospace;white-space:pre-wrap;word-break:break-word;overflow-anchor:none}
 .row{padding:.05rem 0;border-left:2px solid transparent;padding-left:.5rem}
 .row.error{border-left-color:#f87171;background:#f8717115}
 .row.warn{border-left-color:#fbbf24;background:#fbbf2412}
 .row.access{color:var(--dim)}
 .ts{color:var(--dim)}
 .lv{color:#a78bfa}
 .empty{color:var(--dim);padding:1.5rem 1.1rem}
 @media (prefers-color-scheme:light){
  :root{--fg:#1f2328;--bg:#fff;--dim:#656d76;--line:#d8dee4}
  .card{background:#f6f8fa}button,select,input{background:#f6f8fa}
 }
</style></head><body>
<header>
  <h1>EchoService <span id="sub">loading&hellip;</span></h1>
  <div class="cards" id="cards"></div>
  <table id="hooks"><thead><tr><th>Carrier webhook</th><th>Calls</th><th>Accepted</th><th>Rejected</th><th>Last call</th><th>Status</th><th>From</th></tr></thead><tbody></tbody></table>
</header>
<nav>
  <button id="t-app" class="on">All</button>
  <button id="t-error">Errors</button>
  <label><input type="checkbox" id="noaccess"> hide access</label>
  <input type="search" id="q" placeholder="filter&hellip;">
  <button id="tail" class="on">Live</button>
  <button id="clear">Clear</button>
  <a id="dl" href="/api/logs/raw?stream=app" download>Download</a>
</nav>
<div id="log"></div>
<script>
const el = (id) => document.getElementById(id);
let stream = 'app', tailing = true, source = null, lastSeq = 0;
const logEl = el('log');

function esc(s){ const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function atBottom(){ return window.innerHeight + window.scrollY >= document.body.offsetHeight - 60; }

function append(entries){
  if (!entries.length) return;
  const stick = atBottom();
  const frag = document.createDocumentFragment();
  for (const e of entries){
    lastSeq = Math.max(lastSeq, e.seq);
    if (el('noaccess').checked && e.level === 'access') continue;
    const div = document.createElement('div');
    div.className = 'row ' + e.level;
    div.innerHTML = '<span class="ts">' + esc(e.ts.replace('T',' ').replace('Z','')) +
      '</span> <span class="lv">' + esc(e.level) + '</span> ' + esc(e.text);
    frag.appendChild(div);
  }
  logEl.appendChild(frag);
  while (logEl.childElementCount > 4000) logEl.removeChild(logEl.firstChild);
  if (stick && tailing) window.scrollTo(0, document.body.scrollHeight);
}

function params(){
  const p = new URLSearchParams({ stream });
  const q = el('q').value.trim();
  if (q) p.set('q', q);
  return p;
}

async function reload(){
  logEl.innerHTML = ''; lastSeq = 0;
  const p = params(); p.set('limit', '1000');
  const res = await fetch('/api/logs?' + p);
  const d = await res.json();
  if (!d.entries.length) logEl.innerHTML = '<div class="empty">Nothing in this stream yet.</div>';
  append(d.entries);
  connect();
}

function connect(){
  if (source) { source.close(); source = null; }
  if (!tailing) return;
  const p = params(); p.set('since', String(lastSeq));
  source = new EventSource('/api/logs/stream?' + p);
  source.onmessage = (ev) => append([JSON.parse(ev.data)]);
  // The browser reconnects on its own; 'since' is refreshed by the next open.
}

function tab(next){
  stream = next;
  el('t-app').classList.toggle('on', next === 'app');
  el('t-error').classList.toggle('on', next === 'error');
  el('dl').href = '/api/logs/raw?stream=' + next;
  reload();
}

el('t-app').onclick = () => tab('app');
el('t-error').onclick = () => tab('error');
el('clear').onclick = () => { logEl.innerHTML = ''; };
el('noaccess').onchange = reload;
el('tail').onclick = () => {
  tailing = !tailing;
  el('tail').classList.toggle('on', tailing);
  connect();
};
let debounce;
el('q').oninput = () => { clearTimeout(debounce); debounce = setTimeout(reload, 250); };

function card(k, v, cls){ return '<div class="card"><div class="k">' + k + '</div><div class="v ' + (cls||'') + '">' + esc(v) + '</div></div>'; }

async function status(){
  try {
    const s = await (await fetch('/api/status')).json();
    el('sub').textContent = 'up ' + s.uptime + ' \\u2014 node ' + s.node;
    el('cards').innerHTML =
      card('Database', s.db.ok ? 'reachable' : s.db.error, s.db.ok ? 'good' : 'bad') +
      card('Network policy', s.policy.status === 'ready' ? s.policy.trustedCIDR : s.policy.status,
           s.policy.status === 'ready' ? 'good' : 'bad') +
      card('You are', s.caller) +
      card('Log files', s.logs.fault ? s.logs.fault : s.logs.dir, s.logs.fault ? 'warn' : '') +
      card('Buffered', s.logs.ring.size + ' / ' + s.logs.ring.capacity + ' lines');
    el('hooks').querySelector('tbody').innerHTML = s.webhooks.providers.map((p) =>
      '<tr><td>' + esc(p.provider) + '</td><td>' + p.calls + '</td>' +
      '<td class="' + (p.accepted ? 'good' : '') + '">' + p.accepted + '</td>' +
      '<td class="' + (p.rejected ? 'bad' : '') + '">' + p.rejected + '</td>' +
      '<td class="' + (p.lastAt ? '' : 'bad') + '">' + esc(p.lastAt ? p.lastAt.replace('T',' ').replace('Z','') : 'never since start') + '</td>' +
      '<td>' + esc(p.lastStatus === null ? '\\u2014' : String(p.lastStatus)) + '</td>' +
      '<td>' + esc(p.lastFrom || '\\u2014') + '</td></tr>'
    ).join('');
  } catch (err) { el('sub').textContent = String(err); }
}

status(); setInterval(status, 10000); reload();
</script></body></html>`;

/**
 * Mount the viewer. Expects to sit behind the network gate — it applies no
 * access control of its own, so that there is one place where that decision
 * is made rather than two that can disagree.
 */
function mountLogs(app, { dbPool, policyState, callerAddress }) {
  app.get('/logs', (_req, res) => sendOperatorPage(res, PAGE));

  app.get('/api/logs', (req, res) => {
    const entries = logbook.read({
      stream: req.query.stream,
      q: req.query.q,
      level: req.query.level,
      since: req.query.since,
      limit: req.query.limit,
    });
    res.json({ entries, status: logbook.status() });
  });

  app.get('/api/logs/raw', (req, res) => {
    const stream = req.query.stream === 'error' ? 'error' : 'app';
    res
      .set('Content-Type', 'text/plain; charset=utf-8')
      .set('Content-Disposition', `attachment; filename="echoservice-${stream}.log"`)
      .send(logbook.readRaw(stream));
  });

  /**
   * The live tail.
   *
   * `X-Accel-Buffering: no` is not optional here — nginx buffers proxied
   * responses by default and the stream would arrive in silent chunks, which
   * looks exactly like a service that has stopped logging.
   */
  app.get('/api/logs/stream', (req, res) => {
    const stream = req.query.stream === 'error' ? 'error' : 'app';
    const q = String(req.query.q || '').toLowerCase();
    const wantsError = stream === 'error';

    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    // Anything written since the page's last fetch, so nothing falls into the
    // gap between the initial load and the subscription.
    for (const entry of logbook.read({ stream, q, since: req.query.since, limit: 200 })) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsubscribe = logbook.subscribe((entry) => {
      if (wantsError && entry.level !== 'error' && entry.level !== 'warn') return;
      if (q && !entry.text.toLowerCase().includes(q)) return;
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    // Idle connections are otherwise dropped by the proxy, and a dead tail is
    // indistinguishable from a quiet service.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/api/status', async (req, res) => {
    const db = await dbPool
      .query('SELECT 1')
      .then(() => ({ ok: true }))
      .catch((err) => ({ ok: false, error: err.message }));
    const { networks, ...policy } = policyState();
    res.json({
      service: 'EchoService',
      node: process.versions.node,
      pid: process.pid,
      startedAt: new Date(STARTED_AT).toISOString(),
      uptime: humanDuration(Date.now() - STARTED_AT),
      caller: callerAddress(req),
      db,
      policy,
      logs: logbook.status(),
      webhooks: webhookWatch.snapshot(),
    });
  });
}

module.exports = { mountLogs };
