'use strict';

/**
 * What this service said about itself, kept where someone can read it.
 *
 * Until now every line went to `console.log` and no further than the Docker
 * `json-file` driver — capped, interleaved, and reachable only by someone with
 * a shell on the host. A stack trace competed with four health-check lines a
 * second and lost. Diagnosing "inbound Tychron messages are not arriving"
 * meant grepping `docker logs` and nginx's access log by hand, which is a poor
 * substitute for the service being able to show its own history.
 *
 * Three destinations, on purpose:
 *
 *   - **stdout, unchanged.** The console methods still write exactly what they
 *     wrote before, so `docker logs`, the host's promtail, and anything else
 *     already watching the container keep working. This layer adds; it does
 *     not divert.
 *   - **Rotating files** under `/data/logs`, on the volume the service already
 *     mounts. Split into everything and errors-only, because "show me what
 *     broke" should not mean reading past thousands of 200s.
 *   - **An in-memory ring**, so the page opens instantly and a live tail has
 *     something to attach to without re-reading a file from disk.
 *
 * Disk is best-effort. A read-only or full `/data` costs the files and nothing
 * else — the ring and stdout carry on, and the page says so. A logging layer
 * that can take the service down with it is worse than no logging layer.
 */

const fs = require('fs');
const path = require('path');

/**
 * Not `/data`. That path is identity's config volume, and on a single-host
 * install it is mounted here read-only — the arrangement the Dockerfile
 * describes and the first thing this tried to write to. `/var/log/echo` is
 * created and owned in the image, so the files work with no compose change at
 * all; the orchestrator mounts a named volume over it so they outlive the
 * container rather than living in its writable layer.
 */
const LOG_DIR = (process.env.LOG_DIR || '/var/log/echo').trim();

function positiveInt(raw, fallback) {
  const parsed = Number.parseInt(String(raw || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Lines held in memory for the page and the live tail. */
const RING_SIZE = positiveInt(process.env.LOG_RING_SIZE, 2000);
/** Rotate a file once it passes this, keeping LOG_KEEP older generations. */
const MAX_BYTES = positiveInt(process.env.LOG_MAX_BYTES, 5 * 1024 * 1024);
const KEEP = positiveInt(process.env.LOG_KEEP, 5);

/**
 * `error` and `warn` go to both files; everything else only to the full one.
 * `access` is the morgan stream, kept as its own level so the page can mute
 * the health-check noise without losing it.
 */
const LEVELS = ['error', 'warn', 'info', 'log', 'debug', 'access'];
const ERROR_LEVELS = new Set(['error', 'warn']);

const STREAMS = {
  app: { file: 'echo.log', accepts: () => true },
  error: { file: 'error.log', accepts: (level) => ERROR_LEVELS.has(level) },
};

// ─── Redaction ───────────────────────────────────────────────────────────────

/**
 * The page is readable by anyone inside the trusted network, which is a wider
 * audience than "whoever already has root on the host" — the one that could
 * read these lines before. So the shapes that are always a credential are
 * blanked on the way in, not on the way out: a secret that reaches the ring
 * has also reached the file, and redacting at render would leave it there.
 *
 * This is a net, not a guarantee. It catches the tokens this platform actually
 * uses rather than trying to recognise a secret in general.
 */
const REDACTIONS = [
  // An Authorization value runs to the end of the line, and it has to be
  // consumed whole: matching only the next token leaves `Basic <credential>`
  // with the credential still in place, which is the bug this ordering fixes.
  [/\b(authorization)(\s*[:=]\s*).*/gi, '$1$2[redacted]'],
  [/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}={0,2}/g, '$1 [redacted]'],
  [/\b(nc_pat_|github_pat_|gho_|ghp_|sk-)[A-Za-z0-9_-]{8,}/g, '$1[redacted]'],
  [/\b(xc-token|x-api-token|x-api-secret)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]'],
  [/("(?:password|secret|token|apiSecret|apiToken)"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2'],
];

function redact(text) {
  let out = text;
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

// ─── The ring ────────────────────────────────────────────────────────────────

const ring = [];
let seq = 0;
const subscribers = new Set();

/** Why the files are not being written, or null while they are. */
let fileFault = null;
const handles = new Map(); // stream name -> { fd, bytes }

function ringPush(record) {
  ring.push(record);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  for (const notify of subscribers) {
    // One bad subscriber must not stop the others, or stop the log.
    try {
      notify(record);
    } catch {
      /* a closed SSE response; the finish handler will drop it */
    }
  }
}

// ─── The files ───────────────────────────────────────────────────────────────

function openStream(name) {
  const target = path.join(LOG_DIR, STREAMS[name].file);
  const fd = fs.openSync(target, 'a');
  const { size } = fs.fstatSync(fd);
  return { fd, bytes: size };
}

function ensureOpen() {
  if (fileFault) return false;
  if (handles.size === Object.keys(STREAMS).length) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    for (const name of Object.keys(STREAMS)) {
      if (!handles.has(name)) handles.set(name, openStream(name));
    }
    return true;
  } catch (err) {
    // Reported once, on the page and on stdout, then never retried in the hot
    // path — a service that cannot write its log should not also spend itself
    // failing to open the file on every line.
    fileFault = `${LOG_DIR}: ${err && err.message ? err.message : String(err)}`;
    for (const handle of handles.values()) {
      try {
        fs.closeSync(handle.fd);
      } catch {
        /* already gone */
      }
    }
    handles.clear();
    return false;
  }
}

/** `echo.log` -> `echo.log.1`, the old `.1` -> `.2`, and the last one falls off. */
function rotate(name) {
  const base = path.join(LOG_DIR, STREAMS[name].file);
  const handle = handles.get(name);
  if (handle) {
    try {
      fs.closeSync(handle.fd);
    } catch {
      /* already gone */
    }
    handles.delete(name);
  }
  for (let i = KEEP - 1; i >= 1; i -= 1) {
    const from = `${base}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${base}.${i + 1}`);
  }
  if (fs.existsSync(base)) fs.renameSync(base, `${base}.1`);
  handles.set(name, openStream(name));
}

function writeFile(name, line) {
  if (!ensureOpen()) return;
  try {
    let handle = handles.get(name);
    if (handle.bytes >= MAX_BYTES) {
      rotate(name);
      handle = handles.get(name);
    }
    const buffer = Buffer.from(line, 'utf8');
    fs.writeSync(handle.fd, buffer);
    handle.bytes += buffer.length;
  } catch (err) {
    fileFault = `${LOG_DIR}: ${err && err.message ? err.message : String(err)}`;
    handles.clear();
  }
}

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * `console.error('failed:', err)` has to read the same on the page as it does
 * on stdout, so arguments are joined the way the console joins them. An Error
 * contributes its stack — the part that was being thrown away when these went
 * to a capped ring in the Docker driver.
 */
function formatArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
      try {
        return require('util').inspect(arg, { depth: 4, breakLength: Infinity });
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/** Add a line to the ring and the files. Never throws. */
function record(level, text) {
  try {
    const entry = {
      seq: (seq += 1),
      ts: new Date().toISOString(),
      level: LEVELS.includes(level) ? level : 'log',
      text: redact(String(text).replace(/\s+$/, '')),
    };
    ringPush(entry);
    const line = `${entry.ts} [${entry.level}] ${entry.text}\n`;
    for (const [name, stream] of Object.entries(STREAMS)) {
      if (stream.accepts(entry.level)) writeFile(name, line);
    }
    return entry;
  } catch {
    return null; // logging must never be the thing that breaks
  }
}

// ─── Installation ────────────────────────────────────────────────────────────

const CONSOLE_LEVELS = { log: 'log', info: 'info', warn: 'warn', error: 'error', debug: 'debug' };
let installed = false;

/**
 * Patch the console so existing call sites are captured as they are.
 *
 * The alternative was a logger object and ~40 rewritten call sites, which
 * would have been a much larger diff for the same result and would have left
 * anything added later silently uncaptured. The originals are still called, so
 * stdout is byte-for-byte what it was.
 */
function install() {
  if (installed) return;
  installed = true;

  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      record(level, formatArgs(args));
    };
  }

  // These two are the lines most worth having and the ones least likely to
  // survive: the process is on its way down and stdout may not be drained.
  process.on('uncaughtException', (err) => {
    record('error', `[process] uncaught exception: ${err && err.stack ? err.stack : String(err)}`);
    throw err;
  });
  process.on('unhandledRejection', (reason) => {
    record(
      'error',
      `[process] unhandled rejection: ${reason && reason.stack ? reason.stack : String(reason)}`
    );
  });

  ensureOpen();
  // console, not record: where the log is going belongs on stdout too, and a
  // line about logging that only appears in the log is no use when the log is
  // the thing that is not working.
  console.log(`[logbook] capturing to ${LOG_DIR} (ring ${RING_SIZE} lines)`);
  if (fileFault) {
    console.warn(`[logbook] files unavailable, keeping the in-memory ring only — ${fileFault}`);
  }
}

/**
 * The morgan sink, so access lines land here as a level of their own.
 *
 * It writes to stdout as well, because morgan's default sink *is* stdout and
 * replacing it silently took the access log out of `docker logs` and away from
 * the host's promtail. This layer is only ever additive; anything already
 * watching the container keeps seeing what it saw.
 */
const morganStream = {
  write(line) {
    process.stdout.write(line);
    record('access', line);
  },
};

// ─── Reading ─────────────────────────────────────────────────────────────────

/**
 * The ring, newest last, filtered the way the page asks for it.
 *
 * `since` makes the live tail resumable: a reconnecting page asks for what it
 * missed rather than redrawing from scratch.
 */
function read({ stream = 'app', q = '', level = '', since = 0, limit = 500 } = {}) {
  const accepts = (STREAMS[stream] || STREAMS.app).accepts;
  const needle = String(q || '').toLowerCase();
  const wanted = String(level || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const matched = ring.filter(
    (entry) =>
      entry.seq > Number(since || 0) &&
      accepts(entry.level) &&
      (!wanted.length || wanted.includes(entry.level)) &&
      (!needle || entry.text.toLowerCase().includes(needle))
  );
  const capped = positiveInt(limit, 500);
  return matched.slice(-capped);
}

/** The file as text, for a download or a `curl`. Falls back to the ring. */
function readRaw(stream = 'app') {
  const name = STREAMS[stream] ? stream : 'app';
  const target = path.join(LOG_DIR, STREAMS[name].file);
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return read({ stream: name, limit: RING_SIZE })
      .map((entry) => `${entry.ts} [${entry.level}] ${entry.text}`)
      .join('\n');
  }
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function status() {
  const files = {};
  for (const [name, stream] of Object.entries(STREAMS)) {
    const target = path.join(LOG_DIR, stream.file);
    try {
      files[name] = { path: target, bytes: fs.statSync(target).size };
    } catch {
      files[name] = { path: target, bytes: null };
    }
  }
  return {
    dir: LOG_DIR,
    fault: fileFault,
    ring: { size: ring.length, capacity: RING_SIZE, latest: seq },
    rotation: { maxBytes: MAX_BYTES, keep: KEEP },
    files,
  };
}

module.exports = {
  install,
  record,
  read,
  readRaw,
  subscribe,
  status,
  morganStream,
  redact,
  LEVELS,
  LOG_DIR,
};
