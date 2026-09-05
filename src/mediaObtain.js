/**
 * Media obtain worker — downloads pending media from Bandwidth,
 * detects MIME types via magic bytes, generates thumbnails,
 * and updates the database.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const { downloadMedia } = require('./bandwidth-media');

// A mount point, not a setting: read once here, and every storagePath on disk
// is relative to it. Under docker compose the volume decides it, and this
// default matches. See .env.example.
const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';

// ─── MIME detection via magic bytes ──────────────────────────────────────────
// Inline header-signature detection for the file types Bandwidth MMS accepts
// plus a few common office/document types. No external dependency.

function eq(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

function asciiAt(buffer, offset, s) {
  return eq(buffer, offset, Buffer.from(s, 'ascii'));
}

// Map an ISO BMFF "ftyp" major brand (4 ASCII chars at offset 8) to a MIME type.
function ftypBrandToMime(brand) {
  const b = brand.toLowerCase();
  if (b.startsWith('qt  ') || b === 'qt  ') return 'video/quicktime';
  if (b.startsWith('3gp') || b.startsWith('3g2')) return 'video/3gpp';
  if (b === 'heic' || b === 'heix' || b === 'hevc' || b === 'hevx' || b === 'mif1' || b === 'msf1' || b === 'heim' || b === 'heis') return 'image/heic';
  if (b === 'avif' || b === 'avis') return 'image/avif';
  if (b === 'm4a ' || b === 'm4b ' || b === 'f4a ' || b === 'f4b ') return 'audio/mp4';
  // isom / mp41 / mp42 / iso2 / avc1 / dash / mmp4 / etc. → generic mp4 video
  return 'video/mp4';
}

/**
 * Detect MIME type from a buffer using magic-byte inspection.
 * Falls back to 'application/octet-stream' if detection fails.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function detectMimeType(buffer) {
  if (!buffer || buffer.length < 4) return 'application/octet-stream';

  // JPEG
  if (eq(buffer, 0, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';

  // PNG
  if (eq(buffer, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';

  // GIF87a / GIF89a
  if (asciiAt(buffer, 0, 'GIF87a') || asciiAt(buffer, 0, 'GIF89a')) return 'image/gif';

  // BMP
  if (asciiAt(buffer, 0, 'BM')) return 'image/bmp';

  // RIFF-based (WEBP / WAV / AVI)
  if (asciiAt(buffer, 0, 'RIFF') && buffer.length >= 12) {
    if (asciiAt(buffer, 8, 'WEBP')) return 'image/webp';
    if (asciiAt(buffer, 8, 'WAVE')) return 'audio/wav';
    if (asciiAt(buffer, 8, 'AVI ')) return 'video/x-msvideo';
  }

  // ISO BMFF: ftyp at offset 4
  if (asciiAt(buffer, 4, 'ftyp') && buffer.length >= 12) {
    const brand = buffer.slice(8, 12).toString('ascii');
    return ftypBrandToMime(brand);
  }

  // PDF
  if (asciiAt(buffer, 0, '%PDF')) return 'application/pdf';

  // ZIP-based (plain zip, docx, xlsx, pptx)
  if (eq(buffer, 0, [0x50, 0x4B, 0x03, 0x04]) || eq(buffer, 0, [0x50, 0x4B, 0x05, 0x06]) || eq(buffer, 0, [0x50, 0x4B, 0x07, 0x08])) {
    return 'application/zip';
  }

  // MP3: ID3v2 tag or raw MPEG audio frame
  if (asciiAt(buffer, 0, 'ID3')) return 'audio/mpeg';
  if (buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0) {
    // MPEG audio frame sync — MP3 (layer III) or other MPEG audio
    return 'audio/mpeg';
  }

  // Ogg
  if (asciiAt(buffer, 0, 'OggS')) return 'audio/ogg';

  // AMR
  if (asciiAt(buffer, 0, '#!AMR\n')) return 'audio/amr';

  // WebM / Matroska (EBML header)
  if (eq(buffer, 0, [0x1A, 0x45, 0xDF, 0xA3])) return 'video/webm';

  // MPEG-PS / MPEG-TS quick hints
  if (eq(buffer, 0, [0x00, 0x00, 0x01, 0xBA]) || eq(buffer, 0, [0x00, 0x00, 0x01, 0xB3])) return 'video/mpeg';

  return 'application/octet-stream';
}

// ─── Extension-based fallbacks (for formats with no magic bytes) ─────────────

// Canonical extension for a MIME type. Used to rewrite display_name so
// Bandwidth's extension/content-type consistency check passes.
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/avif': '.avif',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/3gpp': '.3gp',
  'video/webm': '.webm',
  'video/mpeg': '.mpeg',
  'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/amr': '.amr',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/calendar': '.ics',
  'text/vcard': '.vcf',
  'application/json': '.json',
  'application/xml': '.xml'
};

function extensionForMime(mime) {
  return MIME_TO_EXT[(mime || '').toLowerCase()] || null;
}

// Text-like formats with no reliable magic bytes — fall back to extension.
const EXT_TO_MIME_TEXT = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.ics': 'text/calendar',
  '.vcf': 'text/vcard',
  '.json': 'application/json',
  '.xml': 'application/xml'
};

function mimeFromExtension(extension) {
  const ext = String(extension || '').toLowerCase();
  return EXT_TO_MIME_TEXT[ext] || null;
}

// ─── Thumbnail generation ────────────────────────────────────────────────────

const THUMB_MAX = 300;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VIDEO_TYPES = ['video/mp4', 'video/3gpp', 'video/quicktime', 'video/x-msvideo', 'video/mpeg'];

/**
 * Generate a thumbnail for an image or video file.
 * @param {string} inputPath  - Path to the source file
 * @param {string} outputPath - Destination for the thumbnail JPEG
 * @param {string} mimeType   - Detected MIME type
 * @returns {Promise<boolean>} true if thumbnail was generated
 */
async function generateThumbnail(inputPath, outputPath, mimeType) {
  try {
    if (IMAGE_TYPES.includes(mimeType)) {
      return await generateImageThumbnail(inputPath, outputPath);
    }
    if (VIDEO_TYPES.includes(mimeType)) {
      return await generateVideoThumbnail(inputPath, outputPath);
    }
    console.log(`[mediaObtain] No thumbnail for type: ${mimeType}`);
    return false;
  } catch (err) {
    console.error(`[mediaObtain] Thumbnail generation failed for ${inputPath}:`, err.message);
    return false;
  }
}

/**
 * Resize an image to fit within THUMB_MAX x THUMB_MAX using sharp.
 */
async function generateImageThumbnail(inputPath, outputPath) {
  await sharp(inputPath)
    .resize(THUMB_MAX, THUMB_MAX, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 80 })
    .toFile(outputPath);
  console.log(`[mediaObtain] Image thumbnail created: ${outputPath}`);
  return true;
}

/**
 * Extract the first frame of a video with ffmpeg, then resize with sharp.
 */
function generateVideoThumbnail(inputPath, outputPath) {
  const tempFrame = outputPath.replace(/\.jpg$/, '-frame.png');
  return new Promise((resolve) => {
    ffmpeg(inputPath)
      .on('error', (err) => {
        console.warn(`[mediaObtain] ffmpeg frame extraction failed: ${err.message}`);
        resolve(false);
      })
      .on('end', async () => {
        try {
          if (!fs.existsSync(tempFrame)) { resolve(false); return; }
          await sharp(tempFrame)
            .resize(THUMB_MAX, THUMB_MAX, { fit: 'cover', position: 'centre' })
            .jpeg({ quality: 80 })
            .toFile(outputPath);
          fs.unlinkSync(tempFrame); // clean up temp frame
          console.log(`[mediaObtain] Video thumbnail created: ${outputPath}`);
          resolve(true);
        } catch (err) {
          console.error(`[mediaObtain] Video thumbnail sharp resize failed:`, err.message);
          if (fs.existsSync(tempFrame)) fs.unlinkSync(tempFrame);
          resolve(false);
        }
      })
      .screenshots({
        count: 1,
        timemarks: ['00:00:00.100'],
        filename: path.basename(tempFrame),
        folder: path.dirname(tempFrame),
        size: `${THUMB_MAX}x?`
      });
  });
}

// ─── Storage path helpers ────────────────────────────────────────────────────

/**
 * Build the storage directory and file paths for a media item.
 * Pattern: /{businessPhone}/{customerPhone}/{messageId}/{uidMediaId}/
 */
function buildStoragePaths(businessPhone, customerPhone, messageId, uidMediaId, displayName) {
  const dir = path.join(
    MEDIA_ROOT,
    String(businessPhone),
    String(customerPhone),
    String(messageId),
    uidMediaId
  );
  const filePath = path.join(dir, displayName);
  const thumbName = `thumbnail-${path.parse(displayName).name}.jpg`;
  const thumbPath = path.join(dir, thumbName);
  return { dir, filePath, thumbPath };
}

/**
 * Build the storage directory and file paths for a draft media item
 * (attachment picked but not yet sent).
 * Pattern: /_drafts/{businessPhone}/{customerPhone}/{uidDraftMediaId}/
 */
function buildDraftStoragePaths(businessPhone, customerPhone, uidDraftMediaId, displayName) {
  const dir = path.join(
    MEDIA_ROOT,
    '_drafts',
    String(businessPhone),
    String(customerPhone),
    uidDraftMediaId
  );
  const filePath = path.join(dir, displayName);
  const thumbName = `thumbnail-${path.parse(displayName).name}.jpg`;
  const thumbPath = path.join(dir, thumbName);
  return { dir, filePath, thumbPath };
}

/**
 * Compute the relative storage path (for DB / URL serving).
 * Strips the MEDIA_ROOT prefix so the path is relative.
 */
function relativeStoragePath(absolutePath) {
  return absolutePath.replace(MEDIA_ROOT, '').replace(/\\/g, '/');
}

// ─── Carrier settings resolver ───────────────────────────────────────────────

/**
 * Look up carrier jsonSettings for a business number from the DB.
 * Results are cached in the provided Map for the duration of a single obtain run.
 *
 * Falls back to null when the business phone is not yet in the DB, which causes
 * bandwidth-media helpers to fall back to BANDWIDTH_* env vars.
 *
 * @param {import('mysql2/promise').Pool} dbPool
 * @param {number} iBusinessNumber
 * @param {Map<number, object|null>} cache
 * @returns {Promise<object|null>}
 */
async function resolveCarrierSettings(dbPool, iBusinessNumber, cache) {
  if (cache.has(iBusinessNumber)) return cache.get(iBusinessNumber);
  try {
    const [rows] = await dbPool.query('CALL sms_usp_BusinessPhone_GET(?)', [iBusinessNumber]);
    const row = rows?.[0]?.[0];
    if (row?.jsonSettings) {
      const settings = typeof row.jsonSettings === 'string'
        ? JSON.parse(row.jsonSettings)
        : row.jsonSettings;
      cache.set(iBusinessNumber, settings);
      return settings;
    }
  } catch (err) {
    console.warn(`[mediaObtain] Could not resolve carrier settings for ${iBusinessNumber}:`, err.message);
  }
  if (!cache.has(iBusinessNumber)) {
    console.warn(`[mediaObtain] No DB carrier settings for ${iBusinessNumber}, using env fallback`);
  }
  cache.set(iBusinessNumber, null);
  return null;
}

// ─── Main obtain worker ──────────────────────────────────────────────────────

/**
 * Download all pending media items (or those for a specific messageId),
 * save to storage, detect MIME, generate thumbnails, and update DB.
 *
 * @param {import('mysql2/promise').Pool} dbPool  - Database connection pool
 * @param {number|null} messageId - Optional: only process media for this message
 * @returns {Promise<{ obtained: number, failed: number, skipped: number }>}
 */
async function obtainPendingMedia(dbPool, messageId = null) {
  const counts = { obtained: 0, failed: 0, skipped: 0 };
  const settingsCache = new Map();

  console.log(`[mediaObtain] Starting obtain run (messageId=${messageId || 'ALL'})`);

  // Fetch pending media items
  const [rows] = await dbPool.query('CALL sms_usp_MediaPending_GET(?)', [messageId]);
  const items = rows?.[0] || [];

  if (items.length === 0) {
    console.log('[mediaObtain] No pending media items found');
    return counts;
  }

  console.log(`[mediaObtain] Found ${items.length} pending media item(s)`);

  for (const item of items) {
    try {
      console.log(`[mediaObtain] Processing ${item.uidMediaId} (${item.displayName}) from message ${item.iMessageId}`);

      // 1. Resolve carrier credentials for this business number
      const carrierSettings = await resolveCarrierSettings(dbPool, item.iBusinessNumber, settingsCache);

      // 2. Download from Bandwidth
      const { buffer, contentLength } = await downloadMedia(item.providerId, carrierSettings);

      // 3. Detect MIME type via magic bytes
      const contentType = await detectMimeType(buffer);

      // 3. Build storage paths
      const { dir, filePath, thumbPath } = buildStoragePaths(
        item.iBusinessNumber,
        item.iCustomerNumber,
        item.iMessageId,
        item.uidMediaId,
        item.displayName
      );

      // 4. Save file to storage
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buffer);
      console.log(`[mediaObtain] Saved ${contentLength} bytes to ${filePath}`);

      // 5. Generate thumbnail (if applicable)
      const thumbGenerated = await generateThumbnail(filePath, thumbPath, contentType);
      const thumbnailPath = thumbGenerated ? relativeStoragePath(thumbPath) : null;

      // 6. Update database
      await dbPool.query('CALL sms_usp_Media_SET(?, ?, ?, ?, ?)', [
        item.uidMediaId,
        true,
        relativeStoragePath(filePath),
        contentType,
        thumbnailPath
      ]);

      console.log(`[mediaObtain] Completed ${item.uidMediaId}: type=${contentType}, thumb=${!!thumbnailPath}`);
      counts.obtained++;
    } catch (err) {
      console.error(`[mediaObtain] Failed to obtain ${item.uidMediaId}:`, err.message);
      counts.failed++;
    }
  }

  console.log(`[mediaObtain] Run complete: obtained=${counts.obtained}, failed=${counts.failed}, skipped=${counts.skipped}`);
  return counts;
}

module.exports = { obtainPendingMedia, detectMimeType, extensionForMime, mimeFromExtension, generateThumbnail, buildStoragePaths, buildDraftStoragePaths, relativeStoragePath, MEDIA_ROOT };
