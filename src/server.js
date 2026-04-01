const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 8080;
const explicitOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const webhookUser = process.env.WEBHOOK_BASIC_USER || '';
const webhookPass = process.env.WEBHOOK_BASIC_PASS || '';

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

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));
app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'EchoService', timestamp: new Date().toISOString() });
});

app.get('/ping', (_req, res) => {
  res.json({ message: 'pong', service: 'EchoService' });
});

app.post('/echo', (req, res) => {
  res.json({ ok: true, received: req.body || null });
});

app.post('/webhooks/bandwidth/inbound', requireWebhookBasicAuth, (req, res) => {
  res.json({ ok: true, webhook: 'bandwidth-inbound', received: req.body || null });
});

app.post('/webhooks/bandwidth/status', requireWebhookBasicAuth, (req, res) => {
  res.json({ ok: true, webhook: 'bandwidth-status', received: req.body || null });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`EchoService listening on :${port}`);
});
