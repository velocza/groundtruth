/* GroundTruth "Neighbors helping neighbors": who must leave in a storm but cannot drive out alone, and how many of them could ride with a neighbor who is leaving anyway.
   Every household in this file is a SIMULATED HOUSEHOLD drawn from Census block group estimates with a fixed seed. No names, no addresses, no personal data, and nothing here collects any.
   The top half is plain arithmetic with no page access, so tests/rides_test.cjs can run it in node. The page wiring starts at "page". */
(function () {
  const SEED = 20230114;                                 // fixed, so everyone sees the same simulated households
  const SEATS = 5;                                       // one car per driving household, five seats, the household itself rides first
  const DETOUR_M = 1000;                                 // a driver goes at most this far out of the way, there and back, for a pickup
  const NEAR_SLIDE_M = 100;                              // mapped-slides mode: a building this close to a USGS-mapped 2023 slide point or travel path must leave
  const MX = 87800, MY = 110950;                         // metres per degree here, as everywhere else in the project
  const Z90 = 1.645;

  /* ------------------------------------------------ Census block groups and buildings (site/data/census_bg.js, built by scripts/09_census.py) */
  function bytes(b64) { const s = atob(b64), u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
  function decode(C) {
    const [W, S, E, N] = C.meta.bbox, raw = bytes(C.bld); let n = raw.length / 7; const u16 = o => new Uint16Array(raw.buffer.slice(o, o + 2 * n));
    const wide = C.meta.bg_bytes === 2, NONE = wide ? 65535 : 255;             // San Francisco has about 680 block groups, so its ids take two bytes
    if (wide) n = raw.length / 8;
    const qx = u16(0), qy = u16(2 * n), area = u16(4 * n), bg = wide ? u16(6 * n) : raw.slice(6 * n), lon = new Float64Array(n), lat = new Float64Array(n);
    for (let i = 0; i < n; i++) { lon[i] = W + qx[i] / 65535 * (E - W); lat[i] = S + qy[i] / 65535 * (N - S); }
    const [NX, NY] = C.meta.grid, cells = wide ? new Uint16Array(NX * NY) : new Uint8Array(NX * NY), runs = bytes(C.cells), w = wide ? 4 : 3; let p = 0;
    for (let i = 0; i < runs.length; i += w) { const v = wide ? runs[i] | runs[i + 1] << 8 : runs[i], len = runs[i + w - 2] | runs[i + w - 1] << 8; cells.fill(v, p, p + len); p += len; }
    return { meta: C.meta, bg: C.bg, n, lon, lat, area, bldBg: bg, cells, NX, NY, bbox: C.meta.bbox, none: NONE };
  }
  const cellOf = (D, lon, lat) => { const [W, S, E, N] = D.bbox, c = Math.floor((lon - W) / (E - W) * D.NX), r = Math.floor((N - lat) / (N - S) * D.NY); return r < 0 || c < 0 || r >= D.NY || c >= D.NX ? -1 : r * D.NX + c; };
  const bgAt = (D, lon, lat) => { const none = D.none == null ? 255 : D.none, i = cellOf(D, lon, lat), k = i < 0 ? none : D.cells[i]; return k === none ? -1 : k; };

  /* Step 2. Spread each block group's counts over its residential-sized buildings in proportion to footprint area.
     A block group that reaches past the edge of the map only brings the share of its households that matches its share of area inside the map.
     Returns expected households per building as [low, estimate, high] from the published margins of error. */
  function spread(D) {
    const sum = new Float64Array(D.bg.length); for (let i = 0; i < D.n; i++) sum[D.bldBg[i]] += D.area[i];
    const lo = new Float32Array(D.n), est = new Float32Array(D.n), hi = new Float32Array(D.n);
    for (let i = 0; i < D.n; i++) { const g = D.bg[D.bldBg[i]], w = D.area[i] / sum[D.bldBg[i]] * g.frac; lo[i] = Math.max(0, g.hh[0] - g.hh[1]) * w; est[i] = g.hh[0] * w; hi[i] = (g.hh[0] + g.hh[1]) * w; }
    return { lo, est, hi };
  }
  /* Share of a block group's households with no vehicle, and share that are an older person living alone, each as [low, estimate, high].
     "Older, may need help" = households of one person aged 65 or over (B11007_003) times the share of the block group's 65+ residents who are 75 or over (B01001). */
  function shares(g) {
    const hh = Math.max(1, g.hh[0]), cl = v => Math.max(0, Math.min(1, v / hh)), old = g.age65[0] > 0 ? Math.min(1, g.age75[0] / g.age65[0]) : 0;
    return { nocar: [cl(g.nocar[0] - g.nocar[1]), cl(g.nocar[0]), cl(g.nocar[0] + g.nocar[1])], help: [cl((g.alone65[0] - g.alone65[1]) * old), cl(g.alone65[0] * old), cl((g.alone65[0] + g.alone65[1]) * old)], old };
  }

  /* Step 3. Simulated households. Each one gets a building, a size, and two fixed random draws that decide "no car" and "older, may need help"
     once a low, middle or high Census share is chosen, so the low set is always inside the middle set and the middle inside the high. */
  function rng(seed) { let a = seed >>> 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function households(D, seed) {
    const rnd = rng(seed == null ? SEED : seed), by = D.bg.map(() => []); for (let i = 0; i < D.n; i++) by[D.bldBg[i]].push(i);
    const bld = [], size = [], uCar = [], uHelp = [];
    D.bg.forEach((g, k) => {
      const list = by[k], H = Math.round(g.hh[0] * g.frac); if (!list.length || !H) return;
      let tot = 0; for (const i of list) tot += D.area[i];
      const step = tot / H, n1 = Math.max(1, g.sizes[0]), nAll = Math.max(1, g.sizes.reduce((a, b) => a + b, 0)), p1 = n1 / nAll;
      let at = rnd() * step, acc = 0, j = 0;                                     // systematic sampling along cumulative footprint area: no building is far from its expected share
      for (let h = 0; h < H; h++, at += step) {
        while (j < list.length - 1 && acc + D.area[list[j]] <= at) acc += D.area[list[j++]];
        let u = rnd() * nAll, s = 0; while (s < 6 && u >= g.sizes[s]) u -= g.sizes[s++];
        bld.push(list[j]); size.push(s + 1); uCar.push(rnd());
        uHelp.push(s === 0 ? rnd() * p1 : 2);                                      // only one-person households can be "an older person living alone"; scaled so the block group share comes out right
      }
    });
    return { n: bld.length, bld: Int32Array.from(bld), size: Uint8Array.from(size), uCar: Float32Array.from(uCar), uHelp: Float32Array.from(uHelp), seed: seed == null ? SEED : seed };
  }
  /* 0 = has a car and can drive, 1 = no car, 2 = older and may need help, 3 = both. lvl: 0 low, 1 estimate, 2 high. */
  function needs(D, hh, lvl) {
    const sh = D.bg.map(shares), out = new Uint8Array(hh.n);
    for (let h = 0; h < hh.n; h++) { const s = sh[D.bldBg[hh.bld[h]]]; out[h] = (hh.uCar[h] < s.nocar[lvl] ? 1 : 0) | (hh.uHelp[h] < s.help[lvl] ? 2 : 0); }
    return out;
  }

  /* Step 4. The four groups. zone[b] = 1 where building b must leave, clear[b] = 1 where it still has a road route out.
     1 not in the danger zone, 2 must leave and can drive out (possible driver), 3 must leave and needs a ride, 4 must leave but every route out is blocked. */
  function split(hh, need, zone, clear) {
    const g = new Uint8Array(hh.n);
    for (let h = 0; h < hh.n; h++) { const b = hh.bld[h]; g[h] = !zone[b] ? 1 : !clear[b] ? 4 : need[h] ? 3 : 2; }
    return g;
  }

  /* Mapped-slides mode: buildings within `dist` metres of a mapped slide point or of any segment of a mapped travel path. */
  function nearSlides(D, points, paths, dist) {
    const d = dist == null ? NEAR_SLIDE_M : dist, cell = Math.max(d, 50), grid = new Map(), key = (x, y) => Math.floor(x / cell) + ',' + Math.floor(y / cell), segs = [];
    const add = (x0, y0, x1, y1) => { const k = segs.length / 4; segs.push(x0, y0, x1, y1); for (let gx = Math.floor((Math.min(x0, x1) - d) / cell); gx <= Math.floor((Math.max(x0, x1) + d) / cell); gx++) for (let gy = Math.floor((Math.min(y0, y1) - d) / cell); gy <= Math.floor((Math.max(y0, y1) + d) / cell); gy++) { const q = gx + ',' + gy; (grid.get(q) || grid.set(q, []).get(q)).push(k); } };
    for (const p of points || []) add(p[0] * MX, p[1] * MY, p[0] * MX, p[1] * MY);
    for (const path of paths || []) { if (path.length === 1) add(path[0][0] * MX, path[0][1] * MY, path[0][0] * MX, path[0][1] * MY); for (let k = 0; k + 1 < path.length; k++) add(path[k][0] * MX, path[k][1] * MY, path[k + 1][0] * MX, path[k + 1][1] * MY); }
    const out = new Uint8Array(D.n);
    for (let i = 0; i < D.n; i++) { const x = D.lon[i] * MX, y = D.lat[i] * MY, list = grid.get(key(x, y)); if (!list) continue;
      for (const k of list) { const ax = segs[4 * k], ay = segs[4 * k + 1], dx = segs[4 * k + 2] - ax, dy = segs[4 * k + 3] - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= d) { out[i] = 1; break; } } }
    return out;
  }

  /* Step 5. Matching. net is the road network after blocked roads are taken out:
       nodeOf[b]  road node of building b (-1 if none)
       next[n]    the next node on node n's route out (-1 at an exit, -2 if n cannot reach an exit)
       dist[n]    metres from n to its exit along that route
       adj(n)     optional: [[neighbour, metres], ...] over roads that are still open
     A driver's route out is the chain of next[] from the driver's node. A pickup is allowed when the rider's node is on that chain (no detour) or within
     cap / 2 metres of it by open road (detour = there and back). Riders are taken in order; each takes the smallest detour on offer, then the closest car with
     enough free seats for the whole household. Greedy, not optimal: a better pairing could seat a few more. */
  function match(riders, drivers, net, opt) {
    const cap = opt && opt.cap != null ? opt.cap : DETOUR_M, N = net.next.length, kids = Array.from({ length: N }, () => []), roots = [];
    for (let n = 0; n < N; n++) { const p = net.next[n]; if (p >= 0) kids[p].push(n); else if (p === -1) roots.push(n); }
    const tin = new Int32Array(N).fill(-1), tout = new Int32Array(N); let clock = 0;
    for (const r of roots) { const st = [r]; tin[r] = clock++; const it = new Map(); while (st.length) { const n = st[st.length - 1], k = it.get(n) || 0; if (k < kids[n].length) { it.set(n, k + 1); const c = kids[n][k]; tin[c] = clock++; st.push(c); } else { tout[n] = clock; st.pop(); } } }
    const ds = drivers.filter(d => d.node >= 0 && tin[d.node] >= 0 && d.seats > 0).map(d => ({ ...d, tin: tin[d.node], left: d.seats })).sort((a, b) => a.tin - b.tin || a.id - b.id);
    const tins = ds.map(d => d.tin), lower = v => { let lo = 0, hi = tins.length; while (lo < hi) { const m = lo + hi >> 1; if (tins[m] < v) lo = m + 1; else hi = m; } return lo; };
    const best = (n, seats) => { let pick = -1, bd = Infinity; for (let k = lower(tin[n]), e = lower(tout[n]); k < e; k++) { if (ds[k].left < seats) continue; const d = Math.abs(net.dist[ds[k].node] - net.dist[n]); if (d < bd) { bd = d; pick = k; } } return pick; };
    const pairs = [], left = [];
    for (const r of riders) {
      let done = false;
      if (r.node >= 0 && tin[r.node] >= 0) {
        const seen = new Map([[r.node, 0]]), q = [[0, r.node]];                 // open roads within cap / 2 of the pickup, nearest first
        while (q.length && !done) {
          let m = 0; for (let k = 1; k < q.length; k++) if (q[k][0] < q[m][0]) m = k; const [d, n] = q.splice(m, 1)[0]; if (d > seen.get(n)) continue;
          if (tin[n] >= 0) { const k = best(n, r.seats); if (k >= 0) { ds[k].left -= r.seats; pairs.push({ rider: r.id, driver: ds[k].id, detour: 2 * d, seats: r.seats }); done = true; break; } }
          if (net.adj) for (const [m2, len] of net.adj(n)) { const nd = d + len; if (2 * nd <= cap && (!seen.has(m2) || nd < seen.get(m2))) { seen.set(m2, nd); q.push([nd, m2]); } }
        }
      }
      if (!done) left.push(r.id);
    }
    return { pairs, left, cap };
  }

  /* One storm, one mode: split every simulated household, match riders to drivers, and total it up three times (low, estimate, high Census shares).
     env = { zone: Uint8Array per building, clear: Uint8Array per building, net }. Ranges combine, block group by block group, the Census margins of error
     and the luck of the simulated draw, by root sum of squares (the Census rule for adding estimates). */
  function run(D, hh, env, opt) {
    const B = D.bg.length, lv = [0, 1, 2].map(lvl => {
      const need = needs(D, hh, lvl), g = split(hh, need, env.zone, env.clear), riders = [], drivers = [];
      for (let h = 0; h < hh.n; h++) { const node = env.net ? env.net.nodeOf[hh.bld[h]] : -1; if (g[h] === 3) riders.push({ id: h, node, seats: hh.size[h] }); else if (g[h] === 2) drivers.push({ id: h, node, seats: Math.max(0, SEATS - hh.size[h]) }); }
      riders.sort((a, b) => (need[b.id] & 2) - (need[a.id] & 2) || a.id - b.id);   // older households first, then a fixed order
      const m = env.net ? match(riders, drivers, env.net, opt) : { pairs: [], left: riders.map(r => r.id), cap: DETOUR_M };
      const per = k => new Float64Array(B), c = { leave: per(), ride: per(), matched: per(), left: per(), cut: per(), drivers: per() }, bgOf = h => D.bldBg[hh.bld[h]];
      for (let h = 0; h < hh.n; h++) { if (g[h] === 1) continue; const b = bgOf(h); c.leave[b]++; if (g[h] === 3) c.ride[b]++; else if (g[h] === 4) c.cut[b]++; else c.drivers[b]++; }
      for (const p of m.pairs) c.matched[bgOf(p.rider)]++; for (const h of m.left) c.left[bgOf(h)]++;
      return { need, g, m, c };
    });
    const mid = lv[1], sum = a => a.reduce((x, y) => x + y, 0), rel = D.bg.map(g => g.hh[0] > 0 ? g.hh[1] / g.hh[0] : 0);
    const byHH = a => { let s = 0; for (let b = 0; b < B; b++) s += (a[b] * rel[b]) ** 2 + Z90 * Z90 * a[b]; const t = sum(a), e = Math.sqrt(s); return [Math.max(0, t - e), t, t + e]; };
    const byShare = k => { let lo = 0, hi = 0; for (let b = 0; b < B; b++) { const c = mid.c[k][b], n = Z90 * Z90 * c; lo += Math.max(0, c - lv[0].c[k][b]) ** 2 + n; hi += Math.max(0, lv[2].c[k][b] - c) ** 2 + n; } const t = sum(mid.c[k]); return [Math.max(0, t - Math.sqrt(lo)), t, t + Math.sqrt(hi)]; };
    const ride = byShare('ride'), matched = byShare('matched'), left = byShare('left'), cut = byHH(mid.c.cut), tc = left[1] + cut[1];
    const city = [Math.max(0, tc - Math.hypot(left[1] - left[0], cut[1] - cut[0])), tc, tc + Math.hypot(left[2] - left[1], cut[2] - cut[1])];
    matched[0] = Math.min(matched[0], ride[0]); matched[2] = Math.min(matched[2], ride[2]);
    return { leave: byHH(mid.c.leave), ride, matched, city, cut, drivers: sum(mid.c.drivers), driversR: byHH(mid.c.drivers), groups: mid.g, need: mid.need, pairs: mid.m.pairs, left: mid.m.left, perBg: mid.c, cap: mid.m.cap };
  }
  /* A range for the page: whole numbers, rounded so it does not look more exact than it is. */
  function show(r) {
    const step = v => v >= 2000 ? 100 : v >= 500 ? 50 : v >= 100 ? 10 : v >= 30 ? 5 : 1, lo = Math.floor(r[0] / step(r[1])) * step(r[1]), hi = Math.ceil(r[2] / step(r[1])) * step(r[1]);
    const f = v => v.toLocaleString('en-US'); return hi <= 0 ? '0' : lo === hi ? f(lo) : `${f(lo)} to ${f(hi)}`;
  }

  const api = { SEED, SEATS, DETOUR_M, NEAR_SLIDE_M, decode, cellOf, bgAt, spread, shares, households, needs, split, nearSlides, match, run, show, rng };
  if (typeof window !== 'undefined') window.GTRides = api;
  if (typeof document === 'undefined' || !window.GT_CENSUS) return;

  /* ------------------------------------------------ page */
  const $ = s => document.querySelector(s), sec = $('#rides'), Mo = window.GTModel, Sc = window.GTScene, G = window.GT; if (!sec || !Mo || !G) return;
  const SF = !!(window.GT_REGION && window.GT_REGION.id === 'sf');
  const D = decode(window.GT_CENSUS), hh = households(D), fmt = v => Math.round(v).toLocaleString('en-US');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const R23 = G.rain.wy2023, D0 = 80, D1 = 181, mm = d => R23.mm[d] || 0;        // Dec 20, 2022 to Mar 31, 2023, as in the replay view
  const dayStr = d => { const t = new Date(R23.start + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
  const round = sc => ({ r72: Math.min(300, Math.round(sc.r72)), api: Math.min(280, Math.round(sc.api)), era: 0, amt: 0 });   // the storm sliders' own limits
  /* The January 2023 peak is the Storm view's preset day, found the same way app.js finds it. */
  let peakDay = D0; { let best = -1; for (let d = D0; d <= D1; d++) { const T = 0.55 * Math.min(1.5, (mm(d + 1) + mm(d + 2) + mm(d + 3)) / 200) + 0.45 * Math.min(1.3, R23.api[d] / 200); if (T > best) { best = T; peakDay = d; } } }
  const peakSc = round({ r72: mm(peakDay + 1) + mm(peakDay + 2) + mm(peakDay + 3), api: R23.api[peakDay] });
  /* Day by day, only rain already logged: the rain of that day and the two before it, on the soil wetness from three days earlier. */
  const loggedSc = d => round(window.GTEvac && GTEvac.rainBefore && GTEvac.ensure && GTEvac.ensure() ? GTEvac.rainBefore(d - 3, d) : { r72: mm(d - 2) + mm(d - 1) + mm(d), api: R23.api[d - 3] });   // the Getting out view's own rule, started three days back

  /* ---- everything taken from evac.js comes through envOf, so the rest of this file does not care how routes are worked out.
     Read-only: GTEvac.graph(), .scenario(sc, mode), .nodeAt(lon, lat), .usgs(), .rainBefore(d, rep) and .state().st (its threshold and which reports count). */
  let bldCell = null, nodeOf = null;
  const evSt = () => { const E = window.GTEvac; return E && E.state ? E.state().st : null; };
  const sig = () => { const t = evSt(); return `${t ? t.thr + '|' + t.local : ''}|${Mo.opts.bias}|${Mo.opts.motion}`; };   // settings that live in other views and change the answer
  function envOf(sc, mode) {
    if (!bldCell) bldCell = Int32Array.from(D.lon, (x, i) => Mo.cellOf(x, D.lat[i]));
    const E = window.GTEvac, g = E && E.graph ? E.graph() : null, zone = new Uint8Array(D.n);
    if (!g) {                                              // no road network: the model's danger zone only, nobody can be matched
      if (mode !== 'model') return null;
      for (let b = 0; b < D.n; b++) if (bldCell[b] >= 0 && Mo.index(bldCell[b], sc) >= 50) zone[b] = 1;
      return { zone, clear: new Uint8Array(D.n).fill(1), net: null, routes: false, thr: 50 };
    }
    if (!nodeOf) nodeOf = Int32Array.from(D.lon, (x, i) => { const n = E.nodeAt(x, D.lat[i]); return n >= 0 && g.base[n] ? n : -1; });   // homes with no road to an exit even in dry weather stay off the network
    const ev = E.scenario(sc, mode === 'model' ? 'model' : 'mapped'), thr = ev.threshold, t = evSt();
    const slides = E.usgs().recorded2023.filter(f => f.source === 'usgs' || !t || t.local);
    if (mode === 'model') { const dz = new Uint8Array(Mo.N); for (const c of ev.dangerCells) dz[c] = 1; for (let b = 0; b < D.n; b++) { const c = bldCell[b]; if (c >= 0 && (dz[c] || Mo.index(c, sc) >= thr)) zone[b] = 1; } }
    else zone.set(nearSlides(D, slides.map(f => f.lonlat), null, NEAR_SLIDE_M));
    const next = new Int32Array(g.nn), clear = new Uint8Array(D.n);
    for (let n = 0; n < g.nn; n++) { const e = ev.next[n]; next[n] = e >= 0 ? (g.eu[e] === n ? g.ev[e] : g.eu[e]) : e; }
    for (let b = 0; b < D.n; b++) clear[b] = nodeOf[b] < 0 || ev.reach[nodeOf[b]] ? 1 : 0;
    const adj = n => { const out = []; for (let j = g.adjOff[n]; j < g.adjOff[n + 1]; j++) { const e = g.adjE[j]; if (!ev.blocked[e]) out.push([g.eu[e] === n ? g.ev[e] : g.eu[e], g.elen[e]]); } return out; };
    return { zone, clear, net: { nodeOf, next, dist: ev.metres, adj }, routes: true, thr, slides };
  }
  const cache = new Map();
  function result(sc, mode) {
    const key = mode === 'model' ? `m|${sc.r72}|${sc.api}` : 'mapped'; if (cache.has(key)) return cache.get(key);
    const env = envOf(sc, mode), r = env ? Object.assign(run(D, hh, env), { env }) : null;
    if (cache.size > 160) cache.delete(cache.keys().next().value); cache.set(key, r); return r;
  }

  /* ---- headline */
  let sc = null, mode = 'model', timer = 0, shown = null;
  const visible = () => sec.classList.contains('on');
  const STATS = [['#rdLeave', 'leave'], ['#rdRide', 'ride'], ['#rdMatch', 'matched'], ['#rdCity', 'city'], ['#rdCut', 'cut'], ['#rdDrivers', 'driversR']];
  function paint() {
    if (!sc || !visible()) return;
    const r = shown = result(sc, mode);
    for (const [id, k] of STATS) $(id).textContent = r ? show(r[k]) : 'n/a';
    $('#rdStorm').textContent = mode === 'model'
      ? `Storm: ${sc.r72} mm of rain in 72 hours on soil wetness ${sc.api} mm. A home must leave when the ground under it scores ${r && r.env.thr >= 75 ? 'High' : 'Elevated or High'}, or it sits in the path debris would take.`
      : `Slides recorded in winter 2023: ${slideText(r)}. A home must leave when it is within ${NEAR_SLIDE_M} m of one. This is observed, not forecast, and the USGS inventory is incomplete, so these counts are a floor. The storm sliders do not change this view.`;
    $('#rdRule').textContent = `A pickup counts when the rider is within ${DETOUR_M / 1000} km, there and back, of the driver's own route out, the car has a free seat (${SEATS} seats, the driver's household rides first), and both routes are clear. Ranges come from the Census margins of error and the luck of the simulated draw. ${SF ? 'Only homes in San Francisco County are counted: the strip of Daly City and Brisbane at the bottom of the map has no simulated households.' : 'Only homes in Contra Costa County are counted, so these numbers are smaller than the building counts elsewhere on the site, which include the Oakland side of the map.'}`
      + (r && !r.env.routes ? ' Road routes are not loaded here, so nobody can be matched and everyone who needs a ride is counted for the city.' : '') + (r ? '' : ' This view needs the evacuation routes, which are not loaded.');
    drawMap(r);
  }
  function slideText(r) {
    const U = window.GT_USGS, sl = r && r.env.slides || [], nu = sl.filter(f => f.source === 'usgs').length, nl = sl.length - nu;
    return `${nu} of the ${U && U.meta.y2023 ? U.meta.y2023.total : 'many'} slides the USGS mapped around the Bay falls inside this map` + (nl ? `, plus the ${nl} local reports the site already carries, placed by street name` : '') + '. The USGS files hold no slide travel paths, only the roads its crews drove, so none are used';
  }
  const schedule = ms => { clearTimeout(timer); timer = setTimeout(paint, ms); };
  api.storm = (r72, a) => { sc = round({ r72, api: a }); if (visible()) schedule(120); };   // sliders fire fast: wait for a pause, then recount
  function setMode(m) { mode = m; $('#rdModel').setAttribute('aria-pressed', m === 'model'); $('#rdMapped').setAttribute('aria-pressed', m === 'mapped'); schedule(0); }
  $('#rdModel').addEventListener('click', () => setMode('model')); $('#rdMapped').addEventListener('click', () => setMode('mapped'));
  $('#rdPeakBtn').textContent = dayStr(peakDay);

  /* ---- map layer: a flat canvas over the 3D map, redrawn every frame from GTScene.project. Dots sit on building footprints; who lives there is simulated. */
  const cv = document.createElement('canvas'); cv.id = 'rdMap'; cv.setAttribute('aria-hidden', 'true'); let marks = null, pins = [], pinsFor = '';
  function drawMap(r) {
    marks = null; if (!r) return;
    const at = h => [D.lon[hh.bld[h]], D.lat[hh.bld[h]]], drv = new Set(), rid = [], cty = [], cut = [], links = [];
    for (const p of r.pairs) { drv.add(p.driver); rid.push(at(p.rider)); links.push([at(p.rider), at(p.driver)]); }
    for (const h of r.left) cty.push(at(h)); for (let h = 0; h < hh.n; h++) if (r.groups[h] === 4) cut.push(at(h));
    const cap = a => a.length > 1500 ? a.filter((_, k) => k % Math.ceil(a.length / 1500) === 0) : a;      // keep the frame light in a very large storm
    marks = { drv: cap([...drv].map(at)), rid: cap(rid), cty: cap(cty), cut: cap(cut), links: cap(links) };
    const want = mode === 'mapped' && r.env.slides ? r.env.slides.map(f => f.label).join('|') : '';
    if (want !== pinsFor) { pins.forEach(p => p.lb.show(false)); pins = []; pinsFor = want;
      if (want && Sc.addLabel) for (const f of r.env.slides) { const el = document.createElement('div'); el.className = 'pin-label evac-mk ' + f.source; el.textContent = f.label; el.hidden = true; $('#labels').appendChild(el); pins.push({ lb: Sc.addLabel(f.lonlat[0], f.lonlat[1], el, 0.07) }); } }
    pins.forEach(p => p.lb.show(true));
  }
  let lastSig = '', tick = 0;
  function frame() {
    if (!visible()) { cv.remove(); pins.forEach(p => p.lb.show(false)); return; }
    requestAnimationFrame(frame);
    if (++tick % 30 === 0 && sig() !== lastSig) { lastSig = sig(); cache.clear(); days.clear(); paint(); peakTable(); if (!queue) queue = setTimeout(nextDay, 30); }   // alert sensitivity and the Getting out settings have no event
    const gl = $('#gl'); if (!marks || !Sc.project || !gl) return; if (!cv.parentNode) gl.parentNode.insertBefore(cv, $('#labels'));
    const w = gl.clientWidth, h = gl.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1); if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    const P = q => Sc.project(q[0], q[1], 0.05), col = n => css(sec, n);
    x.strokeStyle = col('--rd-lnk'); x.lineWidth = 1.5; for (const [a, b] of marks.links) { const p = P(a), q = P(b); if (p && q) { x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); x.stroke(); } }
    const dots = (list, c, ring) => { x.fillStyle = x.strokeStyle = c; x.lineWidth = 2; for (const q of list) { const p = P(q); if (!p) continue; x.beginPath(); x.arc(p[0], p[1], ring ? 4 : 3.5, 0, 6.2832); ring ? x.stroke() : x.fill(); } };
    dots(marks.drv, col('--rd-drv')); dots(marks.rid, col('--rd-rid')); dots(marks.cty, col('--rd-cty'), true); dots(marks.cut, css(sec, '--t-high'), true);
  }
  /* app.js calls this once: the view adds itself to the view tables. Census, roads and slides come from the area's own data folder (data/ or data_sf/). */
  api.register = a => {
    a.POSES.rides = { px: -0.4, py: 11.4, pz: 10.8, tx: 0, ty: 0, tz: 0 }; a.LOOKS.rides = { risk: 0.8, motion: 0, roads: 1, splitVis: 0, dim: 0.1, bld: 0.4 };
    a.ORDER.splice(Math.max(0, a.ORDER.indexOf('method')), 0, 'rides'); a.NAMES.rides = 'Neighbor rides'; a.SUBS.rides = 'Who needs a ride out, and who could give one · simulated households'; a.SPLIT.rides = 1;
  };

  /* ---- the two views side by side at the January 2023 peak */
  const ROWS = [['Must leave', 'leave'], ['Need a ride', 'ride'], ['Could ride with a neighbor', 'matched'], ['Need the city or volunteers', 'city'], ['Cannot leave by road', 'cut']];
  function peakTable() {
    const a = result(peakSc, 'model'), b = result(peakSc, 'mapped'), tb = $('#rdPeak'); tb.textContent = '';
    for (const [name, k] of ROWS) { const tr = document.createElement('tr'); for (const v of [name, a ? show(a[k]) : 'n/a', b ? show(b[k]) : 'n/a']) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); } tb.appendChild(tr); }
    const out = $('#rdOverlap'), head = `Model column: the ${dayStr(peakDay)} storm preset, ${peakSc.r72} mm in 72 hours on soil wetness ${peakSc.api} mm. `;
    if (!a || !b) { out.textContent = head + 'The mapped-slides column needs the Getting out view, which is not loaded.'; return; }
    let both = 0, onlyB = 0, onlyA = 0; for (let h = 0; h < hh.n; h++) { const x = a.groups[h] !== 1, y = b.groups[h] !== 1; if (x && y) both++; else if (y) onlyB++; else if (x) onlyA++; }
    const nb = both + onlyB;
    out.textContent = head + (nb ? `Overlap: of the ${fmt(nb)} simulated households within ${NEAR_SLIDE_M} m of a recorded slide, ${fmt(both)} (${fmt(both / nb * 100)}%) are also in the model's danger zone, and ${fmt(onlyB)} are not. The model flags ${fmt(onlyA)} more that are near no recorded slide. ` : 'No simulated household is within reach of a recorded slide, so there is no overlap to count. ')
      + 'The model score is a fixed formula that was not fitted to this inventory, so this is not an in-sample check.';
  }

  /* ---- winter 2023, day by day */
  const days = new Map(); let queue = null, daySel = peakDay;
  function nextDay() {
    if (!visible()) { queue = null; return; }
    let d = D0; while (d <= D1 && days.has(d)) d++; if (d > D1) { queue = null; chart(); dayOut(); return; }
    days.set(d, result(loggedSc(d), 'model')); if (d % 6 === 0) chart(); if (d === daySel) dayOut(); queue = setTimeout(nextDay, 0);
  }
  const css = (el, n) => getComputedStyle(el).getPropertyValue(n).trim();
  function chart() {
    const cv = $('#rdChart'); if (!cv.offsetParent) return;
    const box = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.max(10, box.width * dpr); cv.height = Math.max(10, box.height * dpr);
    const x = cv.getContext('2d'), w = box.width, h = box.height, L = 34, Rr = 8, T = 6, B = 20, pw = w - L - Rr, ph = h - T - B, n = D1 - D0 + 1, bw = Math.max(1, pw / n - 1), X = d => L + (d - D0) / n * pw; x.setTransform(dpr, 0, 0, dpr, 0, 0);
    let top = 10; for (const r of days.values()) if (r) top = Math.max(top, r.ride[1] + r.cut[1]);
    x.font = '11px ' + css(cv, '--f-data'); x.fillStyle = css(cv, '--text-3'); x.strokeStyle = css(cv, '--border-1'); x.lineWidth = 1; x.textBaseline = 'middle'; x.textAlign = 'right';
    for (const v of [0, top / 2, top]) { const y = T + ph - v / top * ph; x.beginPath(); x.moveTo(L, y); x.lineTo(w - Rr, y); x.stroke(); x.fillText(fmt(v), L - 6, y); }
    x.textAlign = 'left'; x.textBaseline = 'alphabetic';
    for (let d = D0; d <= D1; d++) { const t = new Date(R23.start + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); if (t.getUTCDate() === 1) x.fillText(MONTHS[t.getUTCMonth()], X(d), h - 5); }
    const cols = [css(sec, '--rd-drv'), css(sec, '--rd-cty'), css(cv, '--t-high')];
    for (let d = D0; d <= D1; d++) { const r = days.get(d); if (!r) continue; let y = T + ph; [r.matched[1], r.ride[1] - r.matched[1], r.cut[1]].forEach((v, k) => { const bh = v / top * ph; x.fillStyle = cols[k]; x.fillRect(X(d), y - bh, bw, bh); y -= bh; }); }
    x.fillStyle = css(cv, '--text-1'); x.fillRect(X(daySel) + bw / 2 - 0.5, T, 1, ph);
  }
  function dayOut() {
    const r = days.get(daySel), s = loggedSc(daySel), out = $('#rdDayOut');
    out.textContent = `${dayStr(daySel)}: ${s.r72} mm logged in 72 hours on soil wetness ${s.api} mm. ` + (r ? `Simulated households: ${show(r.leave)} must leave, ${show(r.ride)} need a ride, ${show(r.matched)} could ride with a neighbor, ${show(r.city)} need the city, ${show(r.cut)} cannot leave by road.` : 'Counting...');
  }
  $('#rdDay').value = daySel; $('#rdDay').addEventListener('input', e => { daySel = +e.target.value; if (!days.has(daySel)) days.set(daySel, result(loggedSc(daySel), 'model')); chart(); dayOut(); });

  /* ---- Census estimates for one block group, with margins of error */
  const simIn = new Int32Array(D.bg.length); for (let h = 0; h < hh.n; h++) simIn[D.bldBg[hh.bld[h]]]++;
  { const pick = $('#rdBgPick'); D.bg.map((g, k) => [g, k]).filter(q => q[0].n).sort((a, b) => a[0].id < b[0].id ? -1 : 1).forEach(([g, k]) => { const o = document.createElement('option'); o.value = k; o.textContent = `Tract ${g.tract}, block group ${g.group}`; pick.appendChild(o); });
    pick.addEventListener('change', () => { if (pick.value !== '') showBg(+pick.value, true); }); }
  function showBg(k, fly) {
    const g = D.bg[k], kv = $('#rdBgKv'); kv.textContent = ''; $('#rdBg').hidden = false; $('#rdBgPick').value = k;
    const pm = v => `${fmt(v[0])} ± ${fmt(v[1])}`;
    for (const [name, v] of [['Households', pm(g.hh)], ['With no vehicle', pm(g.nocar)], ['One person aged 65 or over, living alone', pm(g.alone65)], ['People aged 65 or over', pm(g.age65)], ['People aged 75 or over', pm(g.age75)], ['Adults with a disability', pm(g.dis18)]]) {
      const d = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = name; dd.textContent = v; d.append(dt, dd); kv.appendChild(d); }
    $('#rdBgNote').textContent = `Census tract ${g.tract}, block group ${g.group}. ${D.meta.vintage}. The ± is the published 90% margin of error. ${fmt(simIn[k])} simulated households are placed here on ${fmt(g.n)} residential-sized buildings`
      + (g.frac < 0.995 ? `, because only ${fmt(g.frac * 100)}% of this block group lies inside the map.` : '.');
    if (fly && Sc && Sc.highlight) Sc.highlight(g.lon, g.lat, true);
  }
  { const gl = $('#gl'); let down = null; if (gl && Sc) { gl.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    gl.addEventListener('pointerup', e => { if (!visible() || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; const ll = Sc.pick(e.clientX, e.clientY), k = ll ? bgAt(D, ll[0], ll[1]) : -1; if (k >= 0) showBg(k); }); } }

  $('#rdSrc').textContent = `Census: ${D.meta.vintage}, tables ${Object.keys(D.meta.tables).join(', ')}, by block group. ${fmt(hh.n)} simulated households on ${fmt(D.n)} residential-sized buildings (footprints of ${D.meta.res_m2[0]} to ${fmt(D.meta.res_m2[1])} m²), always drawn with the same seed. ` + (SF ? `The Census pull covers San Francisco County only, so the ${fmt(D.meta.buildings.no_block_group)} buildings south of the county line (Daly City and Brisbane) hold no simulated households. Buildings over ${fmt(D.meta.res_m2[1])} m² are left out as likely not homes, so the households of a block group are spread over its smaller buildings.` : `The Census pull covers Contra Costa County only, so the ${fmt(D.meta.buildings.no_block_group)} buildings on the Alameda County side of the map (the Oakland hills) hold no simulated households and are not counted here.`);

  /* ---- wake up when the view opens */
  function open() { lastSig = sig(); paint(); chart(); peakTable(); dayOut(); if (!queue) queue = setTimeout(nextDay, 30); requestAnimationFrame(frame); }
  new MutationObserver(() => { if (visible()) requestAnimationFrame(open); }).observe(sec, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => { if (visible()) chart(); });
  api.state = () => ({ mode, sc, shown, peakDay, peakSc, days, D, hh });
})();
