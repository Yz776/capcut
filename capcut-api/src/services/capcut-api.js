// src/services/capcut-api.js
// Direct axios client untuk CapCut internal API.
// Lebih cepat & reliable daripada puppeteer scraping.
// Berfungsi TANPA login untuk: list, search, detail, get_preview_video.
//
// Endpoint: https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates
// Params: { keyword?, category?, template_id?, tabs, region_code, language, cursor, size }

import axios from 'axios';
import { config } from '../utils/config.js';
import { logger } from '../utils/logger.js';

const API_BASE = 'https://www.capcut.com/luckycat/i18n/capcut/thirdpatry_share/v1/landing_page/get_similar_templates';
const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': 'https://www.capcut.com/zh-tw/template',
  'appid': '348188',
  'pf': '7',
  'loc': 'sg',
  'sign-ver': '1',
  'app-sdk-version': '48.0.0',
  'appvr': '5.8.0',
  'accept': 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
};

/**
 * List template populer by category (atau keyword kosong utk default).
 * @param {Object} opts - { category, keyword, limit, region, language, cursor }
 * @returns {Promise<Array>} array of normalized template object
 */
export async function listTemplates({ category = 'social', keyword, limit = 20, region = 'tw', language = 'zh-tw', cursor } = {}) {
  const params = {
    keyword: keyword || category,
    category: category,
    tabs: 'video',
    region_code: region,
    language,
    cursor: cursor || '',
    size: Math.min(limit, 50),
  };

  logger.info({ params }, 'CapCut API: listTemplates');
  const res = await axios.get(API_BASE, { params, headers: DEFAULT_HEADERS, timeout: 15000 });

  const rawList = res.data?.data?.video_template_list?.video_template_list || [];
  return rawList.slice(0, limit).map(normalizeTemplate);
}

/**
 * Search template by keyword.
 */
export async function searchTemplates(keyword, { limit = 20, region = 'tw', language = 'zh-tw', cursor } = {}) {
  if (!keyword) throw new Error('Keyword required');
  return listTemplates({ keyword, category: keyword, limit, region, language, cursor });
}

/**
 * Get info detail 1 template by ID.
 * Pakai HTML scrape (lightweight puppeteer) — API get_similar_templates hanya return
 * templates LAIN yang similar, bukan info template itu sendiri.
 *
 * @param {string} templateId
 * @returns {Promise<Object>} { id, title, durationMs, useCount, coverUrl, videoUrl, detailUrl, editorUrl, imageSlots, aspectRatio, tags }
 */
export async function getTemplateInfo(templateId, { region = 'tw', language = 'zh-tw' } = {}) {
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_HEADERS['User-Agent']);

    // URL detail — slug "x" sebagai placeholder (CapCut tidak validasi slug)
    const url = `https://www.capcut.com/${language}/template-detail/x/${templateId}`;
    logger.info({ url, templateId }, 'CapCut API: getTemplateInfo (HTML scrape)');

    // Intercept XHR untuk catch preview video URL dari API similar templates
    let videoUrl = null;
    let coverUrl = null;
    page.on('response', async (res) => {
      if (res.url().includes('get_similar_templates')) {
        try {
          const data = await res.json();
          const list = data?.data?.video_template_list?.video_template_list || [];
          // Cari template dengan ID yang cocok
          const found = list.find(t => String(t.template_id) === String(templateId)) || list[0];
          if (found) {
            videoUrl = found.video_url;
            coverUrl = found.cover_url;
          }
        } catch (_) {}
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    // Scrape info dari page HTML
    const info = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const title = document.title?.replace(/\s*-\s*(video template by )?CapCut.*$/i, '').trim();

      // "Edit Zone: N" → image slot count
      let imageSlots = null;
      const slotMatch = body.match(/Edit Zone[:\s]*(\d+)|編輯區域[:：\s]*(\d+)|编辑区域[:：\s]*(\d+)/i);
      if (slotMatch) {
        const n = parseInt(slotMatch[1] || slotMatch[2] || slotMatch[3], 10);
        if (n > 0 && n < 50) imageSlots = n;
      }

      // "00:12" → duration
      let durationStr = null;
      const durMatch = body.match(/(\d{1,2}):(\d{2})(?![\d:])/);
      if (durMatch) {
        durationStr = durMatch[0];
      }

      // "2.94M 次使用" or "2.94M uses" → use count
      let useCountStr = null;
      const useMatch = body.match(/([\d.]+[KMB]?)\s*(?:次使用|uses?|used)/i);
      if (useMatch) useCountStr = useMatch[1];

      // "3:4" or "16:9" → aspect ratio
      let aspectRatio = null;
      const arMatch = body.match(/(?:長寬比|aspect)[:：\s]*(\d+:\d+)/i);
      if (arMatch) aspectRatio = arMatch[1];

      // Tags "#foryou #trend"
      let tags = [];
      const tagMatch = body.match(/#[\w-]+(?:\s+#[\w-]+){0,9}/);
      if (tagMatch) tags = tagMatch[0].split(/\s+/).map(t => t.replace(/^#/, ''));

      // Cari tombol "Use template" href untuk dapat editorUrl yang valid
      const useBtn = document.querySelector('.btn-use-template');
      let editorUrl = null;
      if (useBtn) {
        const href = useBtn.getAttribute('href') || '';
        const m = href.match(/redirect_url=([^&]+)/);
        if (m) editorUrl = decodeURIComponent(m[1]);
      }

      return { title, imageSlots, durationStr, useCountStr, aspectRatio, tags, editorUrl };
    });

    return {
      id: String(templateId),
      title: info.title,
      detailUrl: url,
      editorUrl: info.editorUrl || `https://www.capcut.com/editor-template?create_id=${templateId}`,
      imageSlots: info.imageSlots,
      durationStr: info.durationStr,
      durationSec: info.durationStr ? parseDurationToSec(info.durationStr) : null,
      useCountStr: info.useCountStr,
      aspectRatio: info.aspectRatio,
      tags: info.tags,
      videoUrl, // preview MP4 (intercepted dari XHR)
      coverUrl,
      raw: info,
    };
  } finally {
    await browser.close();
  }
}

function parseDurationToSec(str) {
  const m = str.match(/(\d+):(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

/**
 * Get preview video URL of template (downloadable MP4).
 */
export async function getTemplatePreviewVideo(templateId, { region = 'tw', language = 'zh-tw' } = {}) {
  const info = await getTemplateInfo(templateId, { region, language });
  return info.videoUrl;
}

/**
 * Scrape "Edit Zone: N" info dari template detail page (slot count).
 */
async function getImageSlotCount(templateId, region, language) {
  // Lazy-import puppeteer hanya kalau butuh slot count
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  try {
    const page = await browser.newPage();
    const url = `https://www.capcut.com/${language}/template-detail/x/${templateId}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    // Cari angka di "Edit Zone: N"
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const m = bodyText.match(/Edit Zone[:\s]*(\d+)|編輯區域[:：\s]*(\d+)|编辑区域[:：\s]*(\d+)/i);
    if (m) {
      const n = parseInt(m[1] || m[2] || m[3], 10);
      if (n > 0 && n < 50) return n;
    }

    // Fallback: cari "replace N photos/images/clips"
    const m2 = bodyText.match(/(\d+)\s*(?:photos?|images?|clips?|素材)/i);
    if (m2) return parseInt(m2[1], 10);

    return null; // unknown
  } catch (e) {
    logger.warn({ err: e.message, templateId }, 'getImageSlotCount failed');
    return null;
  } finally {
    await browser.close();
  }
}

/**
 * Normalize raw API response ke format konsisten.
 */
function normalizeTemplate(t) {
  return {
    id: String(t.template_id),
    title: (t.title || t.title_desc || '').trim(),
    description: t.title_desc || '',
    durationMs: t.template_duration,
    durationSec: t.template_duration ? Math.round(t.template_duration / 1000) : null,
    useCount: t.use_count,
    likeCount: t.like_count,
    commentCount: t.comment_count,
    coverUrl: t.cover_url,
    coverWidth: t.cover_width,
    coverHeight: t.cover_height,
    videoUrl: t.video_url, // preview MP4 — bisa langsung didownload
    videoRatio: t.video_ratio,
    author: t.author,
    detailUrl: `https://www.capcut.com/zh-tw/template-detail/x/${t.template_id}`,
    editorUrl: `https://www.capcut.com/editor-template?create_id=${t.template_id}`,
    structuredData: typeof t.structured_data === 'string'
      ? safeJsonParse(t.structured_data)
      : t.structured_data,
  };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (_) { return s; }
}

export default { listTemplates, searchTemplates, getTemplateInfo, getTemplatePreviewVideo };
