#!/usr/bin/env node
// Jellyfin backfill: give every MusicAlbum (and, with --artists, MusicArtist) that has NO primary image a
// generated placeholder cover. Dry-run by default.
//
//   node bin/backfill-jellyfin.mjs [--dry-run|--apply] [--limit N] [--refresh] [--artists] [--out DIR]
//                                  [--ledger PATH] [--size N] [--seed N]
//
// Env: JELLYFIN_URL, JELLYFIN_API_KEY, [JELLYFIN_USER_ID], [COVER_FORGE_URL=http://127.0.0.1:8793],
//      [COVER_FORGE_TOKEN | TOKEN], [LEDGER=/data/ledger.json]
//
// Safety rules:
//   * an item that HAS a primary image is never touched — unless --refresh AND the image is the one this
//     script uploaded (its Jellyfin image tag is in the ledger); a real cover added later is never overwritten
//   * every upload is recorded in the ledger {itemId, type, hash, jfTag, uploadedAt}; ledger items are skipped
//     on later runs unless --refresh
//   * --dry-run (default) only prints the plan and writes the PNGs to --out (default ./backfill-out)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const APPLY = flag('--apply') && !flag('--dry-run');
const LIMIT = Number(opt('--limit', 0)) || 0;
const REFRESH = flag('--refresh');
const ARTISTS = flag('--artists');
const OUT = opt('--out', 'backfill-out');
const SIZE = Number(opt('--size', 1000)) || 1000;
const SEED = Number(opt('--seed', 0)) || 0;
const LEDGER = opt('--ledger', process.env.LEDGER || '/data/ledger.json');
const JF = (process.env.JELLYFIN_URL || '').replace(/\/+$/, '');
const KEY = process.env.JELLYFIN_API_KEY || '';
const USER = process.env.JELLYFIN_USER_ID || '';
const FORGE = (process.env.COVER_FORGE_URL || 'http://127.0.0.1:8793').replace(/\/+$/, '');
const FORGE_TOKEN = process.env.COVER_FORGE_TOKEN || process.env.TOKEN || '';
if (!JF || !KEY) { console.error('JELLYFIN_URL and JELLYFIN_API_KEY are required'); process.exit(2); }

const jfHeaders = { Authorization: `MediaBrowser Token="${KEY}", Client="cover-forge", Device="cover-forge", DeviceId="cover-forge-backfill", Version="1.0"` };
async function jf(p, init = {}) {
  const r = await fetch(JF + p, { ...init, headers: { ...jfHeaders, ...(init.headers || {}) } });
  if (!r.ok) throw new Error(`Jellyfin ${init.method || 'GET'} ${p} → ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
  return r;
}
async function listItems(type) {
  const q = new URLSearchParams({ IncludeItemTypes: type, Recursive: 'true', Fields: 'Studios,ProductionYear,ImageTags,AlbumArtist,AlbumArtists,Artists', SortBy: 'SortName', SortOrder: 'Ascending', EnableImages: 'true' });
  if (USER) q.set('userId', USER);
  const { Items = [] } = await (await jf('/Items?' + q)).json();
  return Items;
}
const hasPrimary = it => !!(it.ImageTags && it.ImageTags.Primary);
function metaFor(it) {
  if (it.Type === 'MusicArtist') return { artist: '', title: it.Name || '', year: it.ProductionYear ? String(it.ProductionYear) : '', label: '' };
  return {
    artist: it.AlbumArtist || it.AlbumArtists?.[0]?.Name || it.Artists?.[0] || '',
    title: it.Name || '',
    year: it.ProductionYear ? String(it.ProductionYear) : '',
    label: it.Studios?.[0]?.Name || '',
  };
}
async function loadLedger() {
  try { const l = JSON.parse(await fs.readFile(LEDGER, 'utf8')); return l.items ? l : { version: 1, items: {} }; }
  catch { return { version: 1, items: {} }; }
}
async function saveLedger(l) {
  await fs.mkdir(path.dirname(LEDGER), { recursive: true });
  const tmp = LEDGER + '.tmp'; await fs.writeFile(tmp, JSON.stringify(l, null, 1)); await fs.rename(tmp, LEDGER);
}
async function forge(meta) {
  const q = new URLSearchParams({ ...meta, size: String(SIZE), seed: String(SEED) });
  const r = await fetch(`${FORGE}/cover.png?${q}`, { headers: FORGE_TOKEN ? { authorization: 'Bearer ' + FORGE_TOKEN } : {} });
  if (!r.ok) throw new Error(`cover-forge → ${r.status}`);
  return { png: Buffer.from(await r.arrayBuffer()), layout: r.headers.get('x-cover-layout') };
}

const ledger = await loadLedger();
const types = ARTISTS ? ['MusicAlbum', 'MusicArtist'] : ['MusicAlbum'];
const summary = { listed: 0, withImage: 0, noImage: 0, inLedger: 0, ours: 0, candidates: 0, done: 0, failed: 0 };
const plan = [];
for (const type of types) {
  const items = await listItems(type);
  summary.listed += items.length;
  for (const it of items) {
    const led = ledger.items[it.Id];
    if (hasPrimary(it)) {
      summary.withImage++;
      // ours (tag matches what we recorded) → refreshable; anything else is a real cover → never touched
      if (REFRESH && led && led.jfTag && led.jfTag === it.ImageTags.Primary) { summary.ours++; plan.push({ it, reason: 'refresh-ours' }); }
      continue;
    }
    summary.noImage++;
    if (led && !REFRESH) { summary.inLedger++; continue; }
    plan.push({ it, reason: led ? 'refresh' : 'new' });
  }
}
summary.candidates = plan.length;
const todo = LIMIT ? plan.slice(0, LIMIT) : plan;
console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: ${summary.listed} items listed (${types.join('+')}), ${summary.withImage} have a primary image, ${summary.noImage} have none, ${summary.inLedger} already in ledger (skipped), ${summary.ours} ours refreshable, ${summary.candidates} candidates${LIMIT ? `, limit ${LIMIT}` : ''}`);
if (!APPLY) await fs.mkdir(OUT, { recursive: true });

for (const { it, reason } of todo) {
  const meta = metaFor(it);
  const hash = createHash('sha256').update(JSON.stringify([meta, SIZE, SEED])).digest('hex').slice(0, 16);
  const label = `${it.Type === 'MusicArtist' ? '[artist] ' : ''}${meta.artist ? meta.artist + ' — ' : ''}${meta.title}${meta.year ? ' (' + meta.year + ')' : ''}${meta.label ? ' · ' + meta.label : ''}`;
  try {
    const { png, layout } = await forge(meta);
    if (!APPLY) {
      const f = path.join(OUT, `${it.Id}.png`); await fs.writeFile(f, png);
      console.log(`  would upload ${reason.padEnd(12)} ${it.Id}  layout=${layout}  ${label}  → ${f}`);
      summary.done++; continue;
    }
    await jf(`/Items/${it.Id}/Images/Primary`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png.toString('base64') });
    const fresh = await (await jf(`/Items/${it.Id}?${USER ? 'userId=' + USER : ''}`)).json().catch(() => ({}));
    ledger.items[it.Id] = { itemId: it.Id, type: it.Type, name: label, hash, layout, jfTag: fresh?.ImageTags?.Primary || null, uploadedAt: new Date().toISOString() };
    await saveLedger(ledger);
    console.log(`  uploaded ${reason.padEnd(12)} ${it.Id}  layout=${layout}  ${label}`);
    summary.done++;
  } catch (e) { summary.failed++; console.error(`  FAILED ${it.Id} ${label}: ${e.message}`); }
}
console.log(`${APPLY ? 'uploaded' : 'rendered'} ${summary.done}, failed ${summary.failed}${APPLY ? `, ledger ${LEDGER} (${Object.keys(ledger.items).length} items)` : `, PNGs in ${OUT}`}`);
process.exit(summary.failed ? 1 : 0);
