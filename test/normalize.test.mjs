import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle } from '../lib/normalize.js';

const cases = [
  ['(1968) Shine On Brightly', '1968', 'Shine On Brightly', '1968'],
  ['(1971) 666', '1971', '666', '1971'],
  ['2 - Greatest Hits II', '', 'Greatest Hits II', ''],
  ['[1977] Lagos After Dark', '', 'Lagos After Dark', '1977'],          // no year known → adopt it
  ['1982 - Songs for the Long Drive Home', '1982', 'Songs for the Long Drive Home', '1982'],
  ['Summer Static (1974)', '1974', 'Summer Static', '1974'],
  ['Summer Static [1974]', '', 'Summer Static', '1974'],
  ['3. Blue', '', 'Blue', ''],
  ['01 - חום יולי אוגוסט', '1988', 'חום יולי אוגוסט', '1988'],            // Hebrew, disc prefix
  ['(1988) חום  יולי אוגוסט', '1988', 'חום יולי אוגוסט', '1988'],
  // must NOT change
  ['1984', '1984', '1984', '1984'],
  ['2 Live Crew Singles', '', '2 Live Crew Singles', ''],
  ['(1968) Shine On Brightly', '1970', '(1968) Shine On Brightly', '1970'],   // wrapper year ≠ album year → keep
  ['Scטne de vie', '1990', 'Scטne de vie', '1990'],                           // mojibake is not ours to fix
  ['1999', '', '1999', ''],
  ['(1971)', '1971', '(1971)', '1971'],                                       // nothing would remain → keep
];
for (const [input, year, title, outYear] of cases) {
  test(`normalizeTitle(${JSON.stringify(input)}, ${JSON.stringify(year)})`, () => {
    const r = normalizeTitle(input, year);
    assert.equal(r.title, title); assert.equal(r.year, outYear);
    assert.equal(r.changed, title !== input || outYear !== year);
  });
}
