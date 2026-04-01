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

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/media';

// ─── MIME detection via magic bytes (file-type is ESM-only) ──────────────────

/** @returns {Promise<import('file-type')>} */
async function loadFileType() {
  return await import('file-type');
}

/**
 * Detect MIME type from a buffer using magic byte inspection.
 * Falls back to 'application/octet-stream' if detection fails.
 * @param {Buffer} buffer
 * @returns {Promise<string>}
 */
async function detectMimeType(buffer) {
  try {
    const { fileTypeFromBuffer } = await loadFileType();
    const result = await fileTypeFromBuffer(buffer);
    if (result?.mime) {
      console.log(`[mediaObtain] Magic byte detected: ${result.mime}`);
      return result.mime;
    }
  } catch (err) {
    console.warn('[mediaObtain] file-type detection error:', err.message);
  }
  return 'application/octet-stream';
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
 * Compute the relative storage path (for DB / URL serving).
 * Strips the MEDIA_ROOT prefix so the path is relative.
 */
function relativeStoragePath(absolutePath) {
  return absolutePath.replace(MEDIA_ROOT, '').replace(/\\/g, '/');
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

      // 1. Download from Bandwidth
      const { buffer, contentLength } = await downloadMedia(item.providerId);

      // 2. Detect MIME type via magic bytes
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

module.exports = { obtainPendingMedia, detectMimeType, generateThumbnail, buildStoragePaths, relativeStoragePath, MEDIA_ROOT };
