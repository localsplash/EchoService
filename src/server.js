const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const mysql = require('mysql2/promise');
const multer = require('multer');
const { v4: uuidv4, v5: uuidv5 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { uploadMedia } = require('./bandwidth-media');
const { obtainPendingMedia, detectMimeType, extensionForMime, mimeFromExtension, buildStoragePaths, buildDraftStoragePaths, relativeStoragePath, generateThumbnail, MEDIA_ROOT } = require('./mediaObtain');
const {
  settings,
  refreshSettings,
  ensureFreshSettings,
  SettingsUnavailableError,
  IDENTITY_BASE_NAME
} = require('./settings');
const {
  sendTychronMessage,
  extractMmsParts,
  mapSmsStatus,
  mapMmsStatus,
  parseTychronErrorCode,
  tychronStatusDescription
} = require('./tychron');
const { peerInTrustedNetwork } = require('./trust');
const { applyLocalConfig, isBootstrapped, LOCAL_CONFIG_PATH } = require('./localConfig');
const { mountSetup } = require('./setup');

// Before anything reads NOCODB_*: fold in /data/config.json, without
// overriding what the environment already states. On a single-host install
// this file is identity's, mounted read-only, and the wizard never runs.
applyLocalConfig();

// Multer: store uploads in temp dir, max 3.5 MB per file, max 10 files
const upload = multer({
  dest: path.join(MEDIA_ROOT, '_tmp'),
  limits: { fileSize: 3.5 * 1024 * 1024, files: 10 }
});

const app = express();
const port = process.env.PORT || 8080;

/**
 * Configuration comes from echo_tbl_Settings in the Echo database — rows
 * where sApp is '*' (every Echo app) or 'service' (this one). The one value
 * read from outside that database is trustedCIDR, which is platform-wide
 * network policy and lives in the IdentityBase NocoDB base. See
 * EchoDatabase init/009_settings.sql.
 */
function explicitOrigins() {
  return (settings().CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The Echo database.
 *
 * Its coordinates come from the environment, because this is where the
 * settings themselves live — a database cannot carry its own address.
 * Everything else about this service is a row in echo_tbl_Settings. No
 * invented defaults: a wrong host that looks configured is worse than one
 * that is plainly missing.
 */
function poolCoordinates() {
  const host = (process.env.DB_HOST || '').trim();
  const user = (process.env.DB_USER || '').trim();
  const database = (process.env.DB_NAME || '').trim();
  if (!host || !user || !database) {
    // A configuration fault, not an application one — so in setup mode, where
    // this is the ordinary state, the gate answers 503 rather than 500.
    throw new SettingsUnavailableError(
      'unconfigured',
      'DB_HOST, DB_USER and DB_NAME must be set — they say where the Echo database is'
    );
  }
  const parsed = Number.parseInt((process.env.DB_PORT || '').trim(), 10);
  return {
    host,
    // MySQL's own registered port — the protocol's default, not a guess.
    port: Number.isFinite(parsed) && parsed > 0 ? parsed : 3306,
    user,
    password: process.env.DB_PASSWORD || '',
    database,
    waitForConnections: true,
    connectionLimit: 10,
    timezone: 'Z'
  };
}
/**
 * Built on first use, not at import.
 *
 * Setup mode exists for a host where nothing is configured yet, and building
 * the pool at import made poolCoordinates() throw before main() could ever
 * reach that check — so the fresh host the wizard is for got a stack trace
 * instead of /setup. Nothing queries the database before main() decides, and
 * on the ordinary path refreshSettings() below still forces it at startup, so
 * a missing DB_HOST is reported exactly as promptly as before.
 */
let pool = null;
function echoDb() {
  if (!pool) pool = mysql.createPool(poolCoordinates());
  return pool;
}

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
    if (explicitOrigins().includes(origin)) return true;
    return false;
  } catch {
    return false;
  }
}

function requireWebhookBasicAuth(req, res, next) {
  // A caller from inside the platform's own network is already trusted —
  // that is what trustedCIDR names, one value shared by every application.
  // Bandwidth reaches us from outside it, so basic auth stays the path for
  // the provider's own webhooks.
  if (peerInTrustedNetwork(req, settings().trustedCIDR)) return next();

  const webhookUser = settings().WEBHOOK_BASIC_USER || '';
  const webhookPass = settings().WEBHOOK_BASIC_PASS || '';
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
  const [rows] = await echoDb().query(
    'CALL sms_usp_Message_INS(?, ?, ?, ?, ?, ?, ?)',
    [input.sMessageId, input.bInbound ? 1 : 0, input.iBusinessNumber, input.iCustomerNumber, input.text, input.dtCreated, input.eMessageEventTypeID]
  );
  const resultRow = rows?.[0]?.[0];
  return resultRow?.iMessageId ?? null;
}

async function setMessageEventByExternalMessageId(params) {
  const [rows] = await echoDb().query(
    'CALL sms_usp_MessageEvent_SET(?, ?, ?, ?, ?)',
    [params.sMessageId, params.eMessageEventTypeID, params.dtEvent, params.iErrorCode ?? null, params.description ?? null]
  );
  const resultRow = rows?.[0]?.[0];
  return Boolean(resultRow?.updated);
}

async function listConversations(iBusinessNumber) {
  const [rows] = await echoDb().query(
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
  // The carrier's reason for a failed send lives on the message-failed event
  // row; join it in so the UI can show why a message did not go out. The unique
  // (iMessageId, eMessageEventTypeID) index means this matches at most one row.
  const [rows] = await echoDb().query(
    `SELECT
        m.iMessageId,
        m.sMessageId,
        m.bInbound,
        m.iBusinessNumber,
        m.iCustomerNumber,
        m.text,
        m.dtCreated,
        m.eMessageEventTypeID,
        m.bIsRead,
        f.iErrorCode,
        f.description AS errorDescription
      FROM sms_tbl_Message m
      LEFT JOIN sms_tbl_MessageEvent f
        ON f.iMessageId = m.iMessageId
       AND f.eMessageEventTypeID = 8
      WHERE m.iBusinessNumber = ? AND m.iCustomerNumber = ?
      ORDER BY m.dtCreated ASC, m.iMessageId ASC`,
    [iBusinessNumber, iCustomerNumber]
  );
  return rows || [];
}

async function markConversationRead(iBusinessNumber, iCustomerNumber) {
  await echoDb().query(
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
  await echoDb().query('CALL sms_usp_MessageReadLatest_SET(?, ?, 0)', [iBusinessNumber, iCustomerNumber]);
}

async function deleteMessage(iMessageId) {
  await echoDb().query('CALL sms_usp_Message_DEL(?)', [iMessageId]);
}

async function deleteCustomer(iBusinessNumber, iCustomerNumber) {
  await echoDb().query('CALL sms_usp_Customer_DEL(?, ?)', [iBusinessNumber, iCustomerNumber]);
}

async function insertMedia({ uidMediaId, iMessageId, providerId, iContentLength }) {
  const [rows] = await echoDb().query(
    'CALL sms_usp_Media_INS(?, ?, ?, ?)',
    [uidMediaId, iMessageId, providerId, iContentLength]
  );
  const resultRow = rows?.[0]?.[0];
  console.log(`[media] Inserted media ${uidMediaId} for message ${iMessageId}`);
  return resultRow;
}

async function getMediaForMessage(iMessageId) {
  const [rows] = await echoDb().query('CALL sms_usp_MediaByMessage_GET(?)', [iMessageId]);
  return rows?.[0] || [];
}

async function insertDraftMedia({ uidDraftMediaId, iBusinessNumber, iCustomerNumber, displayName, contentType, iContentLength, storagePath, thumbnailPath }) {
  await echoDb().query(
    'CALL sms_usp_DraftMedia_INS(?, ?, ?, ?, ?, ?, ?, ?)',
    [uidDraftMediaId, iBusinessNumber, iCustomerNumber, displayName, contentType, iContentLength, storagePath, thumbnailPath ?? null]
  );
}

async function getDraftMedia(uidDraftMediaId) {
  const [rows] = await echoDb().query('CALL sms_usp_DraftMedia_GET(?)', [uidDraftMediaId]);
  return rows?.[0]?.[0] ?? null;
}

async function getDraftMediaByCustomer(iBusinessNumber, iCustomerNumber) {
  const [rows] = await echoDb().query('CALL sms_usp_DraftMediaByCustomer_GET(?, ?)', [iBusinessNumber, iCustomerNumber]);
  return rows?.[0] || [];
}

async function deleteDraftMedia(uidDraftMediaId) {
  // Returns the pre-delete row (first result set) so callers can unlink files.
  const [rows] = await echoDb().query('CALL sms_usp_DraftMedia_DEL(?)', [uidDraftMediaId]);
  return rows?.[0]?.[0] ?? null;
}

function unlinkIfExists(absolutePath) {
  try {
    if (absolutePath && fs.existsSync(absolutePath)) fs.unlinkSync(absolutePath);
  } catch (err) {
    console.warn(`[drafts] Failed to unlink ${absolutePath}: ${err.message}`);
  }
}

function rmdirIfEmpty(absoluteDir) {
  try {
    if (absoluteDir && fs.existsSync(absoluteDir) && fs.readdirSync(absoluteDir).length === 0) {
      fs.rmdirSync(absoluteDir);
    }
  } catch (err) {
    console.warn(`[drafts] Failed to rmdir ${absoluteDir}: ${err.message}`);
  }
}

// ── Carrier / business-phone DB functions ────────────────────────────────────

/** sms_lkp_Carrier.eCarrierId for Tychron. */
const CARRIER_TYCHRON = 8;

async function getBusinessPhoneSettings(iBusinessNumber) {
  const [rows] = await echoDb().query('CALL sms_usp_BusinessPhone_GET(?)', [iBusinessNumber]);
  const row = rows?.[0]?.[0];
  if (!row) return null;
  return {
    ...row,
    jsonSettings: typeof row.jsonSettings === 'string' ? JSON.parse(row.jsonSettings) : row.jsonSettings
  };
}

async function getBusinessPhone(iBusinessNumber) {
  const [rows] = await echoDb().query('CALL sms_usp_BusinessPhone_GET(?)', [iBusinessNumber ?? null]);
  return rows?.[0] || [];
}

async function setBusinessPhone(iBusinessNumber, displayName, iCarrierApplicationId) {
  await echoDb().query('CALL sms_usp_BusinessPhone_SET(?, ?, ?)', [iBusinessNumber, displayName ?? null, iCarrierApplicationId]);
}

async function getCarrierApplications(iCarrierApplicationId) {
  const [rows] = await echoDb().query('CALL sms_usp_CarrierApplication_GET(?)', [iCarrierApplicationId ?? null]);
  return rows?.[0] || [];
}

async function setCarrierApplication(iCarrierApplicationId, name, eCarrierId, jsonSettings) {
  const settingsJson = typeof jsonSettings === 'string' ? jsonSettings : JSON.stringify(jsonSettings);
  const [rows] = await echoDb().query(
    'CALL sms_usp_CarrierApplication_SET(?, ?, ?, ?)',
    [iCarrierApplicationId ?? null, name, eCarrierId, settingsJson]
  );
  return rows?.[0]?.[0]?.iCarrierApplicationId ?? null;
}

async function getCarriers() {
  const [rows] = await echoDb().query('SELECT eCarrierId, carrier, description FROM sms_lkp_Carrier ORDER BY eCarrierId');
  return rows || [];
}

// ── Tychron multipart SMS parts ──────────────────────────────────────────────
//
// Tychron's send response returns the multipart id, but each segment's
// delivery report references that segment's own part id. We store one
// sMessageId per message, so without this mapping every report for a message
// longer than a single segment — most of them — would find nothing to update.
//
// Both tolerate the procedures being absent so this service can ship before
// EchoDatabase 010_tychron.sql is applied; the cost is only that multipart
// reports keep being missed until it is.

async function insertTychronMessagePart(iMessageId, sMultipartId, sPartId) {
  try {
    await echoDb().query('CALL sms_usp_TychronMessagePart_INS(?, ?, ?)', [iMessageId, sMultipartId, sPartId]);
  } catch (error) {
    console.warn(`[tychron] Could not record part ${sPartId} (is EchoDatabase 010_tychron.sql applied?): ${error.message}`);
  }
}

async function resolveTychronPartMessageId(sPartId) {
  try {
    const [rows] = await echoDb().query('CALL sms_usp_TychronMessagePart_GET(?)', [sPartId]);
    return rows?.[0]?.[0]?.sMessageId ?? null;
  } catch (error) {
    console.warn(`[tychron] Part lookup failed for ${sPartId} (is EchoDatabase 010_tychron.sql applied?): ${error.message}`);
    return null;
  }
}

// ── Bandwidth message send ───────────────────────────────────────────────────

function mask(val) {
  if (!val) return '(empty)';
  if (val.length <= 6) return '***';
  return val.slice(0, 4) + '***' + val.slice(-2);
}

async function sendBandwidthMessage({ from, to, text, media, settings: bwSettings }) {
  const base =
    settings().BANDWIDTH_MESSAGING_API_BASE_URL || 'https://messaging.bandwidth.com/api/v2';
  const accountId     = bwSettings?.accountId     ?? settings().BANDWIDTH_ACCOUNT_ID;
  const apiToken      = bwSettings?.apiToken      ?? settings().BANDWIDTH_API_TOKEN;
  const apiSecret     = bwSettings?.apiSecret     ?? settings().BANDWIDTH_API_SECRET;
  const applicationId = bwSettings?.applicationId ?? settings().BANDWIDTH_APPLICATION_ID;

  const source = settings ? 'DB' : 'env';
  console.log(`[send] Bandwidth credentials source: ${source}`);
  console.log(`[send]   accountId:     ${mask(accountId)}`);
  console.log(`[send]   apiToken:      ${mask(apiToken)}`);
  console.log(`[send]   apiSecret:     ${mask(apiSecret)}`);
  console.log(`[send]   applicationId: ${mask(applicationId)}`);
  console.log(`[send]   from: ${from}  →  to: ${to}`);

  if (!accountId || !apiToken || !apiSecret || !applicationId) {
    const missing = [
      !accountId && 'accountId', !apiToken && 'apiToken',
      !apiSecret && 'apiSecret', !applicationId && 'applicationId'
    ].filter(Boolean).join(', ');
    console.error(`[send] MISSING CREDENTIALS (${missing}). Ensure this business phone is assigned to a CarrierApplication in Settings.`);
  }

  const url  = `${base}/users/${accountId}/messages`;
  const auth = Buffer.from(`${apiToken || ''}:${apiSecret || ''}`).toString('base64');
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      applicationId,
      from,
      to: [to],
      text,
      ...(media?.length ? { media } : {})
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(`[send] Bandwidth ${response.status}: ${JSON.stringify(data)}`);
    const err = new Error('Provider send failed');
    err.response = { data, status: response.status };
    throw err;
  }
  console.log(`[send] Bandwidth accepted: messageId=${data?.id}`);
  return data;
}

// ── Tychron message send ─────────────────────────────────────────────────────

/**
 * A fixed namespace so an inbound Tychron media id is a pure function of the
 * message and the part index. Tychron treats any non-2xx as a temporary
 * failure and redelivers, so the same MMS arrives more than once as a matter
 * of course; a v4 id would write a second copy of every attachment, where a
 * v5 id collides on the primary key and is skipped.
 */
const TYCHRON_MEDIA_NAMESPACE = '4b8f2c1e-6d3a-5f47-9c2b-1e7a8d4f0b93';

/**
 * Tychron has no media store to upload to and hand back a URL, so there is
 * nothing to put in sms_tbl_Media.providerId. This keeps the column
 * meaningful — and, because sms_usp_Media_INS derives displayName from the
 * tail of the provider id, it also produces the right filename without
 * touching a procedure the Bandwidth path shares.
 */
function tychronProviderId(sMessageId, index, displayName) {
  return `tychron:${sMessageId}/${index}/${displayName}`;
}

/**
 * The Tychron send path.
 *
 * Kept separate from the Bandwidth flow in the route below rather than shared
 * with it: Bandwidth uploads each attachment and sends URLs, Tychron sends
 * the bytes inline, and the only step the two have in common is reading the
 * draft file off disk.
 */
async function sendViaTychron({ res, business, customer, text, draftMediaIds, settings: tychronSettings }) {
  // Read the drafts as buffers. No provider upload step — the bytes go in
  // the send request itself.
  const attachments = [];

  for (const draftId of draftMediaIds) {
    const draft = await getDraftMedia(String(draftId));
    if (!draft) {
      console.warn(`[send:tychron] Draft media ${draftId} not found — skipping`);
      continue;
    }
    if (Number(draft.iBusinessNumber) !== business || Number(draft.iCustomerNumber) !== customer) {
      console.warn(`[send:tychron] Draft media ${draftId} does not belong to ${business}/${customer} — skipping`);
      continue;
    }
    const draftFilePath = path.join(MEDIA_ROOT, draft.storagePath);
    if (!fs.existsSync(draftFilePath)) {
      console.warn(`[send:tychron] Draft file missing on disk: ${draftFilePath} — skipping`);
      continue;
    }
    attachments.push({
      uidMediaId: draft.uidDraftMediaId,
      buffer: fs.readFileSync(draftFilePath),
      contentType: draft.contentType,
      displayName: draft.displayName,
      iContentLength: Number(draft.iContentLength) || 0,
      draftFilePath
    });
  }

  const sent = await sendTychronMessage({
    from: toE164Us10(business),
    to: toE164Us10(customer),
    text: text || '',
    attachments,
    settings: tychronSettings
  });

  const sMessageId = sent?.id;
  if (!sMessageId) return res.json({ ok: true, provider: sent.raw });

  const iMessageId = await insertMessage({
    sMessageId,
    bInbound: false,
    iBusinessNumber: business,
    iCustomerNumber: customer,
    text: text || '',
    dtCreated: toMysqlDateTime3(),
    eMessageEventTypeID: 2
  });

  for (const sPartId of sent.parts || []) {
    await insertTychronMessagePart(iMessageId, sMessageId, sPartId);
  }

  if (iMessageId) {
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      try {
        // Move the draft file into the permanent per-message layout.
        const { dir, filePath, thumbPath } = buildStoragePaths(business, customer, iMessageId, attachment.uidMediaId, attachment.displayName);
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(attachment.draftFilePath, filePath);

        let thumbnailPath = null;
        const thumbGenerated = await generateThumbnail(filePath, thumbPath, attachment.contentType);
        if (thumbGenerated) thumbnailPath = relativeStoragePath(thumbPath);

        await insertMedia({
          uidMediaId: attachment.uidMediaId,
          iMessageId,
          providerId: tychronProviderId(sMessageId, index, attachment.displayName),
          iContentLength: attachment.iContentLength || attachment.buffer.length
        });
        await echoDb().query('CALL sms_usp_Media_SET(?, ?, ?, ?, ?)', [
          attachment.uidMediaId, true, relativeStoragePath(filePath), attachment.contentType, thumbnailPath
        ]);

        await deleteDraftMedia(attachment.uidMediaId);
        rmdirIfEmpty(path.dirname(attachment.draftFilePath));
      } catch (mediaErr) {
        console.error(`[send:tychron] Failed to finalize media record ${attachment.uidMediaId}:`, mediaErr.message);
      }
    }
  }

  return res.json({ ok: true, provider: sent.raw });
}

app.use(helmet());
// 1 MB was enough while every inbound attachment was a Bandwidth URL to
// fetch later. Tychron delivers MMS media inline as base64 in the webhook
// body, so the limit now has to cover the message itself.
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// The first-run wizard, before the settings gate below — it is the thing that
// answers the question that gate is failing on, so it cannot sit behind it.
mountSetup(app);

// Settings-free, so it answers while the store is down: "the process is up"
// stays distinguishable from "the process cannot read its settings".
app.get('/ping', (_req, res) => {
  res.json({ message: 'pong', service: 'EchoService' });
});

/**
 * Keep the settings fresh before anything reads them.
 *
 * The store caches for 30 seconds, so this is a comparison on the hot path
 * and a NocoDB read at most twice a minute — and a change made in NocoDB
 * reaches this service within that window, with no restart. A failure is not
 * swallowed: it travels to the error handler, which answers 503 naming which
 * of unreachable / missing / ambiguous it was.
 */
app.use((_req, _res, next) => {
  ensureFreshSettings(echoDb()).then(() => next(), next);
});

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  }
}));

app.get('/health', async (_req, res) => {
  try {
    await echoDb().query('SELECT 1');
    res.json({ ok: true, service: 'EchoService', db: true, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, service: 'EchoService', db: false, error: error.message });
  }
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

// ── Draft media (pre-upload of attachments before send) ─────────────────────

app.post('/api/drafts/:customer/media', upload.single('file'), async (req, res) => {
  let tempPath = null;
  let dir = null;
  let filePath = null;
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    if (!customer) return res.status(400).json({ error: 'customer required' });
    if (!req.file) return res.status(400).json({ error: 'file required' });

    tempPath = req.file.path;
    const uidDraftMediaId = uuidv4();
    const originalName = req.file.originalname || 'attachment';
    const origExt = path.extname(originalName).toLowerCase();
    const base = path.basename(originalName, path.extname(originalName));

    const buffer = fs.readFileSync(tempPath);
    let contentType = await detectMimeType(buffer);
    // Text-like formats (txt, csv, json, ics, vcf…) have no reliable magic
    // bytes — fall back to the extension the user uploaded.
    if (contentType === 'application/octet-stream') {
      const byExt = mimeFromExtension(origExt);
      if (byExt) contentType = byExt;
    }
    // Canonicalize the stored extension to match the detected MIME so
    // Bandwidth's ext/content-type consistency check doesn't 415 us.
    const canonicalExt = extensionForMime(contentType) || origExt || '.bin';
    const displayName = `${base}-${uidDraftMediaId.slice(-4)}${canonicalExt}`;
    if (canonicalExt !== origExt) {
      console.log(`[drafts] Canonicalized extension ${origExt || '(none)'} -> ${canonicalExt} for detected type ${contentType}`);
    }

    const paths = buildDraftStoragePaths(business, customer, uidDraftMediaId, displayName);
    dir = paths.dir;
    filePath = paths.filePath;

    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buffer);
    console.log(`[drafts] Saved draft file: ${filePath} (${buffer.length} bytes, ${contentType})`);

    // Thumbnails aren't used for drafts — the composer renders the local file.
    const thumbnailPath = null;

    await insertDraftMedia({
      uidDraftMediaId,
      iBusinessNumber: business,
      iCustomerNumber: customer,
      displayName,
      contentType,
      iContentLength: buffer.length,
      storagePath: relativeStoragePath(filePath),
      thumbnailPath
    });

    fs.unlinkSync(tempPath);
    tempPath = null;

    return res.json({
      draftMediaId: uidDraftMediaId,
      displayName,
      contentType,
      contentLength: buffer.length,
      storagePath: relativeStoragePath(filePath),
      thumbnailPath
    });
  } catch (error) {
    console.error('[drafts] Upload failed:', error.message);
    if (tempPath) unlinkIfExists(tempPath);
    if (filePath) unlinkIfExists(filePath);
    if (dir) rmdirIfEmpty(dir);
    return res.status(500).json({ error: 'Draft upload failed', details: error.message });
  }
});

app.get('/api/drafts/:customer/media', async (req, res, next) => {
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    if (!customer) return res.status(400).json({ error: 'customer required' });
    const rows = await getDraftMediaByCustomer(business, customer);
    const items = rows.map(r => ({
      draftMediaId: r.uidDraftMediaId,
      displayName: r.displayName,
      contentType: r.contentType,
      contentLength: r.iContentLength,
      storagePath: r.storagePath,
      thumbnailPath: r.thumbnailPath
    }));
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/drafts/:customer/media/:draftMediaId', async (req, res, next) => {
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    const uidDraftMediaId = String(req.params.draftMediaId || '');

    const row = await getDraftMedia(uidDraftMediaId);
    if (!row) return res.json({ ok: true, deleted: false });
    if (Number(row.iBusinessNumber) !== business || Number(row.iCustomerNumber) !== customer) {
      return res.status(403).json({ error: 'Not yours' });
    }

    await deleteDraftMedia(uidDraftMediaId);

    const filePath = path.join(MEDIA_ROOT, row.storagePath);
    const thumbPath = row.thumbnailPath ? path.join(MEDIA_ROOT, row.thumbnailPath) : null;
    unlinkIfExists(filePath);
    if (thumbPath) unlinkIfExists(thumbPath);
    rmdirIfEmpty(path.dirname(filePath));

    return res.json({ ok: true, deleted: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/conversations/:customer/send', async (req, res) => {
  try {
    const business = normalizeUs10(req.body?.businessNumber ?? req.query.businessNumber);
    if (!business) return res.status(400).json({ error: 'businessNumber required' });
    const customer = normalizeUs10(req.params.customer);
    const text = String(req.body?.text ?? '').trim();
    const draftMediaIds = Array.isArray(req.body?.draftMediaIds) ? req.body.draftMediaIds : [];

    if (!customer || (!text && draftMediaIds.length === 0)) {
      return res.status(400).json({ error: 'customer and text or draftMediaIds required' });
    }

    // ── Resolve carrier settings for this business phone ──────────────────
    const phoneRecord = await getBusinessPhoneSettings(business);
    const carrierSettings = phoneRecord?.jsonSettings ?? null;
    if (carrierSettings) {
      console.log(`[send] Resolved DB carrier settings for ${business}: app="${phoneRecord.carrierApplicationName}" carrier="${phoneRecord.carrier}"`);
    } else {
      console.warn(`[send] No DB carrier settings for ${business} — business phone not yet assigned to a CarrierApplication. Falling back to env vars.`);
    }

    // ── Tychron takes a different path from here ──────────────────────────
    // Everything below this block is the Bandwidth flow, unchanged. A
    // provider that needs its attachments uploaded first and one that needs
    // them inline do not share a useful middle.
    if (Number(phoneRecord?.eCarrierId) === CARRIER_TYCHRON) {
      return await sendViaTychron({
        res, business, customer, text, draftMediaIds, settings: carrierSettings
      });
    }

    // ── Load draft media and upload each to Bandwidth ─────────────────────
    const bandwidthMediaUrls = [];
    const mediaRecords = []; // to insert after message is created

    for (const draftId of draftMediaIds) {
      const draft = await getDraftMedia(String(draftId));
      if (!draft) {
        console.warn(`[send] Draft media ${draftId} not found — skipping`);
        continue;
      }
      if (Number(draft.iBusinessNumber) !== business || Number(draft.iCustomerNumber) !== customer) {
        console.warn(`[send] Draft media ${draftId} does not belong to ${business}/${customer} — skipping`);
        continue;
      }

      const draftFilePath = path.join(MEDIA_ROOT, draft.storagePath);
      if (!fs.existsSync(draftFilePath)) {
        console.warn(`[send] Draft file missing on disk: ${draftFilePath} — skipping`);
        continue;
      }
      const buffer = fs.readFileSync(draftFilePath);

      const bandwidthMediaName = `echo-${draft.uidDraftMediaId}-${draft.displayName}`;
      const bandwidthUrl = await uploadMedia(bandwidthMediaName, buffer, draft.contentType, carrierSettings);
      bandwidthMediaUrls.push(bandwidthUrl);

      mediaRecords.push({
        uidMediaId: draft.uidDraftMediaId, // reuse the UUID; draft rows are deleted after send
        providerId: bandwidthUrl,
        iContentLength: Number(draft.iContentLength) || buffer.length,
        displayName: draft.displayName,
        contentType: draft.contentType,
        draftStoragePath: draft.storagePath,
        draftThumbnailPath: draft.thumbnailPath,
        draftFilePath
      });
    }

    // ── Send via Bandwidth ────────────────────────────────────────────────
    const data = await sendBandwidthMessage({
      from: toE164Us10(business),
      to: toE164Us10(customer),
      text: text || '',
      media: bandwidthMediaUrls.length > 0 ? bandwidthMediaUrls : undefined,
      settings: carrierSettings
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

      for (const rec of mediaRecords) {
        try {
          // Move the draft file into the permanent per-message layout.
          const { dir, filePath, thumbPath } = buildStoragePaths(business, customer, iMessageId, rec.uidMediaId, rec.displayName);
          fs.mkdirSync(dir, { recursive: true });
          fs.renameSync(rec.draftFilePath, filePath);

          // Generate a thumbnail for images (not drafts — only once the
          // attachment is promoted to a sent message, for thread rendering).
          let thumbnailPath = null;
          const thumbGenerated = await generateThumbnail(filePath, thumbPath, rec.contentType);
          if (thumbGenerated) thumbnailPath = relativeStoragePath(thumbPath);

          await insertMedia({
            uidMediaId: rec.uidMediaId,
            iMessageId,
            providerId: rec.providerId,
            iContentLength: rec.iContentLength
          });
          await echoDb().query('CALL sms_usp_Media_SET(?, ?, ?, ?, ?)', [
            rec.uidMediaId, true, relativeStoragePath(filePath), rec.contentType, thumbnailPath
          ]);

          await deleteDraftMedia(rec.uidMediaId);
          rmdirIfEmpty(path.dirname(rec.draftFilePath));
        } catch (mediaErr) {
          console.error(`[send] Failed to finalize media record ${rec.uidMediaId}:`, mediaErr.message);
        }
      }
    }

    return res.json({ ok: true, provider: data });
  } catch (error) {
    const details = error?.response?.data ?? error?.message;
    return res.status(200).json({ ok: false, error: 'Provider send failed', details });
  }
});

// ── Carrier & business-phone management API ──────────────────────────────────

app.get('/api/carriers', async (_req, res, next) => {
  try {
    const items = await getCarriers();
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/carrier-applications', async (_req, res, next) => {
  try {
    const items = await getCarrierApplications(null);
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/carrier-applications/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const items = await getCarrierApplications(id);
    const item = items[0] ?? null;
    if (!item) return res.status(404).json({ error: 'Not found' });
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

app.post('/api/carrier-applications', async (req, res, next) => {
  try {
    const { name, eCarrierId, jsonSettings } = req.body || {};
    if (!name || !eCarrierId || !jsonSettings) {
      return res.status(400).json({ error: 'name, eCarrierId, jsonSettings required' });
    }
    const id = await setCarrierApplication(null, name, Number(eCarrierId), jsonSettings);
    res.json({ ok: true, iCarrierApplicationId: id });
  } catch (error) {
    next(error);
  }
});

app.put('/api/carrier-applications/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const { name, eCarrierId, jsonSettings } = req.body || {};
    if (!name || !eCarrierId || !jsonSettings) {
      return res.status(400).json({ error: 'name, eCarrierId, jsonSettings required' });
    }
    await setCarrierApplication(id, name, Number(eCarrierId), jsonSettings);
    res.json({ ok: true, iCarrierApplicationId: id });
  } catch (error) {
    next(error);
  }
});

app.get('/api/business-phones/:number', async (req, res, next) => {
  try {
    const number = normalizeUs10(req.params.number);
    if (!number) return res.status(400).json({ error: 'number required' });
    const items = await getBusinessPhone(number);
    res.json({ item: items[0] ?? null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/business-phones', async (req, res, next) => {
  try {
    const { iBusinessNumber, displayName, iCarrierApplicationId } = req.body || {};
    const number = normalizeUs10(iBusinessNumber);
    if (!number) return res.status(400).json({ error: 'iBusinessNumber required' });
    if (!iCarrierApplicationId) return res.status(400).json({ error: 'iCarrierApplicationId required' });
    await setBusinessPhone(number, displayName ?? null, Number(iCarrierApplicationId));
    res.json({ ok: true });
  } catch (error) {
    next(error);
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

        const inboundMedia = Array.isArray(raw.message?.media)
          ? raw.message.media
          : Array.isArray(raw.media)
            ? raw.media
            : Array.isArray(raw.message?.mediaUrls)
              ? raw.message.mediaUrls
              : Array.isArray(raw.mediaUrls)
                ? raw.mediaUrls
                : [];

        if (iMessageId) {
          console.log(`[webhook] inbound payload for ${sMessageId}: ${JSON.stringify({
            type: raw.type,
            hasMessageMedia: Array.isArray(raw.message?.media),
            hasRootMedia: Array.isArray(raw.media),
            hasMessageMediaUrls: Array.isArray(raw.message?.mediaUrls),
            hasRootMediaUrls: Array.isArray(raw.mediaUrls),
            inboundMediaCount: inboundMedia.length,
            sampleKeys: Object.keys(raw || {}),
            messageKeys: Object.keys(raw.message || {})
          })}`);
        }

        // Handle inbound media attachments
        if (iMessageId && inboundMedia.length > 0) {
          console.log(`[webhook] Inbound message ${sMessageId} has ${inboundMedia.length} media item(s)`);
          for (const mediaUrl of inboundMedia) {
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
          obtainPendingMedia(echoDb(), iMessageId).catch(err =>
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

// ── Tychron webhook processing ──────────────────────────────────────────────
//
// Separate from processBandwidthEvents rather than folded into it. Tychron
// posts one object where Bandwidth posts an array, splits inbound messages
// and delivery reports across two payload families told apart by a
// discriminator field, and carries inbound media as bytes rather than as a
// URL to fetch later. Only the handful of values that have to reach the
// existing tables are normalized.

function isDuplicateKeyError(error) {
  return Boolean(
    error &&
      (error.code === 'ER_DUP_ENTRY' || String(error.message || '').toLowerCase().includes('duplicate'))
  );
}

/** Inbound SMS and SMS delivery reports, told apart by `type`. */
async function processTychronSmsWebhook(payload) {
  const type = payload?.type;

  if (type === 'sms') {
    if (!payload.id) return { ok: false, error: 'inbound sms has no id' };
    await insertMessage({
      sMessageId: payload.id,
      bInbound: true,
      iBusinessNumber: normalizeUs10(payload.to),
      iCustomerNumber: normalizeUs10(payload.from),
      text: payload.body ?? null,
      dtCreated: toMysqlDateTime3(payload.inserted_at ?? payload.processed_at),
      eMessageEventTypeID: 1
    });
    console.log(`[webhook:tychron:sms] stored inbound ${payload.id}`);
    return { ok: true, stored: 1 };
  }

  if (type === 'sms_dlr') {
    const eMessageEventTypeID = mapSmsStatus(payload.delivery_status);
    if (!eMessageEventTypeID) {
      console.log(`[webhook:tychron:sms] ignoring in-flight status "${payload.delivery_status}"`);
      return { ok: true, ignored: 1 };
    }

    const referencedId = payload.sms?.id;
    if (!referencedId) return { ok: false, error: 'sms_dlr references no sms id' };

    const event = {
      eMessageEventTypeID,
      dtEvent: toMysqlDateTime3(payload.done_at ?? payload.updated_at ?? payload.inserted_at),
      iErrorCode: parseTychronErrorCode(payload.delivery_error_code),
      description: tychronStatusDescription(payload.delivery_status, payload.delivery_error_code)
    };

    // The report references a *segment*. For a single-segment message that is
    // the id we stored; for a longer one it is a part id, and the mapping
    // recorded at send time is what leads back to the message.
    let updated = await setMessageEventByExternalMessageId({ sMessageId: referencedId, ...event });
    if (!updated) {
      const parentMessageId = await resolveTychronPartMessageId(referencedId);
      if (parentMessageId) {
        updated = await setMessageEventByExternalMessageId({ sMessageId: parentMessageId, ...event });
      }
    }

    if (!updated) console.warn(`[webhook:tychron:sms] no message matches ${referencedId}`);
    return { ok: true, updated: updated ? 1 : 0, lostEvents: updated ? 0 : 1 };
  }

  return { ok: false, error: `unknown sms payload type "${type}"` };
}

/** Inbound MMS and MMS delivery reports, told apart by `kind`. */
async function processTychronMmsWebhook(payload) {
  const kind = payload?.kind;

  if (kind === 'mms_forward_req') {
    if (!payload.id) return { ok: false, error: 'inbound mms has no id' };

    const iBusinessNumber = normalizeUs10(Array.isArray(payload.to) ? payload.to[0] : payload.to);
    const iCustomerNumber = normalizeUs10(payload.from);
    const { text, attachments } = extractMmsParts(payload.data);

    const iMessageId = await insertMessage({
      sMessageId: payload.id,
      bInbound: true,
      iBusinessNumber,
      iCustomerNumber,
      text: text || null,
      dtCreated: toMysqlDateTime3(payload.inserted_at ?? payload.timestamp),
      eMessageEventTypeID: 1
    });
    if (!iMessageId) return { ok: false, error: 'message insert returned no id' };

    // The bytes are already here, so there is nothing for obtainPendingMedia
    // to fetch: the row is written already obtained.
    let stored = 0;
    for (let index = 0; index < attachments.length; index++) {
      const attachment = attachments[index];
      const uidMediaId = uuidv5(`${payload.id}/${index}`, TYCHRON_MEDIA_NAMESPACE);
      try {
        const { dir, filePath, thumbPath } = buildStoragePaths(iBusinessNumber, iCustomerNumber, iMessageId, uidMediaId, attachment.displayName);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, attachment.buffer);

        let thumbnailPath = null;
        const thumbGenerated = await generateThumbnail(filePath, thumbPath, attachment.contentType);
        if (thumbGenerated) thumbnailPath = relativeStoragePath(thumbPath);

        await insertMedia({
          uidMediaId,
          iMessageId,
          providerId: tychronProviderId(payload.id, index, attachment.displayName),
          iContentLength: attachment.buffer.length
        });
        await echoDb().query('CALL sms_usp_Media_SET(?, ?, ?, ?, ?)', [
          uidMediaId, true, relativeStoragePath(filePath), attachment.contentType, thumbnailPath
        ]);
        stored += 1;
      } catch (mediaErr) {
        if (isDuplicateKeyError(mediaErr)) {
          console.log(`[webhook:tychron:mms] media ${uidMediaId} already stored — redelivery, skipping`);
          continue;
        }
        throw mediaErr; // real fault: let the route answer 5xx so Tychron retries
      }
    }

    console.log(`[webhook:tychron:mms] stored inbound ${payload.id} with ${stored}/${attachments.length} attachment(s)`);
    return { ok: true, stored: 1, media: stored };
  }

  if (kind === 'mms_delivery_report_req') {
    const eMessageEventTypeID = mapMmsStatus(payload.status_code);
    if (!eMessageEventTypeID) {
      console.log(`[webhook:tychron:mms] ignoring in-flight status "${payload.status_code}"`);
      return { ok: true, ignored: 1 };
    }

    const referencedId = payload.mms?.id;
    if (!referencedId) return { ok: false, error: 'mms report references no mms id' };

    const updated = await setMessageEventByExternalMessageId({
      sMessageId: referencedId,
      eMessageEventTypeID,
      dtEvent: toMysqlDateTime3(payload.timestamp ?? payload.inserted_at),
      iErrorCode: null,
      description: tychronStatusDescription(payload.status_code, null)
    });

    if (!updated) console.warn(`[webhook:tychron:mms] no message matches ${referencedId}`);
    return { ok: true, updated: updated ? 1 : 0, lostEvents: updated ? 0 : 1 };
  }

  return { ok: false, error: `unknown mms payload kind "${kind}"` };
}

// ── Media obtain trigger endpoints ──────────────────────────────────────────

app.post('/api/media/obtain', async (_req, res, next) => {
  try {
    console.log('[api] Triggering obtain for ALL pending media');
    const result = await obtainPendingMedia(echoDb(), null);
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
    const result = await obtainPendingMedia(echoDb(), messageId);
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

// ── Tychron webhooks ────────────────────────────────────────────────────────
//
// Two rules shape these handlers, and both differ from Bandwidth's:
//
//   1. On the SMS endpoint a 200 *with a body* is a reply — Tychron turns the
//      body into an SMS back to the sender. Answering the way the Bandwidth
//      routes do would text every inbound sender our event counters. Only 204
//      acknowledges silently.
//   2. Any non-2xx is a temporary failure and the message is redelivered. So a
//      payload we are never going to accept still has to be acknowledged, or
//      it is retried forever; and a transient fault must *not* be, so that it
//      comes back once the fault clears.

app.post('/webhooks/tychron/sms', requireWebhookBasicAuth, async (req, res) => {
  try {
    const result = await processTychronSmsWebhook(req.body);
    if (!result.ok) {
      console.warn(`[webhook:tychron:sms] ${result.error} — acknowledging, a retry would not help`);
    }
  } catch (error) {
    console.error('[webhook:tychron:sms] processing failed', error);
    return res.sendStatus(503); // transient — ask Tychron to redeliver
  }
  return res.sendStatus(204); // never a body: a body would be sent to the customer
});

app.post('/webhooks/tychron/mms', requireWebhookBasicAuth, async (req, res) => {
  try {
    const result = await processTychronMmsWebhook(req.body);
    if (!result.ok) {
      console.warn(`[webhook:tychron:mms] ${result.error} — acknowledging, a retry would not help`);
    }
  } catch (error) {
    console.error('[webhook:tychron:mms] processing failed', error);
    return res.sendStatus(503); // transient — ask Tychron to redeliver
  }
  return res.sendStatus(204);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  // A settings store that cannot answer is a configuration fault, and saying
  // so beats a 500 that reads as an application fault.
  if (err instanceof SettingsUnavailableError) {
    return res.status(503).json({ error: err.message, reason: err.reason });
  }
  res.status(500).json({ error: 'Internal server error' });
});

const RETRY_DELAY_MS = 5000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Find the settings or die.
 *
 * The Bandwidth credentials, the webhook basic-auth pair and the CORS origins
 * are rows in echo_tbl_Settings; the trusted network is the one value read
 * from IdentityBase. There is no fallback: starting without them would mean
 * answering every request with a fault we could not explain. One retry covers
 * the ordinary case of a dependency still coming up beside us; after that,
 * exit saying why.
 */
async function main() {
  // Nowhere to read trustedCIDR from yet. Exiting here would be the old
  // behaviour and a dead end — nothing an operator does short of editing the
  // environment could recover it, and on a fresh host there is nothing to
  // edit. So come up serving the wizard instead, and let it restart us onto a
  // real configuration. Everything else stays refused by the settings gate.
  if (!isBootstrapped()) {
    console.warn(
      '[settings] No NOCODB_BASE_URL / NOCODB_API_TOKEN, and no bootstrap file at ' +
        `${LOCAL_CONFIG_PATH}. Starting in setup mode: open /setup from the ` +
        'deployment network to say where the settings store is.'
    );
    app.listen(port, '0.0.0.0', () => {
      console.log(`EchoService listening on :${port} (setup mode)`);
    });
    return;
  }

  for (let attempt = 1; ; attempt++) {
    try {
      await refreshSettings(echoDb());
      console.log('[settings] echo_tbl_Settings read');
      break;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (attempt === 1) {
        console.warn(`[settings] ${message} — retrying once in ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      console.error(`[settings] ${message}`);
      console.error(
        '[settings] Cannot start. Check DB_HOST/DB_USER/DB_NAME for the Echo database, ' +
          'that echo_tbl_Settings exists in it, and NOCODB_BASE_URL/NOCODB_API_TOKEN for ' +
          `the ${IDENTITY_BASE_NAME} base that carries trustedCIDR.`
      );
      process.exit(1);
    }
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`EchoService listening on :${port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
