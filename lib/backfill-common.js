// Helpers shared by the backfill scripts (bin/backfill-jellyfin.mjs, bin/backfill-folder.mjs):
// Jellyfin client, cover metadata from a Jellyfin item, metadata hash, JSON ledgers, cover-forge HTTP client.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeTitle } from './normalize.js';

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

// ---------- Jellyfin ----------
export function createJellyfin({ url, key, user = '' }) {
  const base = String(url || '').replace(/\/+$/, '');
  const headers = { Authorization: `MediaBrowser Token="${key}", Client="cover-forge", Device="cover-forge", DeviceId="cover-forge-backfill", Version="1.0"` };
  async function jf(p, init = {}) {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(60_000), ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!r.ok) throw new Error(`Jellyfin ${init.method || 'GET'} ${p} → ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
    return r;
  }
  const FIELDS = 'Studios,ProductionYear,ImageTags,AlbumArtist,AlbumArtists,Artists';
  async function listItems(type, extraFields = '') {
    const q = new URLSearchParams({ IncludeItemTypes: type, Recursive: 'true', Fields: FIELDS + (extraFields ? ',' + extraFields : ''), SortBy: 'SortName', SortOrder: 'Ascending', EnableImages: 'true' });
    if (user) q.set('userId', user);
    const { Items = [] } = await (await jf('/Items?' + q)).json();
    return Items;
  }
  // Fetch items by id in batches; returns Map(id → item). Ids Jellyfin no longer knows are simply absent.
  async function getItems(ids, extraFields = '', batch = 100) {
    const out = new Map();
    for (let i = 0; i < ids.length; i += batch) {
      const q = new URLSearchParams({ Ids: ids.slice(i, i + batch).join(','), Fields: FIELDS + (extraFields ? ',' + extraFields : ''), EnableImages: 'true' });
      if (user) q.set('userId', user);
      const { Items = [] } = await (await jf('/Items?' + q)).json();
      for (const it of Items) out.set(it.Id, it);
    }
    return out;
  }
  const getItem = async id => (await jf(`/Items/${id}?${user ? 'userId=' + user : ''}`)).json();
  return { jf, listItems, getItems, getItem, configured: !!(base && key) };
}

// ---------- cover metadata ----------
// Cover metadata for a Jellyfin item. Folder-derived album names are cleaned (lib/normalize.js); `log` gets the change.
export function metaForItem(it, log = () => {}) {
  if (it.Type === 'MusicArtist') return { artist: '', title: it.Name || '', year: it.ProductionYear ? String(it.ProductionYear) : '', label: '' };
  const n = normalizeTitle(it.Name || '', it.ProductionYear ? String(it.ProductionYear) : '');
  if (n.changed) log(`  title ${JSON.stringify(it.Name)} → ${JSON.stringify(n.title)}${n.year && !it.ProductionYear ? ' (year ' + n.year + ')' : ''}`);
  return {
    artist: it.AlbumArtist || it.AlbumArtists?.[0]?.Name || it.Artists?.[0] || '',
    title: n.title,
    year: n.year,
    label: it.Studios?.[0]?.Name || '',
  };
}
// The ledger "hash": identifies the rendered cover (metadata + size + seed), independent of the image format.
export const metaHash = (meta, size, seed) => createHash('sha256').update(JSON.stringify([meta, size, seed])).digest('hex').slice(0, 16);
export const metaLabel = (it, meta) =>
  `${it.Type === 'MusicArtist' ? '[artist] ' : ''}${meta.artist ? meta.artist + ' — ' : ''}${meta.title}${meta.year ? ' (' + meta.year + ')' : ''}${meta.label ? ' · ' + meta.label : ''}`;

// ---------- ledgers ----------
export async function loadLedger(file) {
  try { const l = JSON.parse(await fs.readFile(file, 'utf8')); return l.items ? l : { version: 1, items: {} }; }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, items: {} }; throw new Error(`cannot read ledger ${file}: ${e.message}`); }
}
// Atomic: temp file in the same directory + rename.
export async function saveLedger(file, l) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(l, null, 1)); await fs.rename(tmp, file);
}

// ---------- cover-forge HTTP client ----------
export function createForge({ url, token = '', size = 1000, seed = 0, format = 'png' } = {}) {
  const base = (url || 'http://127.0.0.1:8793').replace(/\/+$/, '');
  const want = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  return async function forge(meta, attempt = 1) {
    const q = new URLSearchParams({ ...meta, size: String(size), seed: String(seed) });
    if (format === 'jpeg') q.set('format', 'jpeg');
    const r = await fetch(`${base}/cover.png?${q}`, { headers: token ? { authorization: 'Bearer ' + token } : {}, signal: AbortSignal.timeout(90_000) }).catch(e => ({ ok: false, status: e.name }));
    if (!r.ok) {
      if (attempt < 3) { console.warn(`  cover-forge → ${r.status}, retry ${attempt}/2 in 5 s`); await new Promise(res => setTimeout(res, 5000)); return forge(meta, attempt + 1); }
      throw new Error(`cover-forge → ${r.status}`);
    }
    const type = (r.headers.get('content-type') || '').split(';')[0];
    if (type !== want) throw new Error(`cover-forge returned ${type || 'no content-type'}, expected ${want} (server too old for format=${format}? rebuild the image)`);
    const buf = Buffer.from(await r.arrayBuffer());
    return { buf, png: buf, layout: r.headers.get('x-cover-layout') };
  };
}
