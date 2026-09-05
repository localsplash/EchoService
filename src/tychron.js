'use strict';

/**
 * Tychron Atlas SMS/MMS.
 *
 * A second carrier, deliberately kept as its own path rather than folded into
 * a shared carrier abstraction with Bandwidth. The two providers agree on
 * almost nothing past "send text to a number":
 *
 *   - Two APIs on two hosts, chosen by whether there are attachments, where
 *     Bandwidth has one endpoint for both.
 *   - Attachments travel inline as base64. There is no upload-then-reference
 *     step, so nothing here corresponds to bandwidth-media's uploadMedia, and
 *     inbound media arrives as bytes rather than a URL to fetch later.
 *   - Bearer auth from one token, not a four-part account/token/secret/app.
 *   - No callback URL in any request: inbound messages and delivery reports
 *     both arrive at the endpoint configured on the number's Switch in the
 *     Atlas portal, and a receiver tells them apart by `type` (SMS) or
 *     `kind` (MMS).
 *
 * This file is HTTP and parsing only — no database. That mirrors how the
 * Bandwidth path is already split: bandwidth-media.js talks to the provider,
 * server.js owns the routes and the DB writes.
 *
 * Reference: https://docs.tychron.com/openapi/sms.openapi.yaml
 *            https://docs.tychron.com/openapi/mms.openapi.yaml
 */

const path = require('path');
const { extensionForMime } = require('./mediaObtain');

/** Tychron's documented body cap for a single SMS. */
const MAX_SMS_BODY_CHARS = 2048;

/**
 * Tychron's hard per-file MMS limit is 2 MB *including HTTP overhead*, and
 * their own guidance is to stay under 1 MB because some carriers reject over
 * 500 KB. base64 costs about a third on top, so the number that matters is
 * the size of the encoded part, not the file on disk — a 3.5 MB upload (what
 * multer currently allows) encodes to roughly 4.7 MB and is refused.
 */
const MAX_MMS_PART_ENCODED_BYTES = 2 * 1024 * 1024;
const WARN_MMS_PART_ENCODED_BYTES = 1024 * 1024;

/** Layout parts carry no content of their own. */
const SKIP_CONTENT_TYPES = ['application/smil', 'application/smil+xml'];

// ─── Send ────────────────────────────────────────────────────────────────────

function authHeaders(settings) {
  return {
    Authorization: `Bearer ${settings.apiToken}`,
    'Content-Type': 'application/json'
  };
}

/**
 * Fail before the request rather than after: a missing key here reads as a
 * 401 from Tychron, which looks like a bad token rather than an unconfigured
 * carrier application.
 */
function requireSetting(settings, key) {
  const value = settings && settings[key];
  if (!value) {
    throw new Error(
      `Tychron ${key} is not set on this carrier application — add it in Settings → Carrier Applications`
    );
  }
  return value;
}

/**
 * Which API to use is decided by whether there is anything to attach. Tychron
 * has no single endpoint that takes both.
 */
async function sendTychronMessage({ from, to, text, attachments, settings }) {
  if (attachments && attachments.length > 0) {
    return sendTychronMms({ from, to, text, attachments, settings });
  }
  return sendTychronSms({ from, to, text, settings });
}

/**
 * POST {smsUrl}
 *
 * The response is a map keyed by recipient number in plain digits, so the
 * message ID is found by key rather than at a fixed path.
 *
 * @returns {Promise<{ id: string, parts: string[], raw: object }>}
 */
async function sendTychronSms({ from, to, text, settings }) {
  const url = requireSetting(settings, 'smsUrl');
  requireSetting(settings, 'apiToken');

  if (text.length > MAX_SMS_BODY_CHARS) {
    throw new Error(
      `Message is ${text.length} characters; Tychron accepts at most ${MAX_SMS_BODY_CHARS}`
    );
  }

  console.log(`[send:tychron] SMS ${from} → ${to} (${text.length} chars)`);

  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(settings),
    body: JSON.stringify({
      from,
      to: [to],
      body: text,
      // There is no callback URL to give: reports go to the endpoint
      // configured on this number's Switch. Without opting in there are no
      // delivery events at all, and the thread never shows sent or failed.
      request_delivery_report: 'always'
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(`[send:tychron] SMS ${response.status}: ${JSON.stringify(data)}`);
    const err = new Error('Provider send failed');
    err.response = { data, status: response.status };
    throw err;
  }

  const record = recipientRecord(data, to);

  // 207 is "well formed, but this recipient did not go" — and it passes
  // response.ok, so it has to be caught by looking at the record itself
  // rather than at the status.
  if (!record || !record.id) {
    console.error(`[send:tychron] SMS ${response.status} but no message id: ${JSON.stringify(data)}`);
    const err = new Error('Provider send failed');
    err.response = { data, status: response.status };
    throw err;
  }

  const parts = Array.isArray(record.parts)
    ? record.parts.map((p) => p && p.id).filter(Boolean)
    : [];

  console.log(`[send:tychron] SMS accepted: id=${record.id} parts=${parts.length || 1}`);
  return { id: record.id, parts, raw: data };
}

/**
 * The send response is keyed by the recipient in plain digits ("12003004001"),
 * while we send E.164 ("+12003004001").
 */
function recipientRecord(data, to) {
  if (!data || typeof data !== 'object') return null;
  const digits = String(to).replace(/\D/g, '');
  if (data[digits]) return data[digits];
  if (data[to]) return data[to];
  const values = Object.values(data);
  return values.length === 1 ? values[0] : null;
}

/**
 * POST {mmsUrl}
 *
 * Text is a part here, not a top-level field, and attachments are inline
 * base64 rather than URLs the provider fetches. We do not use Tychron's `uri`
 * part form on purpose: it would require EchoMedia to be reachable from
 * Tychron's network, which is a separate decision from adding a carrier.
 *
 * @returns {Promise<{ id: string, parts: string[], raw: object }>}
 */
async function sendTychronMms({ from, to, text, attachments, settings }) {
  const url = requireSetting(settings, 'mmsUrl');
  requireSetting(settings, 'apiToken');

  const parts = [];

  if (text) {
    parts.push({
      id: 'text-part',
      content_type: 'text/plain',
      transfer_encoding: 'identity',
      body: text
    });
  }

  attachments.forEach((attachment, index) => {
    const encoded = attachment.buffer.toString('base64');

    if (encoded.length > MAX_MMS_PART_ENCODED_BYTES) {
      throw new Error(
        `"${attachment.displayName}" is ${Math.round(attachment.buffer.length / 1024)} KB, ` +
          `which exceeds Tychron's 2 MB per-file limit once base64-encoded ` +
          `(${Math.round(encoded.length / 1024)} KB). Send a smaller file.`
      );
    }
    if (encoded.length > WARN_MMS_PART_ENCODED_BYTES) {
      console.warn(
        `[send:tychron] "${attachment.displayName}" encodes to ` +
          `${Math.round(encoded.length / 1024)} KB — over Tychron's 1 MB guidance; ` +
          'some carriers reject above 500 KB'
      );
    }

    parts.push({
      id: `part-${index}`,
      content_type: attachment.contentType || 'application/octet-stream',
      transfer_encoding: 'base64',
      body: encoded
    });
  });

  console.log(`[send:tychron] MMS ${from} → ${to} (${parts.length} part(s))`);

  const response = await fetch(url, {
    method: 'POST',
    headers: authHeaders(settings),
    body: JSON.stringify({
      type: 'mms_forward_request',
      from,
      to: [to],
      parts,
      request_delivery_report: true
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error(`[send:tychron] MMS ${response.status}: ${JSON.stringify(data)}`);
    const err = new Error('Provider send failed');
    err.response = { data, status: response.status };
    throw err;
  }

  const record = Array.isArray(data.records) ? data.records[0] : null;
  if (!record || !record.id) {
    console.error(`[send:tychron] MMS accepted but no record id: ${JSON.stringify(data)}`);
    const err = new Error('Provider send failed');
    err.response = { data, status: response.status };
    throw err;
  }

  console.log(`[send:tychron] MMS accepted: id=${record.id}`);
  // MMS is not segmented the way SMS is; its DLR references the record id
  // directly, so there are no part ids to record.
  return { id: record.id, parts: [], raw: data };
}

// ─── Inbound MMS parts ───────────────────────────────────────────────────────

function headerValue(part, name) {
  const headers = (part && part.headers) || {};
  return String(headers[name] || '');
}

/** "text/plain; charset=utf-8" → "text/plain" */
function partContentType(part) {
  return headerValue(part, 'content-type').split(';')[0].trim().toLowerCase();
}

/**
 * A filename out of a webhook is untrusted input that becomes a path segment
 * in buildStoragePaths, so it is reduced to a bare basename — "../" in a
 * content-disposition would otherwise write outside MEDIA_ROOT.
 */
function safeFilename(raw, fallback) {
  const base = path.basename(String(raw || '').trim().replace(/\\/g, '/'));
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return cleaned || fallback;
}

function partFilename(part, index, contentType) {
  const disposition = headerValue(part, 'content-disposition');
  let match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  if (match) return safeFilename(match[1], `part-${index}`);

  match = /name="?([^";]+)"?/i.exec(headerValue(part, 'content-type'));
  if (match) return safeFilename(match[1], `part-${index}`);

  return `part-${index}${extensionForMime(contentType) || '.bin'}`;
}

function decodePartBody(part) {
  const encoding = String((part && part.encoding) || 'identity').toLowerCase();
  return Buffer.from((part && part.body) || '', encoding === 'base64' ? 'base64' : 'utf8');
}

/**
 * Flatten an inbound MMS into the message text and its attachments.
 *
 * Parts nest — a multipart node carries sub-parts and an empty body of its
 * own — so this recurses. SMIL layout parts are skipped: they describe how a
 * handset should lay the message out and are not content.
 *
 * @returns {{ text: string, attachments: Array<{contentType: string, displayName: string, buffer: Buffer}> }}
 */
function extractMmsParts(node, accumulator) {
  const acc = accumulator || { text: '', attachments: [] };
  if (!node) return acc;

  if (Array.isArray(node.parts) && node.parts.length > 0) {
    for (const child of node.parts) extractMmsParts(child, acc);
    return acc;
  }
  if (node.is_multipart) return acc;

  const contentType = partContentType(node);
  if (!contentType || SKIP_CONTENT_TYPES.includes(contentType)) return acc;

  if (contentType === 'text/plain') {
    const text = decodePartBody(node).toString('utf8');
    acc.text = acc.text ? `${acc.text}\n${text}` : text;
    return acc;
  }

  const buffer = decodePartBody(node);
  if (buffer.length === 0) return acc;

  acc.attachments.push({
    contentType,
    displayName: partFilename(node, acc.attachments.length, contentType),
    buffer
  });
  return acc;
}

// ─── Delivery status ─────────────────────────────────────────────────────────

/**
 * Tychron's SMS delivery_status → eMessageEventTypeID.
 * null means "in flight, nothing to record" rather than "unknown".
 */
function mapSmsStatus(deliveryStatus) {
  switch (String(deliveryStatus || '').toLowerCase()) {
    case 'delivered':
      return 4;
    case 'undelivered':
    case 'rejected':
    case 'expired':
    case 'deleted':
    case 'failed':
      return 8;
    default:
      // accepted, enroute, unknown, skipped
      return null;
  }
}

/**
 * MMS carries an MM4 status code passed through from the message header, so
 * the case is whatever the originating carrier used — normalize before
 * comparing.
 */
function mapMmsStatus(statusCode) {
  switch (String(statusCode || '').toLowerCase()) {
    case 'retrieved':
    case 'forwarded':
      return 4;
    case 'rejected':
    case 'expired':
    case 'unrecognised':
    case 'unrecognized':
      return 8;
    default:
      // deferred, indeterminate
      return null;
  }
}

/**
 * sms_tbl_MessageEvent.iErrorCode is an INT, but Tychron's codes are strings
 * of "normally 3 alphanumeric characters" and MMS reports carry no numeric
 * code at all. Only a cleanly numeric code goes in the column; anything else
 * is carried in the description instead, which is what the UI renders.
 */
function parseTychronErrorCode(code) {
  const raw = String(code || '').trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

function tychronStatusDescription(status, code) {
  const text = String(status || 'unknown');
  const raw = String(code || '').trim();
  if (raw && !/^\d+$/.test(raw)) return `${text} (${raw})`;
  return text;
}

module.exports = {
  sendTychronMessage,
  sendTychronSms,
  sendTychronMms,
  extractMmsParts,
  mapSmsStatus,
  mapMmsStatus,
  parseTychronErrorCode,
  tychronStatusDescription,
  MAX_SMS_BODY_CHARS,
  MAX_MMS_PART_ENCODED_BYTES
};
