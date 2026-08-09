// src/utils/config.js
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

function bool(v, def = false) {
  if (v === undefined) return def;
  return v === 'true' || v === '1' || v === 'yes';
}

function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export const config = {
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  browser: {
    headless: bool(process.env.HEADLESS, true),
    slowMo: int(process.env.SLOW_MO, 0),
    viewportWidth: int(process.env.VIEWPORT_WIDTH, 1440),
    viewportHeight: int(process.env.VIEWPORT_HEIGHT, 900),
    navTimeout: int(process.env.NAV_TIMEOUT, 60000),
    renderTimeout: int(process.env.RENDER_TIMEOUT, 300000),
    userDataDir: process.env.CAPCUT_USER_DATA_DIR || '',
  },

  capcut: {
    baseUrl: process.env.CAPCUT_BASE_URL || 'https://www.capcut.com',
    templatesPath: process.env.CAPCUT_TEMPLATES_PATH || '/templates',
    email: process.env.CAPCUT_EMAIL || '',
    password: process.env.CAPCUT_PASSWORD || '',
  },

  storage: {
    downloadDir: path.resolve(projectRoot, process.env.DOWNLOAD_DIR || './downloads'),
    videoDir: path.resolve(projectRoot, process.env.VIDEO_DIR || './videos'),
    tmpDir: path.resolve(projectRoot, process.env.TMP_DIR || './tmp'),
    tmpTtlMinutes: int(process.env.TMP_TTL_MINUTES, 60),
  },

  jobs: {
    maxConcurrent: int(process.env.MAX_CONCURRENT_JOBS, 1),
    ttlMinutes: int(process.env.JOB_TTL_MINUTES, 120),
  },

  logLevel: process.env.LOG_LEVEL || 'info',

  projectRoot,
};

export default config;
