// src/routes/templates.js
import { Hono } from 'hono';
import { CapCutBrowser } from '../services/capcut-browser.js';
import { logger } from '../utils/logger.js';

const app = new Hono();

/**
 * GET /templates?limit=20&category=
 * List template populer
 */
app.get('/', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20', 10);
  const category = c.req.query('category');

  const browser = new CapCutBrowser();
  try {
    await browser.launch();
    await browser.login();
    const templates = await browser.listTemplates({ limit, category });
    return c.json({ count: templates.length, templates });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'GET /templates failed');
    return c.json({ error: e.message }, 500);
  } finally {
    await browser.close();
  }
});

/**
 * GET /templates/search?q=keyword&limit=20
 */
app.get('/search', async (c) => {
  const q = c.req.query('q');
  const limit = parseInt(c.req.query('limit') || '20', 10);
  if (!q) return c.json({ error: 'Query parameter "q" required' }, 400);

  const browser = new CapCutBrowser();
  try {
    await browser.launch();
    await browser.login();
    const templates = await browser.searchTemplates(q, { limit });
    return c.json({ count: templates.length, query: q, templates });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'GET /templates/search failed');
    return c.json({ error: e.message }, 500);
  } finally {
    await browser.close();
  }
});

/**
 * GET /templates/:id - ambil info detail template
 * id bisa berupa template ID atau full URL
 */
app.get('/:id', async (c) => {
  const idParam = c.req.param('id');
  const url = c.req.query('url');

  const browser = new CapCutBrowser();
  try {
    await browser.launch();
    await browser.login();
    const template = await browser.getTemplate(url || idParam);
    return c.json({ template });
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'GET /templates/:id failed');
    return c.json({ error: e.message }, 500);
  } finally {
    await browser.close();
  }
});

export default app;
