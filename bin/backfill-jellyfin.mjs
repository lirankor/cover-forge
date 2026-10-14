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
//   * --refresh re-renders ledger items whose metadata (after title normalisation) changed; --force re-uploads all of ours
//   * album names are cleaned by lib/normalize.js ("(1968) Shine On Brightly" → "Shine On Brightly"); the change is logged
//   * --revert undoes our uploads: DELETE /Items/{id}/Images/Primary only for ledger entries whose current primary
//     image tag is still the one we recorded (a real cover that replaced ours is kept); dry-run unless --apply
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeTitle } from '../lib/normalize.js';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const APPLY = flag('--apply') && !flag('--dry-run');
const LIMIT = Number(opt('--limit', 0)) || 0;
const REFRESH = flag('--refresh');
const REVERT = flag('--revert');
const FORCE = flag('--force');
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
const metaCache = new Map();
function metaFor(it) {
  if (metaCache.has(it.Id)) return metaCache.get(it.Id);
  const m = metaForUncached(it); metaCache.set(it.Id, m); return m;
}
function metaForUncached(it) {
  if (it.Type === 'MusicArtist') return { artist: '', title: it.Name || '', year: it.ProductionYear ? String(it.ProductionYear) : '', label: '' };
  // folder-derived names like "(1968) Shine On Brightly" / "2 - Greatest Hits II" → cleaned title (+ year if it had none)
  const n = normalizeTitle(it.Name || '', it.ProductionYear ? String(it.ProductionYear) : '');
  if (n.changed) console.log(`  title ${JSON.stringify(it.Name)} → ${JSON.stringify(n.title)}${n.year && !it.ProductionYear ? ' (year ' + n.year + ')' : ''}`);
  return {
    artist: it.AlbumArtist || it.AlbumArtists?.[0]?.Name || it.Artists?.[0] || '',
    title: n.title,
    year: n.year,
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
async function forge(meta, attempt = 1) {
  const q = new URLSearchParams({ ...meta, size: String(SIZE), seed: String(SEED) });
  const r = await fetch(`${FORGE}/cover.png?${q}`, { headers: FORGE_TOKEN ? { authorization: 'Bearer ' + FORGE_TOKEN } : {}, signal: AbortSignal.timeout(90_000) }).catch(e => ({ ok: false, status: e.name }));
  if (!r.ok) {
    if (attempt < 3) { console.warn(`  cover-forge → ${r.status}, retry ${attempt}/2 in 5 s`); await new Promise(res => setTimeout(res, 5000)); return forge(meta, attempt + 1); }
    throw new Error(`cover-forge → ${r.status}`);
  }
  return { png: Buffer.from(await r.arrayBuffer()), layout: r.headers.get('x-cover-layout') };
}

const ledger = await loadLedger();

if (REVERT) {
  const entries = Object.values(ledger.items);
  const todo = LIMIT ? entries.slice(0, LIMIT) : entries;
  let removed = 0, kept = 0, failed = 0;
  console.log(`${APPLY ? 'REVERT' : 'REVERT DRY-RUN'}: ${entries.length} ledger entries${LIMIT ? `, limit ${LIMIT}` : ''}`);
  for (const led of todo) {
    try {
      const cur = await (await jf(`/Items/${led.itemId}?${USER ? 'userId=' + USER : ''}`)).json();
      const tag = cur?.ImageTags?.Primary || null;
      if (!tag) { console.log(`  gone      ${led.itemId}  ${led.name} (no primary image any more)`); if (APPLY) { delete ledger.items[led.itemId]; await saveLedger(ledger); } removed++; continue; }
      if (tag !== led.jfTag) { console.log(`  keep      ${led.itemId}  ${led.name} (primary image is not ours any more)`); kept++; continue; }
      if (!APPLY) { console.log(`  would delete ${led.itemId}  ${led.name}`); removed++; continue; }
      await jf(`/Items/${led.itemId}/Images/Primary`, { method: 'DELETE' });
      delete ledger.items[led.itemId]; await saveLedger(ledger);
      console.log(`  deleted   ${led.itemId}  ${led.name}`); removed++;
    } catch (e) { failed++; console.error(`  FAILED ${led.itemId} ${led.name}: ${e.message}`); }
  }
  console.log(`${APPLY ? 'deleted' : 'would delete'} ${removed}, kept ${kept} (real covers), failed ${failed}, ledger now ${Object.keys(ledger.items).length} items`);
  process.exit(failed ? 1 : 0);
}

const types = ARTISTS ? ['MusicAlbum', 'MusicArtist'] : ['MusicAlbum'];
const summary = { listed: 0, withImage: 0, noImage: 0, inLedger: 0, ours: 0, unchanged: 0, candidates: 0, done: 0, failed: 0 };
const metaHash = meta => createHash('sha256').update(JSON.stringify([meta, SIZE, SEED])).digest('hex').slice(0, 16);
const plan = [];
for (const type of types) {
  const items = await listItems(type);
  summary.listed += items.length;
  for (const it of items) {
    const led = ledger.items[it.Id];
    if (hasPrimary(it)) {
      summary.withImage++;
      // ours (tag matches what we recorded) → refreshable; anything else is a real cover → never touched
      if (REFRESH && led && led.jfTag && led.jfTag === it.ImageTags.Primary) {
        summary.ours++;
        // same metadata → same cover: nothing to re-upload (unless --force)
        if (!FORCE && led.hash === metaHash(metaFor(it))) { summary.unchanged++; continue; }
        plan.push({ it, reason: 'refresh-ours' });
      }
      continue;
    }
    summary.noImage++;
    if (led && !REFRESH) { summary.inLedger++; continue; }
    plan.push({ it, reason: led ? 'refresh' : 'new' });
  }
}
summary.candidates = plan.length;
const todo = LIMIT ? plan.slice(0, LIMIT) : plan;
console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: ${summary.listed} items listed (${types.join('+')}), ${summary.withImage} have a primary image, ${summary.noImage} have none, ${summary.inLedger} already in ledger (skipped), ${summary.ours} ours refreshable (${summary.unchanged} unchanged → skipped), ${summary.candidates} candidates${LIMIT ? `, limit ${LIMIT}` : ''}`);
if (!APPLY) await fs.mkdir(OUT, { recursive: true });

for (const { it, reason } of todo) {
  const meta = metaFor(it);
  const hash = metaHash(meta);
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
