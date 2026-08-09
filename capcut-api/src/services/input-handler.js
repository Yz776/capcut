// src/services/input-handler.js
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { nanoid } from 'nanoid';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

/**
 * Handle 4 format input gambar:
 * 1. URL gambar (JSON {imageUrls: [...]} atau {images: [{type:'url', value:'...'}]})
 * 2. Multipart upload (form-data files[])
 * 3. Base64 (JSON {imagesBase64: ['data:image/png;base64,...']})
 * 4. Mix URL + upload + base64
 *
 * Semua di-uniform jadi: array of local file paths.
 */

/**
 * @param {Object} opts
 * @param {Object} opts.jsonBody - parsed JSON body (kalau ada)
 * @param {Object[]} opts.files - array of {fieldname, filename, mimetype, filepath} dari formidable
 * @returns {Promise<string[]>} array of local file paths
 */
export async function resolveImages({ jsonBody, files }) {
  const out = [];
  const jobTmp = path.join(config.storage.tmpDir, 'images', nanoid(10));
  fs.mkdirSync(jobTmp, { recursive: true });

  // 1. Multipart upload files
  if (files && Array.isArray(files) && files.length > 0) {
    for (const f of files) {
      const ext = mimeToExt(f.mimetype) || path.extname(f.filename) || '.jpg';
      const dest = path.join(jobTmp, `upload_${out.length}${ext}`);
      // formidable udah simpan di disk, tinggal copy
      fs.copyFileSync(f.filepath, dest);
      out.push(dest);
      logger.debug({ dest, src: f.filename }, 'image from upload');
    }
  }

  // 2. JSON body
  if (jsonBody) {
    // Format A: { imageUrls: ['https://...', 'https://...'] }
    if (Array.isArray(jsonBody.imageUrls)) {
      for (const u of jsonBody.imageUrls) {
        if (typeof u === 'string' && u.startsWith('http')) {
          const p = await downloadImage(u, jobTmp, out.length);
          if (p) out.push(p);
        }
      }
    }

    // Format B: { imagesBase64: ['data:image/png;base64,...', ...] }
    if (Array.isArray(jsonBody.imagesBase64)) {
      for (const b64 of jsonBody.imagesBase64) {
        const p = decodeBase64Image(b64, jobTmp, out.length);
        if (p) out.push(p);
      }
    }

    // Format C: { images: [{type:'url'|'base64'|'file', value:'...'}] }
    if (Array.isArray(jsonBody.images)) {
      for (const item of jsonBody.images) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'url' && item.value?.startsWith('http')) {
          const p = await downloadImage(item.value, jobTmp, out.length);
          if (p) out.push(p);
        } else if (item.type === 'base64') {
          const p = decodeBase64Image(item.value, jobTmp, out.length);
          if (p) out.push(p);
        } else if (item.type === 'file' && item.path && fs.existsSync(item.path)) {
          const ext = path.extname(item.path) || '.jpg';
          const dest = path.join(jobTmp, `file_${out.length}${ext}`);
          fs.copyFileSync(item.path, dest);
          out.push(dest);
        }
      }
    }
  }

  if (out.length < 2) {
    throw new Error(`At least 2 images required (got ${out.length}). Provide via multipart upload, imageUrls array, imagesBase64 array, or images[] object.`);
  }

  logger.info({ count: out.length, dir: jobTmp }, 'Images resolved');
  return out;
}

async function downloadImage(url, dir, index) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase() || '.jpg';
    const dest = path.join(dir, `dl_${index}${ext}`);
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 30000,
      maxContentLength: 50 * 1024 * 1024, // 50MB max
      headers: { 'User-Agent': 'CapCutJJ-API/1.0 (image fetcher)' },
    });
    fs.writeFileSync(dest, Buffer.from(res.data));
    logger.debug({ url, dest }, 'image downloaded');
    return dest;
  } catch (e) {
    logger.warn({ url, err: e.message }, 'Failed to download image');
    return null;
  }
}

function decodeBase64Image(b64, dir, index) {
  try {
    let data, ext = '.jpg';
    const m = b64.match(/^data:(image\/(\w+));base64,(.+)$/);
    if (m) {
      ext = '.' + (m[2] === 'jpeg' ? 'jpg' : m[2]);
      data = Buffer.from(m[3], 'base64');
    } else {
      data = Buffer.from(b64, 'base64');
    }
    const dest = path.join(dir, `b64_${index}${ext}`);
    fs.writeFileSync(dest, data);
    return dest;
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to decode base64 image');
    return null;
  }
}

function mimeToExt(mime) {
  if (!mime) return null;
  const map = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
  };
  return map[mime.toLowerCase()] || null;
}
