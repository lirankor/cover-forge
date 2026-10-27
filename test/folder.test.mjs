// Unit tests for the folder backfill decisions (lib/folder.js) + ledger helpers. No Chromium, no Jellyfin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapJellyfinPath, isInside, existingCovers, decideFolder, decideRevert } from '../lib/folder.js';
import { loadLedger, saveLedger, metaHash, sha256 } from '../lib/backfill-common.js';

const cfg = { prefix: '/media/library/music', root: '/music' };

test('path mapping: prefix is replaced by MUSIC_ROOT', () => {
  assert.deepEqual(mapJellyfinPath('/media/library/music/Music/Artist/Album', cfg), { ok: true, target: '/music/Music/Artist/Album', rel: 'Music/Artist/Album' });
  assert.equal(mapJellyfinPath('/media/library/music/Hebrew/אמן/אלבום/', cfg).target, '/music/Hebrew/אמן/אלבום');
  assert.equal(mapJellyfinPath('/media/library/music/A/B', { prefix: '/media/library/music/', root: '/music/' }).target, '/music/A/B');
  assert.equal(mapJellyfinPath('/music/A/B', { prefix: '/music', root: '/music' }).target, '/music/A/B');       // identity
  assert.equal(mapJellyfinPath('/srvx/A/B', { prefix: '/', root: '/music' }).target, '/music/srvx/A/B');         // root prefix
  assert.equal(mapJellyfinPath('/media/library/music/A/..B (live)', cfg).target, '/music/A/..B (live)');       // ".." inside a name is fine
});

test('path mapping refuses paths outside the prefix, traversal and the root itself', () => {
  for (const bad of [
    '/media/library/musicals/A/B',            // prefix must match a whole path segment
    '/other/A/B',
    '/media/library/music/../secret/A',
    '/media/library/music/A/../../../etc',
    '/media/library/music',
    '/media/library/music/',
    '',
    undefined,
  ]) {
    const r = mapJellyfinPath(bad, cfg);
    assert.equal(r.ok, false, String(bad)); assert.ok(r.error);
  }
  assert.equal(mapJellyfinPath('/m/A', { prefix: 'relative', root: '/music' }).ok, false);
});

test('isInside', () => {
  assert.ok(isInside('/music/A', '/music'));
  assert.ok(!isInside('/music', '/music'));
  assert.ok(!isInside('/musicx/A', '/music'));
  assert.ok(!isInside('/etc', '/music'));
});

test('never overwrite: any folder/cover/front/album image counts as a real cover', () => {
  assert.deepEqual(existingCovers(['01 - Song.flac', 'Folder.JPG', 'cover.png', 'front.jpeg', 'album.gif', 'back.jpg', 'folder.txt', 'cover.webp']),
    ['Folder.JPG', 'cover.png', 'front.jpeg', 'album.gif', 'cover.webp']);
  assert.deepEqual(existingCovers(['01.flac', 'scan-cover.jpg', 'folder.jpg.bak']), []);
  assert.deepEqual(decideFolder({ covers: ['cover.jpg'] }), { action: 'skip', reason: 'existing-cover' });
  assert.deepEqual(decideFolder({ covers: [] }), { action: 'write', reason: 'new' });
});

test('ledger: items are skipped unless --refresh; refresh only rewrites our own file', () => {
  const led = { path: '/music/A/B/folder.jpg', sha256: 'aaa' };
  assert.deepEqual(decideFolder({ led, covers: ['folder.jpg'], diskSha: 'aaa' }), { action: 'skip', reason: 'in-ledger' });
  assert.deepEqual(decideFolder({ led, refresh: true, covers: ['folder.jpg'], diskSha: 'aaa' }), { action: 'write', reason: 'refresh-ours' });
  assert.deepEqual(decideFolder({ led, refresh: true, covers: ['folder.jpg'], diskSha: 'bbb' }), { action: 'skip', reason: 'changed' });
  assert.deepEqual(decideFolder({ led, refresh: true, covers: ['folder.jpg'], diskSha: 'not-a-file' }), { action: 'skip', reason: 'changed' });
  // our file was deleted: rewritten only if no other cover appeared
  assert.deepEqual(decideFolder({ led, refresh: true, covers: [], diskSha: null }), { action: 'write', reason: 'rewrite-gone' });
  assert.deepEqual(decideFolder({ led, refresh: true, covers: ['cover.png'], diskSha: null }), { action: 'skip', reason: 'existing-cover' });
});

test('revert deletes only byte-identical files', () => {
  const led = { sha256: 'aaa' };
  assert.equal(decideRevert(led, 'aaa'), 'delete');
  assert.equal(decideRevert(led, 'bbb'), 'kept');
  assert.equal(decideRevert(led, 'not-a-file'), 'kept');
  assert.equal(decideRevert(led, null), 'gone');
});

test('ledger load/save is atomic and tolerates a missing file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cover-forge-ledger-'));
  const f = path.join(dir, 'sub', 'ledger-folder.json');
  assert.deepEqual(await loadLedger(f), { version: 1, items: {} });
  await saveLedger(f, { version: 1, items: { x: { path: '/music/a/folder.jpg', sha256: sha256('x') } } });
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).items.x.sha256, sha256('x'));
  assert.deepEqual(readdirSync(path.dirname(f)), ['ledger-folder.json'], 'no temp file left behind');
  assert.equal((await loadLedger(f)).items.x.path, '/music/a/folder.jpg');
});

test('metaHash matches the Jellyfin backfill hash (same metadata/size/seed → same cover)', () => {
  const meta = { artist: 'A', title: 'B', year: '1970', label: '' };
  assert.equal(metaHash(meta, 1000, 0), metaHash({ ...meta }, 1000, 0));
  assert.notEqual(metaHash(meta, 1000, 0), metaHash(meta, 1000, 1));
  assert.match(metaHash(meta, 1000, 0), /^[0-9a-f]{16}$/);
});
