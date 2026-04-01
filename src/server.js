const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mysql = require('mysql2/promise');

const app = express();
const port = process.env.PORT || 8080;
const explicitOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const webhookUser = process.env.WEBHOOK_BASIC_USER || '';
const webhookPass = process.env.WEBHOOK_BASIC_PASS || '';

const dbPool = mysql.createPool({
  host: process.env.DB_HOST || 'echo-database',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'echo_app',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'echo_db',
  waitForConnections: true,
  connectionLimit: 10,
  timezone: 'Z'
});

function isAllowedOrigin(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    const host = u.hostname.toLowerCase();
    const isLocal = host === 'localhost' || host === '127.0.0.1';
    const isWisp = host === 'wisp.net' || host.endsWith('.wisp.net');
    const isDevUi = host.endsWith('.local') || host.endsWith('.test') || host.endsWith('.internal');
    if (isLocal) return true;
    if (isWisp) return true;
    if (isDevUi) return true;
    if (explicitOrigins.includes(origin)) return true;
    return false;
  } catch {
    return false;
  }
}

function requireWebhookBasicAuth(req, res, next) {
  if (!webhookUser && !webhookPass) return next();
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="EchoService Webhook"');
    return res.status(401).json({ ok: false, error: 'Missing basic auth' });
  }
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
  if (user !== webhookUser || pass !== webhookPass) {
    res.set('WWW-Authenticate', 'Basic realm="EchoService Webhook"');
    return res.status(401).json({ ok: false, error: 'Invalid basic auth' });
  }
  return next();
}

function normalizeUs10(value) {
  if (!value) return 0;
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return Number(digits.slice(1));
  if (digits.length === 10) return Number(digits);
  return Number(digits.slice(-10) || 0);
}

function toMysqlDateTime3(value) {
  const d = value ? new Date(value) : new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(),3)}`;
}

function resolveEventTypeId(eventType) {
  return ({
    'message-received': 1,
    'message-sending': 2,
    'message-delivered': 4,
    'message-failed': 8
  })[eventType] || null;
}

async function insertMessage(input) {
  const [rows] = await dbPool.query(
    'CALL sms_usp_Message_INS(?, ?, ?, ?, ?, ?, ?)',
    [input.sMessageId, input.bInbound ? 1 : 0, input.iBusinessNumber, input.iCustomerNumber, input.text, input.dtCreated, input.eMessageEventTypeID]
  );
  const resultRow = rows?.[0]?.[0];
  return resultRow?.iMessageId ?? null;
}

async function setMessageEventByExternalMessageId(params) {
  const [rows] = await dbPool.query(
    'CALL sms_usp_MessageEvent_SET(?, ?, ?, ?, ?)',
    [params.sMessageId, params.eMessageEventTypeID, params.dtEvent, params.iErrorCode ?? null, params.description ?? null]
  );
  const resultRow = rows?.[0]?.[0];
  return Boolean(resultRow?.updated);
}

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));
app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  }
}));

app.get('/health', async (_req, res) => {
  try {
    await dbPool.query('SELECT 1');
    res.json({ ok: true, service: 'EchoService', db: true, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, service: 'EchoService', db: false, error: error.message });
  }
});

app.get('/ping', (_req, res) => {
  res.json({ message: 'pong', service: 'EchoService' });
});

app.post('/echo', (req, res) => {
  res.json({ ok: true, received: req.body || null });
});

app.post('/webhooks/bandwidth/inbound', requireWebhookBasicAuth, async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, error: 'Payload must be an array' });
  }

  let stored = 0;
  let duplicates = 0;
  let invalid = 0;
  let lostEvents = 0;
  let errors = 0;

  for (const raw of req.body) {
    try {
      const sMessageId = raw?.message?.id;
      const eventType = raw?.type;
      if (!sMessageId || !eventType) {
        invalid += 1;
        errors += 1;
        continue;
      }

      const eventTypeId = resolveEventTypeId(eventType);
      if (!eventTypeId) {
        invalid += 1;
        errors += 1;
        continue;
      }

      if (eventType === 'message-received') {
        await insertMessage({
          sMessageId,
          bInbound: true,
          iBusinessNumber: normalizeUs10(raw.message?.to ?? raw.to),
          iCustomerNumber: normalizeUs10(raw.message?.from),
          text: raw.message?.text ?? null,
          dtCreated: toMysqlDateTime3(raw.message?.time ?? raw.time),
          eMessageEventTypeID: eventTypeId
        });
        stored += 1;
        continue;
      }

      const updated = await setMessageEventByExternalMessageId({
        sMessageId,
        eMessageEventTypeID: eventTypeId,
        dtEvent: toMysqlDateTime3(raw.time ?? raw.message?.time),
        iErrorCode: raw.errorCode ?? null,
        description: raw.description ?? null
      });

      if (!updated) lostEvents += 1;
    } catch (error) {
      console.error('webhook processing failed', error, raw);
      if (String(error?.message || '').toLowerCase().includes('duplicate')) duplicates += 1;
      else errors += 1;
    }
  }

  return res.json({ ok: true, stored, duplicates, invalid, lostEvents, errors });
});

app.post('/webhooks/bandwidth/status', requireWebhookBasicAuth, async (req, res) => {
  return app._router.handle({ ...req, url: '/webhooks/bandwidth/inbound', method: 'POST' }, res, () => {});
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`EchoService listening on :${port}`);
});
