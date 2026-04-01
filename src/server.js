const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const port = process.env.PORT || 8080;
const allowedOrigins = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);

app.use(helmet());
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  }
}));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'EchoService', timestamp: new Date().toISOString() });
});

app.get('/api/ping', (_req, res) => {
  res.json({ message: 'pong', service: 'EchoService' });
});

app.post('/api/echo', (req, res) => {
  res.json({ ok: true, received: req.body || null });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`EchoService listening on :${port}`);
});
