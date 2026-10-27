// Pure decision logic for bin/backfill-folder.mjs (writing placeholder covers as folder.jpg into album folders).
// No I/O here except where a function takes an fs-like argument, so everything is unit-testable.
import path from 'node:path';

export const COVER_FILE = 'folder.jpg';
// Anything a music server would pick up as album art; if one exists the folder is never touched.
export const COVER_RE = /^(?:folder|cover|front|album)\.(?:jpe?g|png|gif|webp|bmp|tiff?)$/i;

const stripSlash = p => (p.length > 1 ? p.replace(/\/+$/, '') : p);

// Map a path as Jellyfin reports it to the same directory as seen by this process.
//   mapJellyfinPath('/media/music/A/B', { prefix: '/media/music', root: '/music' }) → { ok: true, target: '/music/A/B', rel: 'A/B' }
// Refuses paths outside the prefix and anything that would resolve outside root (.., absolute tricks).
export function mapJellyfinPath(jfPath, { prefix, root }) {
  if (typeof jfPath !== 'string' || !jfPath) return { ok: false, error: 'no path' };
  const pre = stripSlash(path.posix.normalize(prefix));
  const rootN = stripSlash(path.posix.normalize(root));
  if (!path.posix.isAbsolute(pre) || !path.posix.isAbsolute(rootN)) return { ok: false, error: 'prefix and root must be absolute' };
  const p = jfPath.replace(/\\/g, '/');
  if (p.split('/').includes('..')) return { ok: false, error: `path contains "..": ${jfPath}` };
  if (p !== pre && !p.startsWith(pre === '/' ? '/' : pre + '/')) return { ok: false, error: `path is not under JELLYFIN_MUSIC_PREFIX ${pre}: ${jfPath}` };
  const rel = stripSlash(p.slice(pre === '/' ? 1 : pre.length).replace(/^\/+/, ''));
  if (!rel) return { ok: false, error: `path is the music root itself, not an album folder: ${jfPath}` };
  const target = path.posix.resolve(rootN, rel);
  if (!isInside(target, rootN)) return { ok: false, error: `path escapes MUSIC_ROOT: ${jfPath}` };
  return { ok: true, target, rel };
}

// true if `p` is strictly inside directory `root` (both absolute, normalised).
export function isInside(p, root) {
  const r = path.posix.relative(stripSlash(root), p);
  return !!r && !r.startsWith('..') && !path.posix.isAbsolute(r);
}

// Names in a directory listing that count as an existing cover.
export const existingCovers = names => names.filter(n => COVER_RE.test(n));

// What to do with one album folder.
//   led      — the folder-ledger entry for this item (or undefined)
//   covers   — existingCovers(listing of the folder)
//   diskSha  — sha256 of <folder>/folder.jpg if it exists, else null
// Returns { action: 'write'|'skip', reason }.
export function decideFolder({ led, refresh = false, covers = [], diskSha = null }) {
  if (led) {
    if (!refresh) return { action: 'skip', reason: 'in-ledger' };
    if (diskSha && diskSha === led.sha256) return { action: 'write', reason: 'refresh-ours' };
    if (diskSha) return { action: 'skip', reason: 'changed' };           // folder.jpg replaced by someone else
    // our file is gone: treat like a fresh folder (below), never overwriting another cover
  }
  if (covers.length) return { action: 'skip', reason: 'existing-cover' };
  return { action: 'write', reason: led ? 'rewrite-gone' : 'new' };
}

// Revert one folder-ledger entry: delete only if the file on disk is still byte-identical to what we wrote.
export function decideRevert(led, diskSha) {
  if (!diskSha) return 'gone';
  return diskSha === led.sha256 ? 'delete' : 'kept';
}
