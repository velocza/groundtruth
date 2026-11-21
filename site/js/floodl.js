/* escape Lamorinda flood score (GTFloodL). Data: site/data/flood_lamorinda.js from scripts/13_flood_lamorinda.py.
   Where: FEMA flood zones first, then height above the nearest USGS NHD creek and distance to it. Storm: 3 day rain and soil wetness.
   It is a hand-set score from real public layers, not a model trained on floods (Lamorinda has too few located flood reports to train one). */
(function (root) {
  const D = root.GT_FLOOD_L; if (!D) return;
  const M = D.meta, NX = M.nx, NY = M.ny, [W, S, E, N] = M.bbox;
  const dec = s => { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  const where = dec(D.where), hand = dec(D.hand), dist = dec(D.dist), zone = dec(D.zone), creek = dec(D.creek);
  const clip = (v, a, b) => Math.max(a, Math.min(b, v));
  /* storm factor, hand set (see meta.storm_note) */
  const storm = (r72, api) => clip(0.75 * Math.min(1.4, r72 / 120) + 0.25 * Math.min(1.2, api / 120), 0, 1.2);
  const score = (w, r72, api) => clip(100 * (w / 255) * storm(r72, api), 0, 100);
  const placeLevel = w => w >= 0.75 * 255 ? 'High' : w >= 0.45 * 255 ? 'Elevated' : 'Low';
  const cellOf = (lon, lat) => { const c = Math.floor((lon - W) / (E - W) * NX), r = Math.floor((N - lat) / (N - S) * NY); return c < 0 || r < 0 || c >= NX || r >= NY ? -1 : r * NX + c; };
  /* the address: the most flood-prone cell within about 60 m */
  function at(lon, lat) {
    const i0 = cellOf(lon, lat); if (i0 < 0) return null;
    const r0 = Math.floor(i0 / NX), c0 = i0 % NX; let best = i0, hMin = 1e9, dMin = 1e9;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) { if (dr * dr + dc * dc > 5) continue; const r = r0 + dr, c = c0 + dc; if (r < 0 || c < 0 || r >= NY || c >= NX) continue; const i = r * NX + c;
      if (where[i] > where[best]) best = i; hMin = Math.min(hMin, hand[i]); dMin = Math.min(dMin, dist[i]); }
    let below = 0; for (let i = 0; i < where.length; i++) if (where[i] < where[best]) below++;
    const z = zone[best];
    return { w: where[best], level: placeLevel(where[best]), fema: z & 2 ? '1%' : z & 1 ? '0.2%' : null, floodway: !!(z & 4), hand: hand[i0] / 4, handMin: hMin / 4, creekM: dMin * 5,
      creekName: M.names[creek[i0]] || null, below: below / where.length, at: (r72, api) => score(where[best], r72, api) };
  }
  /* streets: mean of the top tenth of cells along each street */
  let streetMemo = null;
  function streets() {
    if (streetMemo) return streetMemo;
    const Mo = root.GTModel, G = root.GT; if (!Mo || !G) return [];
    const out = [];
    G.streets.forEach((s, k) => { const cs = Mo.cellsForStreet(k); if (!cs || cs.length < 3) return; const v = Array.from(cs, i => where[i]).sort((a, b) => b - a); const n = Math.max(1, Math.round(v.length / 10));
      let t = 0; for (let j = 0; j < n; j++) t += v[j]; let fz = 0; for (const i of cs) if (zone[i] & 2) fz++; out.push({ k, n: s.n, w: t / n, fema: fz, cells: cs.length }); });
    const by = new Map(); for (const o of out) { const p = by.get(o.n); if (!p || o.w > p.w) by.set(o.n, o); }
    streetMemo = [...by.values()].sort((a, b) => b.w - a.w || b.fema / b.cells - a.fema / a.cells); streetMemo.forEach((o, i) => o.rank = i + 1); return streetMemo;
  }
  const streetByName = n => streets().find(o => o.n.toLowerCase() === String(n).toLowerCase()) || null;
  /* map: show the where score through the landslide colour hook while on; app.js puts the landslide layer back on hide */
  let app = null;
  const F = { on: false, meta: M, at, storm, score, streets, streetByName, placeLevel,
    register(a) { app = a; },
    show() { const Sc = root.GTScene; if (!Sc || !Sc.setLandslide) return false; const lay = new Uint8Array(where.length); for (let i = 0; i < lay.length; i++) lay[i] = Math.round(where[i] * 0.98) + 2; F.on = true; Sc.setLandslide(lay, true); return true; },
    hide() { if (!F.on) return; F.on = false; if (app && app.restore) app.restore(); } };
  root.GTFloodL = F;
})(window);
