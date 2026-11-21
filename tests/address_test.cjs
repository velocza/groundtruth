/* Address matching against the real Overture index for both areas: node tests/address_test.cjs */
const fs = require('fs'), assert = require('assert');
global.atob = s => Buffer.from(s, 'base64').toString('binary');
const load = f => { const w = {}; new Function('window', fs.readFileSync(f, 'utf8'))(w); return w; };
require('./../site/js/address.js'); const GA = globalThis.GTAddress;
function idx(dir) { const w = load(`site/${dir}/addresses.js`); return GA.Index(w.GT_ADDR); }
const L = idx('data'), S = idx('data_sf');
const cases = [
  [L, '24 Miner Road, Orinda', r => r.ok && r.exact && r.street === 'Miner Rd' && r.city === 'Orinda'],
  [L, '24 miner rd', r => r.ok && r.exact],
  [L, '3400 Mount Diablo Boulevard Lafayette CA 94549', r => r.ok && r.exact && r.city === 'Lafayette'],
  [L, '25 Miner Rd, Orinda', r => r.ok && !r.exact && r.note],
  [L, 'Miner Road', r => r.ok && r.number == null],
  [L, 'zzzz nowhere lane', r => !r.ok && r.why === 'none'],
  [S, '1 Dr Carlton B Goodlett Place', r => r.ok && r.exact],
  [S, '402 43rd Avenue, San Francisco', r => r.ok && r.exact],
  [S, '402 43rd ave apt 3', r => r.ok && r.exact],
  [S, '1600 Folsom St', r => r.ok],
];
let bad = 0;
for (const [ix, q, ok] of cases) { const r = ix.find(q); const pass = ok(r); if (!pass) bad++; console.log(pass ? 'ok  ' : 'FAIL', q, '->', r.ok ? r.label + (r.note ? ' (' + r.note + ')' : '') : JSON.stringify(r).slice(0, 160)); }
console.log('suggest', L.suggest('12 mine'), S.suggest('valen'));
process.exit(bad ? 1 : 0);
