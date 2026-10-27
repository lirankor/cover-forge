// cover-forge — deterministic print-style placeholder album covers, rendered by headless Chromium.
//   GET /cover.png?artist=&title=&year=&label=&cat=&layout=1a|1b|1c|1d&seed=0&size=1000[&grain=0&fade=0.14]
//   GET /sheet.png?<same>        2x2 contact sheet of all four layouts
//   &format=jpeg (or /cover.jpg, /sheet.jpg) returns a JPEG (quality JPEG_QUALITY, default 90) instead of a PNG
//   GET /healthz                 {"ok":true,...}
// Auth: if TOKEN is set, `Authorization: Bearer <TOKEN>` or `?token=` is required (healthz stays open).
import http from 'node:http';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import {
  BASE_CSS, COVER_PX, FADE_DEFAULT, FIT_SCRIPT, GRAIN_READY, GRAIN_TILE_HTML, LAYOUTS, PAINT_READY, SHEET_H, SHEET_W, build, coverHtml, sheetHtml,
} from './lib/design.js';

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
export const CONFIG = {
  port: Number(env('PORT', 8793)),
  host: env('HOST', '0.0.0.0'),
  token: env('TOKEN', ''),
  dataDir: env('DATA_DIR', '/data'),
  pages: Math.max(1, Number(env('PAGES', 2))),
  maxSize: Number(env('MAX_SIZE', 2000)),
  defaultSize: Number(env('DEFAULT_SIZE', 1000)),
  jpegQuality: Math.max(1, Math.min(100, Number(env('JPEG_QUALITY', 90)) || 90)),
  executablePath: env('PUPPETEER_EXECUTABLE_PATH', undefined),
  protocolTimeoutMs: Number(env('PROTOCOL_TIMEOUT_MS', 30000)),   // a render never takes >5 s; 30 s = something is wrong
  relaunchAfterFailures: Number(env('RELAUNCH_AFTER_FAILURES', 2)), // consecutive broken pages → restart the whole browser
};

// ---------- params ----------
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
export function normalizeParams(q) {
  const p = {
    artist: clean(q.get('artist')), title: clean(q.get('title')), year: clean(q.get('year'), 12),
    label: clean(q.get('label'), 80), cat: clean(q.get('cat'), 24),
    seed: Math.max(0, Math.min(1_000_000, parseInt(q.get('seed') || '0', 10) || 0)),
    size: Math.round(Number(q.get('size') || CONFIG.defaultSize)),
    grain: q.get('grain') !== '0' && q.get('grain') !== 'false',
    fade: q.has('fade') ? Math.max(0, Math.min(0.5, Number(q.get('fade')))) : FADE_DEFAULT,
    layout: (q.get('layout') || '').toLowerCase(),
    format: ['jpeg', 'jpg'].includes((q.get('format') || '').toLowerCase()) ? 'jpeg' : 'png',
  };
  if (!Number.isFinite(p.size) || p.size < 64) p.size = 64;
  if (p.size > CONFIG.maxSize) p.size = CONFIG.maxSize;
  if (!Number.isFinite(p.fade)) p.fade = FADE_DEFAULT;
  if (p.layout && !LAYOUTS.includes(p.layout)) throw Object.assign(new Error('layout must be one of ' + LAYOUTS.join(',')), { status: 400 });
  return p;
}
export function viewModel(p) {
  const a = build({ artist: p.artist, title: p.title, year: p.year, label: p.label, cat: p.cat }, p.seed);
  return { a, layout: p.layout || a.layout };
}
// PNG keys are unchanged from before JPEG support (existing cache stays valid); JPEG adds format + quality.
const cacheKey = (kind, p, layout) =>
  createHash('sha256').update(JSON.stringify([kind, 5, layout, p.artist, p.title, p.year, p.label, p.cat, p.seed, p.size, p.grain, p.fade,
    ...(p.format === 'jpeg' ? ['jpeg', CONFIG.jpegQuality] : [])])).digest('hex');

// ---------- page pool ----------
const SHELL = `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}</style></head><body><div id="root"></div></body></html>`;
class Pool {
  constructor(n) { this.n = n; this.browser = null; this.free = []; this.waiters = []; this.launching = null; }
  async launch() {
    if (this.launching) return this.launching;
    this.launching = (async () => {
      this.browser = await puppeteer.launch({
        headless: true, executablePath: CONFIG.executablePath, protocolTimeout: CONFIG.protocolTimeoutMs,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars',
          '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text', '--no-first-run', '--no-zygote'],
      });
      this.browser.on('disconnected', () => { this.browser = null; this.free = []; this.launching = null; });
      this.free = [];
      for (let i = 0; i < this.n; i++) this.free.push(await this.newPage());
      this.launching = null;
    })();
    return this.launching;
  }
  async newPage() {
    const page = await this.browser.newPage();
    await page.setViewport({ width: COVER_PX, height: COVER_PX, deviceScaleFactor: 1 });
    await page.setContent(SHELL, { waitUntil: 'load' });
    page._dsf = 1; page._w = COVER_PX; page._h = COVER_PX;
    return page;
  }
  async acquire() {
    if (!this.browser && !this.launching) await this.launch();
    else if (this.launching) await this.launching;
    if (this.free.length) return this.free.pop();
    return new Promise(res => this.waiters.push(res));
  }
  release(page, broken) {
    if (broken) {
      this.failures = (this.failures || 0) + 1;
      page.close().catch(() => {});
      if (this.failures >= CONFIG.relaunchAfterFailures) { this.relaunch().catch(e => console.error('relaunch failed:', e.message)); return; }
      this.newPage().then(p => this.release(p, false)).catch(() => this.relaunch().catch(() => {}));
      return;
    }
    this.failures = 0;
    const w = this.waiters.shift();
    if (w) w(page); else this.free.push(page);
  }
  // Kill and restart Chromium; queued waiters get fresh pages once it is back.
  async relaunch() {
    console.warn('pool: relaunching Chromium after repeated render failures');
    const b = this.browser; this.browser = null; this.free = []; this.failures = 0;
    if (b) { b.removeAllListeners('disconnected'); await Promise.race([b.close(), new Promise(r => setTimeout(r, 5000))]).catch(() => {}); try { b.process()?.kill('SIGKILL'); } catch { /* */ } }
    await this.launch();
    stats.relaunches++;
    while (this.waiters.length && this.free.length) this.waiters.shift()(this.free.pop());
  }
  async close() { const b = this.browser; this.browser = null; if (b) await b.close().catch(() => {}); }
}
const pool = new Pool(CONFIG.pages);
const stats = { renders: 0, cacheHits: 0, errors: 0, relaunches: 0, msTotal: 0, msLast: 0, started: Date.now() };

// Render one fragment (w×h design px) at the given output width; returns PNG (or JPEG) bytes.
async function render(html, w, h, outWidth, format = 'png') {
  const dsf = outWidth / w;
  const page = await pool.acquire();
  let broken = false;
  try {
    if (page._dsf !== dsf || page._w !== w || page._h !== h) {
      await page.setViewport({ width: w, height: h, deviceScaleFactor: dsf });
      page._dsf = dsf; page._w = w; page._h = h;
    }
    if (page._grainDsf !== dsf) {
      await page.evaluate(h => { document.documentElement.style.removeProperty('--grain'); document.getElementById('root').innerHTML = h; }, GRAIN_TILE_HTML);
      await page.evaluate(GRAIN_READY);
      const tile = await (await page.$('#grain-tile')).screenshot({ type: 'png', omitBackground: true });
      await page.evaluate(d => document.documentElement.style.setProperty('--grain', `url("data:image/png;base64,${d}")`), Buffer.from(tile).toString('base64'));
      page._grainDsf = dsf;
    }
    await page.evaluate(h => { document.getElementById('root').innerHTML = h; }, html);
    await page.evaluate(FIT_SCRIPT);
    await page.evaluate(PAINT_READY);
    const shot = format === 'jpeg' ? { type: 'jpeg', quality: CONFIG.jpegQuality } : { type: 'png', optimizeForSpeed: true };
    return await page.screenshot({ ...shot, clip: { x: 0, y: 0, width: w, height: h }, omitBackground: false });
  } catch (e) { broken = true; throw e; } finally { pool.release(page, broken); }
}

// ---------- cache ----------
const cacheDir = () => path.join(CONFIG.dataDir, 'cache');
async function cached(key, produce, ext = 'png') {
  const file = path.join(cacheDir(), key.slice(0, 2), key + '.' + ext);
  try { const b = await fs.readFile(file); stats.cacheHits++; return b; } catch { /* miss */ }
  const buf = await produce();
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.' + Math.random().toString(36).slice(2);
    await fs.writeFile(tmp, buf); await fs.rename(tmp, file);
  } catch (e) { console.warn('cache write failed:', e.message); }
  return buf;
}

export async function renderCover(p) {
  const { a, layout } = viewModel(p);
  return cached(cacheKey('cover', p, layout), async () => {
    const t = Date.now();
    const buf = await render(coverHtml(a, layout, { grain: p.grain, fade: p.fade }), COVER_PX, COVER_PX, p.size, p.format);
    stats.renders++; stats.msLast = Date.now() - t; stats.msTotal += stats.msLast;
    return buf;
  }, p.format === 'jpeg' ? 'jpg' : 'png');
}
export async function renderSheet(p) {
  const { a } = viewModel(p);
  return cached(cacheKey('sheet', p, '*'), async () => {
    const t = Date.now();
    const buf = await render(sheetHtml(a, { grain: p.grain, fade: p.fade }), SHEET_W, SHEET_H, p.size, p.format);
    stats.renders++; stats.msLast = Date.now() - t; stats.msTotal += stats.msLast;
    return buf;
  }, p.format === 'jpeg' ? 'jpg' : 'png');
}

// ---------- http ----------
function authorized(req, q) {
  if (!CONFIG.token) return true;
  const h = req.headers.authorization || '';
  return h === 'Bearer ' + CONFIG.token || q.get('token') === CONFIG.token;
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  if (url.pathname === '/healthz') {
    const body = JSON.stringify({ ok: !!pool.browser, pages: CONFIG.pages, free: pool.free.length, renders: stats.renders, cacheHits: stats.cacheHits,
      errors: stats.errors, relaunches: stats.relaunches, avgMs: stats.renders ? Math.round(stats.msTotal / stats.renders) : null, lastMs: stats.msLast,
      rssMb: Math.round(process.memoryUsage().rss / 1048576), uptimeSec: Math.round((Date.now() - stats.started) / 1000) });
    res.writeHead(pool.browser ? 200 : 503, { 'content-type': 'application/json' }).end(body); return;
  }
  const route = { '/cover.png': 'cover', '/sheet.png': 'sheet', '/cover.jpg': 'cover', '/sheet.jpg': 'sheet' }[url.pathname];
  if (!route) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found'); return; }
  if (!authorized(req, q)) { res.writeHead(401, { 'content-type': 'text/plain' }).end('unauthorized'); return; }
  let p;
  try { p = normalizeParams(q); if (url.pathname.endsWith('.jpg')) p.format = 'jpeg'; } catch (e) { res.writeHead(e.status || 400, { 'content-type': 'text/plain' }).end(e.message); return; }
  const { a, layout } = viewModel(p);
  try {
    const buf = route === 'sheet' ? await renderSheet(p) : await renderCover(p);
    const etag = '"' + createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
    res.writeHead(200, { 'content-type': p.format === 'jpeg' ? 'image/jpeg' : 'image/png', 'content-length': buf.length, 'cache-control': 'public, max-age=31536000, immutable', etag,
      'x-cover-layout': layout, 'x-cover-ink': a.ink1, 'x-cover-cat': a.cat });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch (e) {
    stats.errors++; console.error('render failed:', e.message);
    res.writeHead(500, { 'content-type': 'text/plain' }).end('render failed');
  }
}

export async function start({ port = CONFIG.port, host = CONFIG.host } = {}) {
  await fs.mkdir(cacheDir(), { recursive: true });
  await pool.launch();
  const server = http.createServer((req, res) => { handle(req, res).catch(e => { console.error(e); try { res.writeHead(500).end(); } catch { /* */ } }); });
  await new Promise((res, rej) => server.once('error', rej).listen(port, host, res));
  const addr = server.address();
  console.log(`cover-forge listening on ${host}:${addr.port} (pages=${CONFIG.pages}, cache=${cacheDir()}, token=${CONFIG.token ? 'set' : 'none'})`);
  return { server, port: addr.port, close: async () => { await new Promise(r => server.close(r)); await pool.close(); } };
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  const s = await start();
  const stop = async () => { await s.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
