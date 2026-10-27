#!/usr/bin/env node
// Folder backfill: write the placeholder cover of every album in the Jellyfin backfill ledger as folder.jpg into
// the album's folder on disk, so file-based players (e.g. Music Assistant's filesystem provider) show the SAME art
// as Jellyfin. Dry-run by default.
//
//   node bin/backfill-folder.mjs [--dry-run|--apply] [--limit N] [--refresh] [--out DIR] [--ledger PATH]
//                                [--jf-ledger PATH] [--size N] [--seed N]
//   node bin/backfill-folder.mjs --revert [--apply]
//
// Env: JELLYFIN_URL, JELLYFIN_API_KEY, [JELLYFIN_USER_ID], [COVER_FORGE_URL=http://127.0.0.1:8793],
//      [COVER_FORGE_TOKEN | TOKEN], [LEDGER=/data/ledger.json] (the Jellyfin backfill ledger, read only),
//      [LEDGER_FOLDER=/data/ledger-folder.json], [JELLYFIN_MUSIC_PREFIX=/music] (album paths as Jellyfin reports them),
//      [MUSIC_ROOT=/music] (the same tree as mounted here)
//
// Safety rules:
//   * a folder that already has any folder.*, cover.*, front.* or album.* image is never touched
//   * a Jellyfin path outside JELLYFIN_MUSIC_PREFIX, or one that would resolve outside MUSIC_ROOT, is refused
//   * every write is recorded in the folder ledger {path, sha256, hash, layout, writtenAt}; ledger items are skipped
//     unless --refresh, which rewrites only files whose sha256 still matches the ledger (still ours)
//   * --apply never replaces an existing file except our own on --refresh (hard link from a temp file = no race)
//   * --dry-run (default) writes the JPEGs to --out (default /data/backfill-folder-dry/) and nothing into the music tree
//   * --revert deletes folder.jpg only where its sha256 still matches the ledger; changed files are kept
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createJellyfin, createForge, loadLedger, saveLedger, metaForItem, metaHash, metaLabel, sha256 } from '../lib/backfill-common.js';
import { COVER_FILE, mapJellyfinPath, isInside, existingCovers, decideFolder, decideRevert } from '../lib/folder.js';

const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const APPLY = flag('--apply') && !flag('--dry-run');
const LIMIT = Number(opt('--limit', 0)) || 0;
const REFRESH = flag('--refresh');
const REVERT = flag('--revert');
const OUT = opt('--out', '/data/backfill-folder-dry');
const SIZE = Number(opt('--size', 1000)) || 1000;
const SEED = Number(opt('--seed', 0)) || 0;
const LEDGER = opt('--ledger', process.env.LEDGER_FOLDER || '/data/ledger-folder.json');
const JF_LEDGER = opt('--jf-ledger', process.env.LEDGER || '/data/ledger.json');
const PREFIX = process.env.JELLYFIN_MUSIC_PREFIX || '/music';
const ROOT = path.posix.resolve(process.env.MUSIC_ROOT || '/music');
const MAX_DETAIL = 10;   // per-item lines printed for the noisy categories (unmapped / missing-dir)

async function readSha(file) {
  try {
    const st = await fs.lstat(file);
    if (!st.isFile()) return 'not-a-file';           // symlink/dir named folder.jpg: never ours
    return sha256(await fs.readFile(file));
  } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function realRoot() { try { return await fs.realpath(ROOT); } catch { return null; } }

const ledger = await loadLedger(LEDGER);

// ---------- revert ----------
if (REVERT) {
  const entries = Object.entries(ledger.items);
  const todo = LIMIT ? entries.slice(0, LIMIT) : entries;
  const n = { deleted: 0, kept: 0, gone: 0, refused: 0, failed: 0 };
  console.log(`${APPLY ? 'REVERT' : 'REVERT DRY-RUN'}: ${entries.length} folder-ledger entries${LIMIT ? `, limit ${LIMIT}` : ''}`);
  for (const [id, led] of todo) {
    try {
      if (path.posix.basename(led.path) !== COVER_FILE || !isInside(path.posix.resolve(led.path), ROOT)) {
        console.log(`  refuse    ${id}  ${led.path} (not a ${COVER_FILE} inside MUSIC_ROOT ${ROOT})`); n.refused++; continue;
      }
      const d = decideRevert(led, await readSha(led.path));
      if (d === 'gone') { console.log(`  gone      ${id}  ${led.path}`); n.gone++; if (APPLY) { delete ledger.items[id]; await saveLedger(LEDGER, ledger); } continue; }
      if (d === 'kept') { console.log(`  kept (changed) ${id}  ${led.path}`); n.kept++; continue; }
      if (!APPLY) { console.log(`  would delete ${id}  ${led.path}`); n.deleted++; continue; }
      await fs.unlink(led.path);
      delete ledger.items[id]; await saveLedger(LEDGER, ledger);
      console.log(`  deleted   ${id}  ${led.path}`); n.deleted++;
    } catch (e) { n.failed++; console.error(`  FAILED ${id} ${led.path}: ${e.message}`); }
  }
  console.log(`${APPLY ? 'deleted' : 'would delete'} ${n.deleted}, kept (changed) ${n.kept}, gone ${n.gone}, refused ${n.refused}, failed ${n.failed}, ledger now ${Object.keys(ledger.items).length} items`);
  process.exit(n.failed ? 1 : 0);
}

// ---------- plan ----------
const client = createJellyfin({ url: process.env.JELLYFIN_URL, key: process.env.JELLYFIN_API_KEY, user: process.env.JELLYFIN_USER_ID || '' });
if (!client.configured) { console.error('JELLYFIN_URL and JELLYFIN_API_KEY are required'); process.exit(2); }
const forge = createForge({ url: process.env.COVER_FORGE_URL, token: process.env.COVER_FORGE_TOKEN || process.env.TOKEN || '', size: SIZE, seed: SEED, format: 'jpeg' });

const jfLedger = await loadLedger(JF_LEDGER);
const albumIds = Object.values(jfLedger.items).filter(e => (e.type || 'MusicAlbum') === 'MusicAlbum').map(e => e.itemId);
const items = await client.getItems(albumIds, 'Path');
const root = await realRoot();

const count = { ledger: albumIds.length, planned: 0, 'skipped-existing-cover': 0, 'skipped-in-ledger': 0, 'skipped-changed': 0, 'unmapped-path': 0, 'missing-dir': 0, 'gone-from-jellyfin': 0, 'meta-drift': 0 };
const detail = { 'unmapped-path': 0, 'missing-dir': 0, 'meta-drift': 0 };
const say = (cat, line) => { if (!(cat in detail) || detail[cat]++ < MAX_DETAIL) console.log(line); };
const plan = [];
for (const id of albumIds) {
  const it = items.get(id);
  if (!it) { count['gone-from-jellyfin']++; console.log(`  gone      ${id} (not in Jellyfin any more)`); continue; }
  const meta = metaForItem(it);
  const hash = metaHash(meta, SIZE, SEED);
  const name = metaLabel(it, meta);
  const drift = jfLedger.items[id]?.hash !== hash;
  if (drift) { count['meta-drift']++; say('meta-drift', `  meta-drift ${id}  ${name} (differs from the Jellyfin upload; run backfill-jellyfin --refresh first for identical art)`); }
  const m = mapJellyfinPath(it.Path, { prefix: PREFIX, root: ROOT });
  if (!m.ok) { count['unmapped-path']++; say('unmapped-path', `  unmapped  ${id}  ${name}: ${m.error}`); continue; }
  const file = path.posix.join(m.target, COVER_FILE);
  const entry = { id, it, meta, hash, name, drift, dir: m.target, file };
  let st = null, real = null;
  try { st = await fs.stat(m.target); real = await fs.realpath(m.target); } catch { /* missing */ }
  if (!st || !st.isDirectory() || !root || !isInside(real, root)) {
    count['missing-dir']++;
    say('missing-dir', `  missing-dir ${id}  ${m.target}${st && !st.isDirectory() ? ' (not a directory)' : real && root && !isInside(real, root) ? ' (resolves outside MUSIC_ROOT)' : ''}`);
    plan.push({ ...entry, reason: 'missing-dir' });
    continue;
  }
  const covers = existingCovers(await fs.readdir(m.target));
  const led = ledger.items[id];
  const diskSha = await readSha(file);
  const d = decideFolder({ led, refresh: REFRESH, covers, diskSha: diskSha === 'not-a-file' ? 'not-a-file' : diskSha });
  if (d.action === 'skip') {
    if (d.reason === 'in-ledger') { count['skipped-in-ledger']++; continue; }
    if (d.reason === 'changed') { count['skipped-changed']++; console.log(`  kept (changed) ${id}  ${file}`); continue; }
    count['skipped-existing-cover']++; console.log(`  has cover ${id}  ${m.target}  [${covers.join(', ')}] → skipped`); continue;
  }
  count.planned++;
  plan.push({ ...entry, reason: d.reason, led });
}
for (const c of Object.keys(detail)) if (detail[c] > MAX_DETAIL) console.log(`  … ${detail[c] - MAX_DETAIL} more ${c}`);

// dry-run also renders the missing-dir items (so a plan can be checked before the tree is mounted); apply never does
const renderable = plan.filter(p => p.reason !== 'missing-dir' || !APPLY);
const todo = LIMIT ? renderable.slice(0, LIMIT) : renderable;
console.log(`${APPLY ? 'APPLY' : 'DRY-RUN'}: ${count.ledger} ledger albums → planned ${count.planned}, skipped-existing-cover ${count['skipped-existing-cover']}, skipped-in-ledger ${count['skipped-in-ledger']}, skipped-changed ${count['skipped-changed']}, unmapped-path ${count['unmapped-path']}, missing-dir ${count['missing-dir']}, gone-from-jellyfin ${count['gone-from-jellyfin']} (meta changed since the Jellyfin upload: ${count['meta-drift']})${LIMIT ? `; limit ${LIMIT}` : ''}`);
console.log(`  prefix ${PREFIX} → MUSIC_ROOT ${ROOT}${root ? '' : ' (does not exist here)'}; ledger ${LEDGER}`);
if (!APPLY) await fs.mkdir(OUT, { recursive: true });

let done = 0, failed = 0, unchanged = 0;
for (const p of todo) {
  const tag = `${p.reason.padEnd(12)} ${p.id}`;
  try {
    const { buf, layout } = await forge(p.meta);
    const sha = sha256(buf);
    if (!APPLY) {
      const f = path.join(OUT, `${p.id}.jpg`); await fs.writeFile(f, buf);
      console.log(`  would write ${tag}  layout=${layout}${p.drift ? ' (meta drift)' : ''}  ${p.name}\n      → ${p.file}   [preview ${f}]`);
      done++; continue;
    }
    if (p.reason === 'refresh-ours' && sha === p.led.sha256) { unchanged++; continue; }
    const tmp = path.posix.join(p.dir, `.${COVER_FILE}.cover-forge.${process.pid}.tmp`);
    await fs.writeFile(tmp, buf, { mode: 0o644, flag: 'wx' });
    try {
      if (p.reason === 'refresh-ours') {
        if ((await readSha(p.file)) !== p.led.sha256) throw new Error(`${COVER_FILE} changed since planning, kept`);
        await fs.rename(tmp, p.file);
      } else {
        await fs.link(tmp, p.file);       // fails with EEXIST instead of overwriting anything
      }
    } finally { await fs.unlink(tmp).catch(() => {}); }
    ledger.items[p.id] = { path: p.file, sha256: sha, hash: p.hash, layout, name: p.name, writtenAt: new Date().toISOString() };
    await saveLedger(LEDGER, ledger);
    console.log(`  wrote ${tag}  layout=${layout}  ${p.file}`);
    done++;
  } catch (e) { failed++; console.error(`  FAILED ${p.id} ${p.file}: ${e.code === 'EEXIST' ? 'a ' + COVER_FILE + ' appeared meanwhile, kept' : e.message}`); }
}
console.log(`${APPLY ? 'wrote' : 'rendered'} ${done}${unchanged ? `, unchanged ${unchanged}` : ''}, failed ${failed}${APPLY ? `, ledger ${LEDGER} (${Object.keys(ledger.items).length} items)` : `, JPEGs in ${OUT}`}`);
process.exit(failed ? 1 : 0);
