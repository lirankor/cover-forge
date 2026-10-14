// Title normaliser for library-derived album names (used by the Jellyfin backfill only — the renderer stays literal).
// Strips folder-style junk around the real title; everything else (including mojibake) is left as-is.
//   normalizeTitle('(1968) Shine On Brightly', '1968') → { title: 'Shine On Brightly', year: '1968', changed: true }
//   normalizeTitle('2 - Greatest Hits II', '')         → { title: 'Greatest Hits II', year: '', changed: true }
//   normalizeTitle('1984', '1984')                     → { title: '1984', year: '1984', changed: false }
const YEAR = '((?:19|20)\\d{2})';
const LEAD_YEAR = new RegExp(`^(?:\\(${YEAR}\\)|\\[${YEAR}\\]|${YEAR}\\s*-)\\s+(?=\\S)`);
const TRAIL_YEAR = new RegExp(`(?<=\\S)\\s+(?:\\(${YEAR}\\)|\\[${YEAR}\\])$`);
const LEAD_NUM = /^\d{1,2}\s*(?:-|\.)\s+(?=\S)/;

export function normalizeTitle(title, year = '') {
  const orig = String(title ?? '');
  let t = orig.replace(/\s+/g, ' ').trim();
  let y = String(year ?? '').trim();
  // a year wrapper is only stripped if it IS the album's year (or there is no year yet → adopt it)
  const yearOk = found => !y || found === y;
  let m = t.match(LEAD_YEAR);
  if (m) { const found = m[1] || m[2] || m[3]; if (yearOk(found)) { t = t.slice(m[0].length); y = y || found; } }
  m = t.match(TRAIL_YEAR);
  if (m) { const found = m[1] || m[2]; if (yearOk(found)) { t = t.slice(0, t.length - m[0].length); y = y || found; } }
  t = t.replace(LEAD_NUM, '');          // disc/track-style "2 - " / "1. "
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) t = orig.trim();              // never return an empty title
  return { title: t, year: y, changed: t !== orig.trim() || y !== String(year ?? '').trim() };
}
