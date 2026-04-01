/**
 * Bandwidth Media API helpers
 *
 * - downloadMedia(providerUrl)  → { buffer, contentLength }
 * - uploadMedia(mediaName, buffer, contentType) → public Bandwidth media URL
 *
 * Reference: https://dev.bandwidth.com/docs/messaging/media/
 */

const BANDWIDTH_BASE = process.env.BANDWIDTH_MESSAGING_API_BASE_URL || 'https://messaging.bandwidth.com/api/v2';
const ACCOUNT_ID     = process.env.BANDWIDTH_ACCOUNT_ID || '';
const API_TOKEN      = process.env.BANDWIDTH_API_TOKEN || '';
const API_SECRET     = process.env.BANDWIDTH_API_SECRET || '';

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${API_TOKEN}:${API_SECRET}`).toString('base64');
}

/**
 * Download a media file from Bandwidth's temporary URL.
 * @param {string} providerUrl - The Bandwidth media URL (from inbound webhook)
 * @returns {Promise<{ buffer: Buffer, contentLength: number }>}
 */
async function downloadMedia(providerUrl) {
  console.log(`[bandwidth-media] Downloading: ${providerUrl}`);

  const response = await fetch(providerUrl, {
    method: 'GET',
    headers: { Authorization: basicAuthHeader() }
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
 * @param {string} mediaName  - Unique name for the media (used in the URL)
 * @param {Buffer} buffer     - File contents
 * @param {string} contentType - MIME type
 * @returns {Promise<string>} The public Bandwidth media URL to include in message.media[]
 */
async function uploadMedia(mediaName, buffer, contentType) {
  const url = `${BANDWIDTH_BASE}/users/${ACCOUNT_ID}/media/${encodeURIComponent(mediaName)}`;
  console.log(`[bandwidth-media] Uploading ${buffer.length} bytes as "${mediaName}" to ${url}`);

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': contentType || 'application/octet-stream',
      'Content-Length': String(buffer.length)
    },
    body: buffer
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Bandwidth upload failed (${response.status}): ${text}`);
  }

  const mediaUrl = `${BANDWIDTH_BASE}/users/${ACCOUNT_ID}/media/${encodeURIComponent(mediaName)}`;
  console.log(`[bandwidth-media] Uploaded successfully: ${mediaUrl}`);
  return mediaUrl;
}

module.exports = { downloadMedia, uploadMedia };
