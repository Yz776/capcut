// src/routes/templates.js
import { Hono } from 'hono';
import { listTemplates, searchTemplates, getTemplateInfo, getTemplatePreviewVideo } from '../services/capcut-api.js';
import { logger } from '../utils/logger.js';

const app = new Hono();

/**
 * GET /templates?limit=20&category=social&keyword=
 * List template populer. Default category: social.
 * Tidak butuh login.
 */
app.get('/', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20', 10);
    const category = c.req.query('category') || 'social';
    const keyword = c.req.query('keyword');
    const region = c.req.query('region') || 'tw';
    const language = c.req.query('language') || 'zh-tw';

    const templates = await listTemplates({ category, keyword, limit, region, language });
    return c.json({
      count: templates.length,
      filters: { category, keyword, region, language, limit },
      templates,
    });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'GET /templates failed');
    return c.json({ error: e.message }, 500);
  }
});

/**
 * GET /templates/search?q=keyword&limit=20
 * Search template by keyword. Tidak butuh login.
 */
app.get('/search', async (c) => {
  const q = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const region = c.req.query('region') || 'tw';
  const language = c.req.query('language') || 'zh-tw';
  if (!q) return c.json({ error: 'Query parameter "q" required' }, 400);

  try {
    const templates = await searchTemplates(q, { limit, region, language });
    return c.json({ count: templates.length, query: q, templates });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'GET /templates/search failed');
    return c.json({ error: e.message }, 500);
  }
});

/**
 * GET /templates/:id
 * Get template detail by ID. ID bisa juga berupa URL detail lengkap.
 * Tidak butuh login.
 */
app.get('/:id', async (c) => {
  const idParam = c.req.param('id');
  // Extract ID from URL jika user kasih URL lengkap
  const id = extractTemplateId(idParam);
  if (!id) {
    return c.json({ error: 'Invalid template ID or URL', input: idParam }, 400);
  }

  try {
    const template = await getTemplateInfo(id);
    return c.json({ template });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'GET /templates/:id failed');
    return c.json({ error: e.message }, 500);
  }
});

/**
 * GET /templates/:id/preview
 * Direct redirect ke URL video preview template (MP4).
 */
app.get('/:id/preview', async (c) => {
  const idParam = c.req.param('id');
  const id = extractTemplateId(idParam);
  if (!id) return c.json({ error: 'Invalid template ID' }, 400);

  try {
    const videoUrl = await getTemplatePreviewVideo(id);
    if (!videoUrl) return c.json({ error: 'Preview video not available' }, 404);
    return c.redirect(videoUrl);
  } catch (e) {
    return c.json({ error: e.message }, 500);
  }
});

/**
 * Extract template ID from input.
 * Supports:
 *   - "7492444922599968053"  (raw ID)
 *   - "https://www.capcut.com/zh-tw/template-detail/some-slug/7492444922599968053"
 *   - "https://www.capcut.com/editor-template?create_id=7492444922599968053"
 */
function extractTemplateId(input) {
  if (!input) return null;
  const s = String(input).trim();

  // Pure numeric ID
  if (/^\d{15,25}$/.test(s)) return s;

  // URL: /template-detail/{slug}/{id}
  let m = s.match(/\/template-detail\/[^/]+\/(\d+)/);
  if (m) return m[1];

  // URL: /template-detail/{id} (no slug)
  m = s.match(/\/template-detail\/(\d+)/);
  if (m) return m[1];

  // URL: editor-template?create_id={id}
  m = s.match(/create_id[=](\d+)/);
  if (m) return m[1];

  // Last-resort: cari digit panjang di manapun
  m = s.match(/(\d{15,25})/);
  if (m) return m[1];

  return null;
}

export default app;
