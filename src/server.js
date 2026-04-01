const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mysql = require('mysql2/promise');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { uploadMedia } = require('./bandwidth-media');
const { obtainPendingMedia, detectMimeType, buildStoragePaths, relativeStoragePath, generateThumbnail, MEDIA_ROOT } = require('./mediaObtain');

// Multer: store uploads in temp dir, max 3.5 MB per file, max 10 files
const upload = multer({
  dest: path.join(MEDIA_ROOT, '_tmp'),
  limits: { fileSize: 3.5 * 1024 * 1024, files: 10 }
});

const app = express();
const port = process.env.PORT || 8080;
const explicitOrigins = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
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

function toE164Us10(value) {
  const digits = String(value).replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (normalized.length !== 10) throw new Error('Phone number must be 10 digits');
  return `+1${normalized}`;
}

function toMysqlDateTime3(value) {
  const d = value ? new Date(value) : new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
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

async function listConversations(iBusinessNumber) {
  const [rows] = await dbPool.query(
    `SELECT
        m.iCustomerNumber,
        MAX(m.dtCreated) AS lastAt,
        SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(m.text, '') ORDER BY m.dtCreated DESC SEPARATOR '\n'), '\n', 1) AS lastText,
        CAST(SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(m.eMessageEventTypeID, 0) ORDER BY m.dtCreated DESC SEPARATOR ','), ',', 1) AS UNSIGNED) AS lastEventType,
        SUM(CASE WHEN m.bInbound = 1 AND m.bIsRead = 0 THEN 1 ELSE 0 END) AS unreadCount
      FROM sms_tbl_Message m
      WHERE m.iBusinessNumber = ?
      GROUP BY m.iCustomerNumber
      ORDER BY lastAt DESC`,
    [iBusinessNumber]
  );
  return rows || [];
}

async function getConversationMessages(iBusinessNumber, iCustomerNumber) {
  const [rows] = await dbPool.query(
    `SELECT
        iMessageId,
        sMessageId,
        bInbound,
        iBusinessNumber,
        iCustomerNumber,
        text,
        dtCreated,
        eMessageEventTypeID,
        bIsRead
      FROM sms_tbl_Message
      WHERE iBusinessNumber = ? AND iCustomerNumber = ?
      ORDER BY dtCreated ASC, iMessageId ASC`,
    [iBusinessNumber, iCustomerNumber]
  );
  return rows || [];
}

async function markConversationRead(iBusinessNumber, iCustomerNumber) {
  await dbPool.query(
    `UPDATE sms_tbl_Message
      SET bIsRead = 1
      WHERE iBusinessNumber = ?
        AND iCustomerNumber = ?
        AND bInbound = 1
        AND bIsRead = 0`,
    [iBusinessNumber, iCustomerNumber]
  );
}

async function markLatestConversationUnread(iBusinessNumber, iCustomerNumber) {
  await dbPool.query('CALL sms_usp_MessageReadLatest_SET(?, ?, 0)', [iBusinessNumber, iCustomerNumber]);
}

async function deleteMessage(iMessageId) {
  await dbPool.query('CALL sms_usp_Message_DEL(?)', [iMessageId]);
}

async function deleteCustomer(iBusinessNumber, iCustomerNumber) {
  await dbPool.query('CALL sms_usp_Customer_DEL(?, ?)', [iBusinessNumber, iCustomerNumber]);
}

async function insertMedia({ uidMediaId, iMessageId, providerId, iContentLength }) {
  const [rows] = await dbPool.query(
    'CALL sms_usp_Media_INS(?, ?, ?, ?)',
    [uidMediaId, iMessageId, providerId, iContentLength]
  );
  const resultRow = rows?.[0]?.[0];
  console.log(`[media] Inserted media ${uidMediaId} for message ${iMessageId}`);
  return resultRow;
}

async function getMediaForMessage(iMessageId) {
  const [rows] = await dbPool.query('CALL sms_usp_MediaByMessage_GET(?)', [iMessageId]);
  return rows?.[0] || [];
}

async function sendBandwidthMessage({ from, to, text, media }) {
  const url = `${process.env.BANDWIDTH_MESSAGING_API_BASE_URL || 'https://messaging.bandwidth.com/api/v2'}/users/${process.env.BANDWIDTH_ACCOUNT_ID}/messages`;
  const auth = Buffer.from(`${process.env.BANDWIDTH_API_TOKEN}:${process.env.BANDWIDTH_API_SECRET}`).toString('base64');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      applicationId: process.env.BANDWIDTH_APPLICATION_ID,
      from,
      to: [to],
      text,
      ...(media?.length ? { media } : {})
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error('Provider send failed');
    err.response = { data, status: response.status };
    throw err;
  }
  return data;
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

app.get('/api/conversations', async (req, res, next) => {
  try {
    const business = normalizeUs10(req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const items = await listConversations(business);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/conversations/:customer/messages', async (req, res, next) => {
  try {
    const business = normalizeUs10(req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    const messages = await getConversationMessages(business, customer);

    // Attach media to each message
    const items = await Promise.all(messages.map(async (msg) => {
      const media = await getMediaForMessage(msg.iMessageId);
      return { ...msg, media };
    }));

    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:customer/read', async (req, res, next) => {
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    await markConversationRead(business, customer);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:customer/mark-unread', async (req, res, next) => {
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    await markLatestConversationUnread(business, customer);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/messages/:messageId', async (req, res, next) => {
  try {
    const messageId = Number(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    await deleteMessage(messageId);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/conversations/:customer', async (req, res, next) => {
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    await deleteCustomer(business, customer);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:customer/send', upload.array('files', 10), async (req, res) => {
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    const text = String(req.body?.text ?? '').trim();
    const files = req.files || [];

    if (!customer || (!text && files.length === 0)) {
      return res.status(400).json({ error: 'customer and text or files required' });
    }

    // ── Process outbound media uploads ─────────────────────────────────────
    const bandwidthMediaUrls = [];
    const mediaRecords = []; // to insert after message is created

    for (const file of files) {
      try {
        const uidMediaId = uuidv4();
        const originalName = file.originalname || 'attachment';
        // Append last 4 chars of UUID to prevent filename collisions
        const ext = path.extname(originalName);
        const base = path.basename(originalName, ext);
        const displayName = `${base}-${uidMediaId.slice(-4)}${ext}`;

        // Read the uploaded temp file
        const buffer = fs.readFileSync(file.path);
        const contentType = await detectMimeType(buffer);

        // Build storage path and save to media volume
        const { dir, filePath, thumbPath } = buildStoragePaths(business, customer, '_outbound', uidMediaId, displayName);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, buffer);
        console.log(`[send] Saved outbound file: ${filePath} (${buffer.length} bytes, ${contentType})`);

        // Generate thumbnail
        const thumbGenerated = await generateThumbnail(filePath, thumbPath, contentType);
        const thumbnailPath = thumbGenerated ? relativeStoragePath(thumbPath) : null;

        // Upload to Bandwidth
        const bandwidthMediaName = `echo-${uidMediaId}-${displayName}`;
        const bandwidthUrl = await uploadMedia(bandwidthMediaName, buffer, contentType);
        bandwidthMediaUrls.push(bandwidthUrl);

        // Queue media record for DB insert after message is created
        mediaRecords.push({
          uidMediaId,
          providerId: bandwidthUrl,
          iContentLength: buffer.length,
          displayName,
          contentType,
          storagePath: relativeStoragePath(filePath),
          thumbnailPath
        });

        // Clean up multer temp file
        fs.unlinkSync(file.path);
      } catch (fileErr) {
        console.error(`[send] Failed to process file ${file.originalname}:`, fileErr.message);
        if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      }
    }

    // ── Send via Bandwidth ────────────────────────────────────────────────
    const data = await sendBandwidthMessage({
      from: toE164Us10(business),
      to: toE164Us10(customer),
      text: text || '',
      media: bandwidthMediaUrls.length > 0 ? bandwidthMediaUrls : undefined
    });

    // ── Insert message + media records in DB ──────────────────────────────
    const sMessageId = data?.id;
    let iMessageId = null;
    if (sMessageId) {
      iMessageId = await insertMessage({
        sMessageId,
        bInbound: false,
        iBusinessNumber: business,
        iCustomerNumber: customer,
        text: text || '',
        dtCreated: toMysqlDateTime3(),
        eMessageEventTypeID: 2
      });

      // Insert media records linked to the message
      for (const rec of mediaRecords) {
        try {
          await insertMedia({
            uidMediaId: rec.uidMediaId,
            iMessageId,
            providerId: rec.providerId,
            iContentLength: rec.iContentLength
          });
          // Immediately mark as obtained since we already have the file
          await dbPool.query('CALL sms_usp_Media_SET(?, ?, ?, ?, ?)', [
            rec.uidMediaId, true, rec.storagePath, rec.contentType, rec.thumbnailPath
          ]);
        } catch (mediaErr) {
          console.error(`[send] Failed to insert media record ${rec.uidMediaId}:`, mediaErr.message);
        }
      }
    }

    return res.json({ ok: true, provider: data });
  } catch (error) {
    // Clean up any remaining temp files
    if (req.files) req.files.forEach(f => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
    const details = error?.response?.data ?? error?.message;
    return res.status(200).json({ ok: false, error: 'Provider send failed', details });
  }
});

async function processBandwidthEvents(events) {
  let stored = 0;
  let duplicates = 0;
  let invalid = 0;
  let lostEvents = 0;
  let errors = 0;

  for (const raw of events) {
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
        const iMessageId = await insertMessage({
          sMessageId,
          bInbound: true,
          iBusinessNumber: normalizeUs10(raw.message?.to ?? raw.to),
          iCustomerNumber: normalizeUs10(raw.message?.from),
          text: raw.message?.text ?? null,
          dtCreated: toMysqlDateTime3(raw.message?.time ?? raw.time),
          eMessageEventTypeID: eventTypeId
        });

        // Handle inbound media attachments
        if (iMessageId && raw.message?.media && Array.isArray(raw.message.media)) {
          console.log(`[webhook] Inbound message ${sMessageId} has ${raw.message.media.length} media item(s)`);
          for (const mediaUrl of raw.message.media) {
            try {
              const uidMediaId = uuidv4();
              await insertMedia({
                uidMediaId,
                iMessageId,
                providerId: mediaUrl,
                iContentLength: 0
              });
            } catch (mediaErr) {
              console.error(`[webhook] Failed to insert media for ${sMessageId}:`, mediaErr.message);
            }
          }
          // Fire-and-forget: download & process media asynchronously
          obtainPendingMedia(dbPool, iMessageId).catch(err =>
            console.error(`[webhook] Async media obtain failed for message ${iMessageId}:`, err.message)
          );
        }

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

  return { ok: true, stored, duplicates, invalid, lostEvents, errors };
}

// ── Media obtain trigger endpoints ──────────────────────────────────────────

app.post('/api/media/obtain', async (_req, res, next) => {
  try {
    console.log('[api] Triggering obtain for ALL pending media');
    const result = await obtainPendingMedia(dbPool, null);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

app.post('/api/media/obtain/:messageId', async (req, res, next) => {
  try {
    const messageId = Number(req.params.messageId);
    if (!messageId) return res.status(400).json({ error: 'messageId required' });
    console.log(`[api] Triggering obtain for message ${messageId}`);
    const result = await obtainPendingMedia(dbPool, messageId);
    res.json({ ok: true, ...result });
  } catch (error) {
    next(error);
  }
});

// ── Webhooks ────────────────────────────────────────────────────────────────

app.post('/webhooks/bandwidth/inbound', requireWebhookBasicAuth, async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, error: 'Payload must be an array' });
  }
  return res.json(await processBandwidthEvents(req.body));
});

app.post('/webhooks/bandwidth/status', requireWebhookBasicAuth, async (req, res) => {
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, error: 'Payload must be an array' });
  }
  return res.json(await processBandwidthEvents(req.body));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`EchoService listening on :${port}`);
});
