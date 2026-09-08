/**
 * Bandwidth Media API helpers
 *
 * - downloadMedia(providerUrl, settings)           → { buffer, contentLength }
 * - uploadMedia(mediaName, buffer, contentType, settings) → public Bandwidth media URL
 *
 * settings: parsed jsonSettings from sms_tbl_CarrierApplication
 *   { accountId, apiToken, apiSecret, applicationId }
 *
 * Falls back to the BANDWIDTH_* rows in PlatformConfig when no carrier
 * settings are provided
 * (backward-compat during migration before all business phones are in DB).
 *
 * Reference: https://dev.bandwidth.com/docs/messaging/media/
 */

const { settings: platformSettings } = require('./settings');

/**
 * Bandwidth's own API base, and the account credentials, come from
 * PlatformConfig through NocoDB — with
 * the per-carrier row from sms_tbl_CarrierApplication still winning when one
 * is passed in.
 */
function bandwidthBase() {
  return (
    platformSettings().BANDWIDTH_MESSAGING_API_BASE_URL ||
    'https://messaging.bandwidth.com/api/v2'
  );
}

function basicAuthHeader(settings) {
  const token  = settings?.apiToken  ?? platformSettings().BANDWIDTH_API_TOKEN  ?? '';
  const secret = settings?.apiSecret ?? platformSettings().BANDWIDTH_API_SECRET ?? '';
  return 'Basic ' + Buffer.from(`${token}:${secret}`).toString('base64');
}

/**
 * Download a media file from Bandwidth's temporary URL.
 * @param {string} providerUrl - The Bandwidth media URL (from inbound webhook)
 * @param {object|null} settings - Carrier settings from DB (apiToken, apiSecret)
 * @returns {Promise<{ buffer: Buffer, contentLength: number }>}
 */
async function downloadMedia(providerUrl, settings) {
  console.log(`[bandwidth-media] Downloading: ${providerUrl}`);

  const response = await fetch(providerUrl, {
    method: 'GET',
    headers: { Authorization: basicAuthHeader(settings) }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Bandwidth download failed (${response.status}): ${text}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  console.log(`[bandwidth-media] Downloaded ${buffer.length} bytes from ${providerUrl}`);
  return { buffer, contentLength: buffer.length };
}

/**
 * Upload a media file to Bandwidth so it can be referenced in outbound messages.
 *
 * PUT /users/{accountId}/media/{mediaName}
 *
 * @param {string} mediaName   - Unique name for the media (used in the URL)
 * @param {Buffer} buffer      - File contents
 * @param {string} contentType - MIME type
 * @param {object|null} settings - Carrier settings from DB (accountId, apiToken, apiSecret)
 * @returns {Promise<string>} The public Bandwidth media URL to include in message.media[]
 */
async function uploadMedia(mediaName, buffer, contentType, settings) {
  const accountId = settings?.accountId ?? platformSettings().BANDWIDTH_ACCOUNT_ID ?? '';
  const url = `${bandwidthBase()}/users/${accountId}/media/${encodeURIComponent(mediaName)}`;
  console.log(`[bandwidth-media] Uploading ${buffer.length} bytes as "${mediaName}" to ${url}`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: basicAuthHeader(settings),
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': String(buffer.length)
    },
    body: buffer
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Bandwidth upload failed (${response.status}): ${text}`);
  }

  const mediaUrl = `${bandwidthBase()}/users/${accountId}/media/${encodeURIComponent(mediaName)}`;
  console.log(`[bandwidth-media] Uploaded successfully: ${mediaUrl}`);
  return mediaUrl;
}

module.exports = { downloadMedia, uploadMedia };
