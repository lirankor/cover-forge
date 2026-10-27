// Renders one Latin and one Hebrew cover per layout (+ one contact sheet) through the HTTP API and
// checks the PNG dimensions. Needs Chromium → run inside the image: `docker compose run --rm cover-forge npm test`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), 'cover-forge-test-'));
process.env.TOKEN = 'test-token';
const { start } = await import('../server.js');
const { LAYOUTS, SHEET_W, SHEET_H, build, hash } = await import('../lib/design.js');

let srv, base;
before(async () => { srv = await start({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${srv.port}`; });
after(async () => { await srv.close(); });

function pngSize(buf) {
  assert.equal(buf.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
const get = (p, h = {}) => fetch(base + p, { headers: { authorization: 'Bearer test-token', ...h } });

test('design hash + palette are the Claude Design values', () => {
  assert.equal(hash('a|b'), hash('a|b'));
  const a = build({ artist: 'The Velvet Lowlands', title: 'Summer Static', year: '1974', label: 'Harbor Records' }, 0);
  assert.match(a.ink1, /^#[0-9A-F]{6}$/);
  assert.notEqual(a.ink1, a.ink2); assert.notEqual(a.ink2, a.ink3); assert.notEqual(a.ink1, a.ink3);
  assert.equal(a.yearShort, "'74"); assert.match(a.cat, /^NC-\d{4}$/);
  assert.equal(a.titleSize, '34px'); // 13 chars → mid
  assert.ok(LAYOUTS.includes(a.layout));
  const noYear = build({ artist: 'X', title: 'No Year' }, 0);
  assert.equal(noYear.hasYear, false); assert.notEqual(noYear.layout, '1b', 'no year → 1b is never auto-picked');
  for (let seed = 0; seed < 50; seed++) assert.notEqual(build({ artist: 'X', title: 'Seed ' + seed }).layout, '1b');
  const b = build({ artist: 'The Velvet Lowlands', title: 'Summer Static' }, 3);
  assert.ok(b.ink1 !== a.ink1 || b.paper !== a.paper || b.layout !== a.layout, 'seed changes something');
});

const samples = [
  { name: 'latin', artist: 'The Velvet Lowlands', title: 'Summer Static', year: '1974', label: 'Harbor Records' },
  { name: 'hebrew', artist: 'שלמה ארצי', title: 'חום יולי אוגוסט', year: '1988', label: 'הד ארצי' },
  { name: 'long', artist: 'Night Ferry', title: 'Songs for the Long Drive Home and Other Stories of the Road', year: '1982', label: 'Kestrel' },
];
for (const l of LAYOUTS) for (const s of samples) {
  test(`cover ${l} ${s.name} renders 400x400`, async () => {
    const q = new URLSearchParams({ artist: s.artist, title: s.title, year: s.year, label: s.label, layout: l, size: '400' });
    const r = await get('/cover.png?' + q);
    assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
    assert.equal(r.headers.get('x-cover-layout'), l);
    const buf = Buffer.from(await r.arrayBuffer());
    assert.deepEqual(pngSize(buf), { w: 400, h: 400 });
  });
}

test('default size, determinism and cache', async () => {
  const q = 'artist=Marisol+Ortega&title=Blue&year=1969&label=Cinder+Sound';
  const a = Buffer.from(await (await get('/cover.png?' + q)).arrayBuffer());
  const b = Buffer.from(await (await get('/cover.png?' + q)).arrayBuffer());
  assert.deepEqual(pngSize(a), { w: 1000, h: 1000 });
  assert.ok(a.equals(b), 'same params → same bytes');
  const h = await (await get('/healthz')).json();
  assert.ok(h.ok && h.cacheHits >= 1);
});

test('format=jpeg (and /cover.jpg) returns the same cover as a JPEG', async () => {
  const q = 'artist=Marisol+Ortega&title=Blue&year=1969&label=Cinder+Sound&size=400';
  const r = await get('/cover.png?' + q + '&format=jpeg');
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/jpeg');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 3).toString('hex'), 'ffd8ff', 'JPEG signature');
  const png = await get('/cover.png?' + q);
  assert.equal(png.headers.get('content-type'), 'image/png');
  assert.equal(png.headers.get('x-cover-layout'), r.headers.get('x-cover-layout'));
  const r2 = await get('/cover.jpg?' + q);
  assert.equal(r2.headers.get('content-type'), 'image/jpeg');
  assert.ok(Buffer.from(await r2.arrayBuffer()).equals(buf), 'cached JPEG is byte-identical');
});

test('sheet keeps the 2x2 aspect at the requested width', async () => {
  const r = await get('/sheet.png?artist=Okonkwo+Trio&title=Lagos+After+Dark&year=1977&label=Palm+Wine+Recs&size=712');
  assert.equal(r.status, 200);
  assert.deepEqual(pngSize(Buffer.from(await r.arrayBuffer())), { w: SHEET_W, h: SHEET_H });
});

test('auth + validation', async () => {
  assert.equal((await fetch(base + '/cover.png?title=x')).status, 401);
  assert.equal((await fetch(base + '/cover.png?title=x&token=test-token&size=64')).status, 200);
  assert.equal((await get('/cover.png?title=x&layout=9z')).status, 400);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.equal((await get('/nope')).status, 404);
});
