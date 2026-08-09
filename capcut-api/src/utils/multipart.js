// src/utils/multipart.js
import formidable from 'formidable';
import path from 'node:path';
import fs from 'node:fs';
import { nanoid } from 'nanoid';
import { config } from './config.js';

/**
 * Parse multipart form-data request using formidable.
 *
 * @param {import('http').IncomingMessage} req - Node raw request
 * @returns {Promise<{ fields: Object, files: Object[] }>}
 */
export function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const tmpDir = path.join(config.storage.tmpDir, 'multipart', nanoid(10));
    fs.mkdirSync(tmpDir, { recursive: true });

    const form = formidable({
      uploadDir: tmpDir,
      keepExtensions: true,
      maxFileSize: 50 * 1024 * 1024, // 50MB per file
      maxTotalFileSize: 200 * 1024 * 1024, // 200MB total
      multiples: true,
      allowEmptyFiles: true,
    });

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);

      // Normalize: kumpulkan semua file dari berbagai fieldname jadi 1 array
      const fileList = [];
      for (const key of Object.keys(files)) {
        const v = files[key];
        if (Array.isArray(v)) fileList.push(...v);
        else fileList.push(v);
      }

      // Flatten fields yang array 1-elemen jadi string (formidable v3 selalu return array)
      const flatFields = {};
      for (const k of Object.keys(fields)) {
        const val = fields[k];
        flatFields[k] = Array.isArray(val) && val.length === 1 ? val[0] : val;
      }

      resolve({ fields: flatFields, files: fileList });
    });
  });
}
