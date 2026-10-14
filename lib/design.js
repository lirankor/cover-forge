// Faithful port of the "Album Cover Placeholder" Claude Design file (build()/renderVals()).
// Everything that decides *what* a cover looks like lives here: the FNV-1a hash, the ink/paper
// palettes, title sizing, the grain SVG and the four layout templates (320x320 CSS px, as designed).
// Fonts: Heebo replaces Archivo Black / Archivo Narrow / IBM Plex Mono (owner decision, Hebrew+Latin);
// Alef replaces DM Serif Display. Both are bundled in the image (OFL).

export const LAYOUTS = ['1a', '1b', '1c', '1d'];
export const LAYOUT_NAMES = { '1a': 'Banner', '1b': 'Year stack', '1c': 'Twin suns', '1d': 'Press slug' };
export const INKS = ['#C65A45', '#D8A443', '#3F7F7B', '#3E5D8C', '#D88E86', '#6F8B57', '#8A5A86', '#E07B3C'];
export const PAPERS = ['#EFE7D6', '#F1E9DA', '#EDE3CF', '#F2ECDF'];
export const DARK = '#2B2622';
export const FADE_DEFAULT = 0.14;
export const GRAIN_OPACITY = 0.55;
export const COVER_PX = 320; // design size; the renderer scales with deviceScaleFactor

// FNV-1a over UTF-16 code units, exactly as in the design (JS charCodeAt + Math.imul).
export function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// m = { artist, title, year, label, cat? }, seed = seedShift. Returns the design's view model
// plus `layout` (chosen from otherwise unused hash bits; deterministic like the colours).
export function build(m, seed = 0) {
  const inks = INKS, papers = PAPERS;
  const h = hash((m.artist || '') + '|' + (m.title || '')) + seed * 7919;
  const n = inks.length, i = h % n, j = (i + 1 + ((h >>> 4) % (n - 1))) % n;
  let k = (j + 1 + ((h >>> 9) % (n - 1))) % n; if (k === i) k = (k + 1) % n;
  const t = (m.title || 'Untitled').trim(), L = t.length;
  const size = (big, small, mid) => (L <= 8 ? big : L <= 16 ? mid : small) + 'px';
  const y = String(m.year || '');
  return {
    ...m, title: t, cat: m.cat || ('NC-' + String(h % 9000 + 1000)),
    ink1: inks[i], ink2: inks[j], ink3: inks[k], paper: papers[(h >>> 12) % papers.length], dark: DARK,
    titleSize: size(48, 26, 34), titleSizeSerif: size(52, 30, 40), titleSizeSmall: size(40, 22, 28),
    yearShort: y ? "'" + y.slice(-2) : '—',
    sunX: (40 + ((h >>> 6) % 60)) + 'px', sun2X: (130 + ((h >>> 14) % 60)) + 'px',
    layout: LAYOUTS[(h >>> 20) % LAYOUTS.length],
  };
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const GRAIN_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 .3 0 0 0 0 .25 0 0 0 0 .2 0 0 0 .9 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>";
export const GRAIN = 'url("data:image/svg+xml;utf8,' + GRAIN_SVG.replace(/</g, '%3C').replace(/>/g, '%3E') + '")';

// Shared CSS. Font stacks: Heebo (sans, all weights) / Alef (the "serif" slot) with Noto fallbacks for
// scripts neither covers. `.t` = any text node: dir=auto makes Hebrew/Arabic run RTL inside its box.
export const BASE_CSS = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
body{font-family:'Heebo','Noto Sans',sans-serif;font-weight:500;color:${DARK};-webkit-font-smoothing:antialiased}
.cover{width:${COVER_PX}px;height:${COVER_PX}px;position:relative;overflow:hidden}
.mono{font-family:'Heebo','Noto Sans',sans-serif;font-weight:500}
.display{font-family:'Heebo','Noto Sans',sans-serif;font-weight:900}
.serif{font-family:'Alef','Heebo','Noto Sans',sans-serif;font-weight:700}
.t{overflow-wrap:break-word;min-width:0}
.title{text-wrap:balance}
.grain{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;background-image:var(--grain,${GRAIN});background-size:200px 200px}
.fade{position:absolute;inset:0;pointer-events:none;background:#F4EEE2;box-shadow:inset 0 0 40px rgba(90,70,40,.35)}
`;

function overlays(o) {
  // (grain URL lives in BASE_CSS: the data URI's double quotes cannot sit inside a style="" attribute)
  return `<div class="grain" style="opacity:${o.grainOpacity}"></div>` +
    `<div class="fade" style="opacity:${o.fade}"></div>`;
}

// data-fit="<maxHeightPx>": the renderer shrinks the title font (1px steps, floor 12px) only if the
// title at its design size overflows that box — long titles and tall Hebrew glyphs otherwise clip.
const T = (cls, a, sizeKey, maxH, extra = '') =>
  `<div class="t title ${cls}" dir="auto" data-fit="${maxH}" style="font-size:${a[sizeKey]};${extra}">${esc(a.title)}</div>`;

const TEMPLATES = {
  // 1a Banner
  '1a': (a, o) => `<div class="cover" style="background:${a.paper}">
  <div class="mono" style="position:absolute;top:22px;left:22px;right:22px;display:flex;justify-content:space-between;gap:12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${a.dark}"><span class="t" dir="auto">${esc(a.artist)}</span><span class="t" dir="auto">${esc(a.year)}</span></div>
  <div style="position:absolute;left:0;right:0;top:118px;height:96px;background:${a.ink2};transform:translate(5px,4px);mix-blend-mode:multiply;opacity:.85"></div>
  <div style="position:absolute;left:0;right:0;top:118px;height:96px;background:${a.ink1};mix-blend-mode:multiply"></div>
  <div style="position:absolute;left:0;right:0;top:118px;height:96px;display:flex;align-items:center;padding:0 22px">
    ${T('display', a, 'titleSize', 96, `line-height:.95;text-transform:uppercase;color:${a.paper};letter-spacing:-.01em`)}
  </div>
  <div class="mono" style="position:absolute;left:22px;right:22px;bottom:22px;display:flex;justify-content:space-between;align-items:flex-end;gap:12px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${a.dark}"><span class="t" dir="auto">${esc(a.label)}</span><span class="t" dir="auto">${esc(a.cat)}</span></div>
  ${overlays(o)}
</div>`,

  // 1b Year stack
  '1b': (a, o) => `<div class="cover" style="background:${a.ink1}">
  <div class="display" style="position:absolute;left:-8px;bottom:-34px;font-size:176px;line-height:1;letter-spacing:-.06em;color:${a.ink2};mix-blend-mode:multiply">${esc(a.yearShort)}</div>
  <div class="display" style="position:absolute;left:-3px;bottom:-31px;font-size:176px;line-height:1;letter-spacing:-.06em;color:transparent;-webkit-text-stroke:1px ${a.paper};opacity:.55">${esc(a.yearShort)}</div>
  <div style="position:absolute;top:24px;left:24px;right:24px;display:flex;flex-direction:column;gap:10px">
    <div style="height:2px;background:${a.paper}"></div>
    ${T('display', a, 'titleSize', 150, `line-height:.95;text-transform:uppercase;color:${a.paper}`)}
    <div class="t" dir="auto" style="font-size:16px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${a.paper}">${esc(a.artist)}</div>
  </div>
  ${a.label ? `<div class="mono t" dir="auto" style="position:absolute;right:24px;bottom:24px;max-width:200px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${a.dark};background:${a.paper};padding:3px 6px;text-align:right">${esc(a.label)}</div>` : ''}
  ${overlays(o)}
</div>`,

  // 1c Twin suns
  '1c': (a, o) => `<div class="cover" style="background:${a.paper}">
  <div style="position:absolute;width:210px;height:210px;border-radius:50%;left:${a.sunX};top:34px;background:${a.ink1};mix-blend-mode:multiply"></div>
  <div style="position:absolute;width:150px;height:150px;border-radius:50%;left:${a.sun2X};top:104px;background:${a.ink2};mix-blend-mode:multiply;opacity:.9"></div>
  <div class="mono t" dir="auto" style="position:absolute;top:22px;right:22px;font-size:10px;letter-spacing:.08em;color:${a.dark}">${esc(a.cat)}</div>
  <div style="position:absolute;left:22px;right:22px;bottom:22px;display:flex;flex-direction:column;gap:4px">
    ${T('serif', a, 'titleSizeSerif', 170, `line-height:1;color:${a.dark}`)}
    <div class="mono" style="display:flex;justify-content:space-between;gap:12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${a.dark}"><span class="t" dir="auto">${esc(a.artist)}</span><span class="t" dir="auto">${esc(a.year)}</span></div>
  </div>
  ${overlays(o)}
</div>`,

  // 1d Press slug
  '1d': (a, o) => `<div class="cover" style="background:${a.paper};display:grid;grid-template-columns:1fr 1fr 1fr">
  <div style="background:${a.ink1};mix-blend-mode:multiply"></div>
  <div style="background:${a.ink2};mix-blend-mode:multiply"></div>
  <div style="background:${a.ink3};mix-blend-mode:multiply"></div>
  <div style="position:absolute;left:18px;right:18px;top:50%;transform:translateY(-50%) rotate(-2deg);background:${a.paper};border:2px solid ${a.dark};padding:14px 16px;display:flex;flex-direction:column;gap:8px;box-shadow:4px 4px 0 ${a.dark}">
    <div class="mono" style="display:flex;justify-content:space-between;gap:12px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:${a.dark}"><span class="t" dir="auto">${esc(a.label)}</span><span class="t" dir="auto">${esc(a.year)}</span></div>
    <div style="height:1px;background:${a.dark}"></div>
    ${T('display', a, 'titleSizeSmall', 180, `line-height:.95;text-transform:uppercase;color:${a.dark}`)}
    <div class="t" dir="auto" style="font-size:15px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${a.ink1}">${esc(a.artist)}</div>
  </div>
  ${overlays(o)}
</div>`,
};

// HTML fragment (one 320x320 cover) for a view model from build() + print options.
export function coverHtml(a, layout, { grain = true, fade = FADE_DEFAULT } = {}) {
  const tpl = TEMPLATES[layout];
  if (!tpl) throw new Error('unknown layout ' + layout);
  return tpl(a, { grainOpacity: grain ? GRAIN_OPACITY : 0, fade });
}

// 2x2 contact sheet of all four layouts (design gallery look: #E4DED3 ground, mono chip labels).
export const SHEET_PAD = 24, SHEET_GAP = 24, SHEET_CHIP = 30;
export const SHEET_W = SHEET_PAD * 2 + COVER_PX * 2 + SHEET_GAP;
export const SHEET_H = SHEET_PAD * 2 + (COVER_PX + SHEET_CHIP) * 2 + SHEET_GAP;
export function sheetHtml(a, opts) {
  const cells = LAYOUTS.map(l => `<div style="display:flex;flex-direction:column;gap:8px">
    <div style="display:flex;gap:8px;align-items:center;height:22px"><span class="mono" style="font-size:12px;background:${DARK};color:#EFE7D6;padding:3px 8px;line-height:1">${l}</span><span style="font-size:14px;font-weight:700">${LAYOUT_NAMES[l]}</span></div>
    ${coverHtml(a, l, opts)}</div>`).join('');
  return `<div class="sheet" style="width:${SHEET_W}px;height:${SHEET_H}px;background:#E4DED3;padding:${SHEET_PAD}px;display:grid;grid-template-columns:${COVER_PX}px ${COVER_PX}px;gap:${SHEET_GAP}px;color:${DARK}">${cells}</div>`;
}

// The grain tile. feTurbulence is re-filtered at device resolution on every paint (~300 ms per 1000 px
// cover), so the renderer screenshots this 200x200 CSS px tile once per deviceScaleFactor (same CSS
// background path as the design → identical noise) and feeds the bitmap back in as --grain.
export const GRAIN_TILE_HTML = `<img id="grain-tile" width="200" height="200" style="display:block" src="${GRAIN.slice(5, -2)}">`;
// Wait for the tile image, then for the --grain bitmap to be decoded, so a screenshot never races the paint.
export const GRAIN_READY = `(async () => { const i = document.getElementById('grain-tile'); if (i) await i.decode(); })()`;
export const PAINT_READY = `(async () => {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--grain').trim();
  if (v.startsWith('url("')) { const im = new Image(); im.src = v.slice(5, -2); await im.decode().catch(() => {}); }
  await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
})()`;

// Runs inside the page after the fragment is inserted: shrink overflowing titles.
export const FIT_SCRIPT = `(() => {
  for (const el of document.querySelectorAll('[data-fit]')) {
    const max = parseFloat(el.dataset.fit); let fs = parseFloat(getComputedStyle(el).fontSize);
    const over = () => el.getBoundingClientRect().height > max + 0.5 || el.scrollWidth > el.clientWidth + 0.5;
    while (fs > 12 && over()) { fs -= 1; el.style.fontSize = fs + 'px'; }
  }
  return document.fonts.ready.then(() => true);
})()`;
