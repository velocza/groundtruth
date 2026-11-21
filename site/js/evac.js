/* GroundTruth "Getting out": which homes still have a road out of the map for a given storm, the safest route, and the
   single stretches of road whose failure cuts off the most homes. Checked against the landslides USGS mapped.
   Data: site/data/roads_graph.js (scripts/08_road_graph.py) and site/data/usgs_inventory.js (scripts/10_usgs_inventory.py).
   The first half is plain graph code with no DOM, so tests/evac_test.cjs can run it in node. */
(function (root) {
  'use strict';
  const KX = 87800, KY = 110950;                           // metres per degree here, the same constants as model.js
  const MAP_M = 30;                                        // a recorded slide blocks a road when it lies within this many metres of it
  const RUNOUT_CAP = 300;                                  // debris paths are traced from at most this many source cells per scenario
  const FLOOD_MM = 100, FLOOD_M = 12;                      // creek proxy: roads within 12 m of a stream once 100 mm is forecast in 72 h

  /* ------------------------------------------------ graph (typed arrays; an edge's geometry is a slice of GT.streets) */
  function Graph(R, streets, grid) {
    const nn = R.nodes.length / 2, ne = R.edges.length / 9, [W, S] = grid.bbox, g = { nn, ne, streets, grid, meta: R.meta || {} };
    g.x = new Float32Array(nn); g.y = new Float32Array(nn);
    for (let n = 0; n < nn; n++) { g.x[n] = (R.nodes[n * 2] - W) * KX; g.y[n] = (R.nodes[n * 2 + 1] - S) * KY; }
    for (const k of ['eu', 'ev', 'ek', 'es', 'ea', 'eb', 'b0', 'b1']) g[k] = new Int32Array(ne);
    g.elen = new Float32Array(ne); g.nb = new Int32Array(nn);
    for (let e = 0, p = 0; e < ne; e++, p += 9) {
      g.eu[e] = R.edges[p]; g.ev[e] = R.edges[p + 1]; g.ek[e] = R.edges[p + 2]; g.es[e] = R.edges[p + 3]; g.ea[e] = R.edges[p + 4]; g.eb[e] = R.edges[p + 5];
      g.elen[e] = R.edges[p + 6]; g.b0[e] = R.edges[p + 7]; g.b1[e] = R.edges[p + 8]; g.nb[g.eu[e]] += g.b0[e]; g.nb[g.ev[e]] += g.b1[e];
    }
    g.exits = Int32Array.from(R.exits); g.base = Uint8Array.from(R.base); g.cellOff = Int32Array.from(R.cellOff); g.cells = Int32Array.from(R.cells);
    g.adjOff = new Int32Array(nn + 1);                     // CSR adjacency: the edges at each node
    for (let e = 0; e < ne; e++) { g.adjOff[g.eu[e] + 1]++; g.adjOff[g.ev[e] + 1]++; }
    for (let n = 0; n < nn; n++) g.adjOff[n + 1] += g.adjOff[n];
    g.adjE = new Int32Array(ne * 2); { const at = g.adjOff.slice(0, nn); for (let e = 0; e < ne; e++) { g.adjE[at[g.eu[e]]++] = e; g.adjE[at[g.ev[e]]++] = e; } }
    g.cellEdges = new Map();                               // grid cell -> edges crossing it
    for (let e = 0; e < ne; e++) for (let j = g.cellOff[e]; j < g.cellOff[e + 1]; j++) { const c = g.cells[j], a = g.cellEdges.get(c); if (a) a.push(e); else g.cellEdges.set(c, [e]); }
    g.homes = 0; for (let n = 0; n < nn; n++) if (g.base[n]) g.homes += g.nb[n];      // homes on roads that reach an exit when nothing is blocked
    const xy = new Array(ne);
    g.geom = e => streets[g.ek[e]].g[g.es[e]].slice(g.ea[e], g.eb[e] + 1);
    g.xy = e => xy[e] || (xy[e] = Float32Array.from(g.geom(e).flatMap(p => [(p[0] - W) * KX, (p[1] - S) * KY])));
    g.toXY = (lon, lat) => [(lon - W) * KX, (lat - S) * KY];
    g.name = e => streets[g.ek[e]].n;
    return g;
  }

  /* Shortest way out for every node at once: Dijkstra from all exits over the edges that are not blocked.
     cost[e] steers the search (length, raised on roads that score close to the threshold); metres[] is the real length of that route. */
  function route(g, blocked, cost) {
    const nn = g.nn, dist = new Float64Array(nn).fill(Infinity), metres = new Float32Array(nn).fill(Infinity), next = new Int32Array(nn).fill(-1), reach = new Uint8Array(nn);
    const hn = [], hd = []; let hs = 0;
    const push = (n, d) => { let i = hs++; while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hn[i] = hn[p]; hd[i] = hd[p]; i = p; } hn[i] = n; hd[i] = d; };
    const pop = () => { const n = hn[0], ln = hn[--hs], ld = hd[hs]; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hs) break; if (c + 1 < hs && hd[c + 1] < hd[c]) c++; if (hd[c] >= ld) break; hn[i] = hn[c]; hd[i] = hd[c]; i = c; } hn[i] = ln; hd[i] = ld; return n; };
    for (const x of g.exits) { dist[x] = 0; metres[x] = 0; push(x, 0); }
    while (hs) {
      const d0 = hd[0], n = pop(); if (d0 > dist[n]) continue; reach[n] = 1;
      for (let j = g.adjOff[n]; j < g.adjOff[n + 1]; j++) {
        const e = g.adjE[j]; if (blocked && blocked[e]) continue;
        const m = g.eu[e] === n ? g.ev[e] : g.eu[e], d = d0 + (cost ? cost[e] : g.elen[e]);
        if (d < dist[m]) { dist[m] = d; metres[m] = metres[n] + g.elen[e]; next[m] = e; push(m, d); }
      }
    }
    return { dist, metres, next, reach };
  }
  function pathFrom(g, r, n) {                             // edges from a node to its exit, in travel order
    const out = []; if (!r.reach[n]) return out;
    for (let guard = 0; r.next[n] >= 0 && guard < g.nn; guard++) { const e = r.next[n]; out.push(e); n = g.eu[e] === n ? g.ev[e] : g.eu[e]; }
    out.exit = n; return out;
  }
  function pathLine(g, edges, n) {                         // one polyline along a path, each edge turned to follow the direction of travel
    const pts = [];
    for (const e of edges) { let q = g.geom(e); if (g.eu[e] !== n) q = q.slice().reverse(); for (let k = pts.length ? 1 : 0; k < q.length; k++) pts.push(q[k]); n = g.eu[e] === n ? g.ev[e] : g.eu[e]; }
    return pts;
  }

  /* Single points of failure: bridges of the graph once every exit is tied to one outside root (Tarjan, iterative).
     cut[e] = homes whose every route out uses edge e. far[e] is the node on the cut-off side; tin/tout mark its subtree. */
  function bridges(g) {
    const nn = g.nn, disc = new Int32Array(nn).fill(-1), low = new Int32Array(nn), pe = new Int32Array(nn).fill(-1), sub = new Int32Array(nn), tout = new Int32Array(nn);
    const isBridge = new Uint8Array(g.ne), cut = new Int32Array(g.ne), far = new Int32Array(g.ne).fill(-1), st = new Int32Array(nn), it = new Int32Array(nn); let t = 0;
    const isExit = new Uint8Array(nn); for (const x of g.exits) isExit[x] = 1;
    for (const x of g.exits) {
      if (disc[x] >= 0) continue;
      let sp = 0; st[0] = x; it[x] = g.adjOff[x]; disc[x] = ++t; low[x] = 0; sub[x] = g.nb[x];      // low 0: an exit always has its own way to the root
      while (sp >= 0) {
        const n = st[sp];
        if (it[n] < g.adjOff[n + 1]) {
          const e = g.adjE[it[n]++]; if (e === pe[n]) continue;
          const m = g.eu[e] === n ? g.ev[e] : g.eu[e]; if (m === n) continue;
          if (disc[m] < 0) { disc[m] = ++t; low[m] = isExit[m] ? 0 : disc[m]; pe[m] = e; sub[m] = g.nb[m]; it[m] = g.adjOff[m]; st[++sp] = m; }
          else if (disc[m] < low[n]) low[n] = disc[m];
        } else {
          tout[n] = t; sp--;
          if (sp >= 0) { const p = st[sp], e = pe[n]; if (low[n] < low[p]) low[p] = low[n]; sub[p] += sub[n]; if (low[n] > disc[p]) { isBridge[e] = 1; cut[e] = sub[n]; far[e] = n; } }
        }
      }
    }
    return { isBridge, cut, far, tin: disc, tout };
  }

  /* ------------------------------------------------ distance rule for recorded slides */
  function ptSeg(px, py, ax, ay, bx, by) { const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0; return Math.hypot(px - ax - dx * t, py - ay - dy * t); }
  function segSeg(a, b, c, d, e, f, g_, h) {               // distance between segments (a,b)-(c,d) and (e,f)-(g,h)
    const o = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
    if (o(a, b, c, d, e, f) !== o(a, b, c, d, g_, h) && o(e, f, g_, h, a, b) !== o(e, f, g_, h, c, d)) return 0;
    return Math.min(ptSeg(a, b, e, f, g_, h), ptSeg(c, d, e, f, g_, h), ptSeg(e, f, a, b, c, d), ptSeg(g_, h, a, b, c, d));
  }
  /* edges within `dist` metres of a point [lon,lat] or a segment [lon,lat,lon,lat]; returns [edge, metres] pairs */
  function edgesWithin(g, f, dist) {
    const [x0, y0] = g.toXY(f[0], f[1]), [x1, y1] = f.length > 2 ? g.toXY(f[2], f[3]) : [x0, y0], G = g.grid, [W, S, E, N] = G.bbox;
    const cw = (E - W) * KX / G.NX, ch = (N - S) * KY / G.NY, H = (N - S) * KY;
    const c0 = Math.floor((Math.min(x0, x1) - dist) / cw) - 1, c1 = Math.floor((Math.max(x0, x1) + dist) / cw) + 1, r0 = Math.floor((H - Math.max(y0, y1) - dist) / ch) - 1, r1 = Math.floor((H - Math.min(y0, y1) + dist) / ch) + 1;
    const seen = new Set(), out = [];
    for (let r = Math.max(0, r0); r <= Math.min(G.NY - 1, r1); r++) for (let c = Math.max(0, c0); c <= Math.min(G.NX - 1, c1); c++) {
      const es = g.cellEdges.get(r * G.NX + c); if (!es) continue;
      for (const e of es) { if (seen.has(e)) continue; seen.add(e); const q = g.xy(e); let d = Infinity; for (let k = 0; k + 3 < q.length && d > 0; k += 2) d = Math.min(d, segSeg(x0, y0, x1, y1, q[k], q[k + 1], q[k + 2], q[k + 3])); if (d <= dist) out.push([e, d]); }
    }
    return out;
  }
  function mappedEdges(g, feats, dist) {                   // flag[e] = 1 + index of the nearest recorded feature within dist, 0 if none
    const flag = new Int32Array(g.ne), best = new Float32Array(g.ne).fill(Infinity), touch = new Array(feats.length);
    feats.forEach((f, i) => { const hit = edgesWithin(g, f, dist); touch[i] = hit.map(h => h[0]); for (const [e, d] of hit) if (d < best[e]) { best[e] = d; flag[e] = i + 1; } });
    return { flag, touch };
  }

  /* ------------------------------------------------ hazards: a list, each one says blocked (with a reason) or clear for an edge
     env: { g, score(i, sc), runout(i) -> {path}, srcCells, stream(i) metres to a stream, mapped (Int32 per edge), opts: { thr } } */
  function makeHazards(env) {
    const g = env.g, roadCells = Int32Array.from(g.cellEdges.keys()), cellPos = new Map(); roadCells.forEach((c, j) => cellPos.set(c, j));
    const roadVal = new Float32Array(roadCells.length), ro = new Map();
    const slide = { id: 'slide', kind: 'model', label: 'Landslide score on the road', max: new Float32Array(g.ne),
      prepare(sc) {                                        // highest score of any cell the edge crosses
        for (let j = 0; j < roadCells.length; j++) roadVal[j] = env.score(roadCells[j], sc);
        for (let e = 0; e < g.ne; e++) { let m = 0; for (let j = g.cellOff[e]; j < g.cellOff[e + 1]; j++) { const v = roadVal[cellPos.get(g.cells[j])]; if (v > m) m = v; } this.max[e] = m; }
      },
      blocks(sc, e) { return this.max[e] >= env.opts.thr ? 'the road itself scores ' + Math.round(this.max[e]) : null; } };
    const runout = { id: 'runout', kind: 'model', label: 'Debris runout from the slope above', hit: new Int32Array(g.ne), n: 0,
      prepare(sc) {                                        // trace the downhill path of the highest-scoring source cells near roads; a path is terrain only, so it is cached for good
        this.hit.fill(-1); this.n = 0; if (!env.srcCells || !env.runout) return;
        const top = []; for (let j = 0; j < env.srcCells.length; j++) { const i = env.srcCells[j], v = env.score(i, sc); if (v >= env.opts.thr) top.push([v, i]); }
        if (top.length > RUNOUT_CAP) { top.sort((a, b) => b[0] - a[0]); top.length = RUNOUT_CAP; } this.n = top.length;
        for (const [, i] of top) {
          let es = ro.get(i);
          if (!es) { const set = new Set(), p = env.runout(i).path; for (let k = 1; k < p.length; k++) { const a = g.cellEdges.get(p[k]); if (a) for (const e of a) set.add(e); } es = Int32Array.from(set); ro.set(i, es); }
          for (const e of es) if (this.hit[e] < 0) this.hit[e] = i;
        }
      },
      blocks(sc, e) { return this.hit[e] >= 0 ? 'it lies in the debris path from a slope above' : null; } };
    const mapped = { id: 'mapped23', kind: 'observed', label: 'Recorded winter 2023 slides',
      blocks(sc, e) { return env.mapped && env.mapped[e] ? 'a slide was recorded within ' + MAP_M + ' m in winter 2023' : null; } };
    const flood = { id: 'flood', kind: 'proxy', label: 'Creek flooding (screening proxy, not validated)', near: null,
      prepare() { if (this.near || !env.stream) return; this.near = new Uint8Array(g.ne); for (let e = 0; e < g.ne; e++) for (let j = g.cellOff[e]; j < g.cellOff[e + 1]; j++) if (env.stream(g.cells[j]) < FLOOD_M) { this.near[e] = 1; break; } },
      blocks(sc, e) { return this.near && sc.r72 >= FLOOD_MM && this.near[e] ? 'it runs within ' + FLOOD_M + ' m of a creek with ' + FLOOD_MM + ' mm or more forecast (proxy)' : null; } };
    /* Wildfire: deliberately not modelled. A fire hazard would be one more entry here with the same shape,
       { id: 'fire', kind: 'model', label, prepare(sc), blocks(sc, e) -> reason or null }, fed by a real fire-spread or perimeter source. */
    return [slide, runout, mapped, flood];
  }

  /* One scenario: block edges with the active hazards, search out from the exits, count who is left without a route. */
  function evaluate(env, hazards, sc, active) {
    const g = env.g, blocked = new Uint8Array(g.ne), why = new Int8Array(g.ne).fill(-1), counts = {}, use = hazards.filter(h => active.includes(h.id));
    for (const h of use) { if (h.prepare) h.prepare(sc); counts[h.id] = 0; }
    const reasons = new Map();                             // kept per result: the hazard objects are reused by the next scenario
    for (let e = 0; e < g.ne; e++) for (const h of use) { const rs = h.blocks(sc, e); if (rs) { blocked[e] = 1; why[e] = hazards.indexOf(h); counts[h.id]++; reasons.set(e, rs); break; } }
    let cost = null; const sl = use.find(h => h.id === 'slide');
    if (sl) { cost = new Float32Array(g.ne); for (let e = 0; e < g.ne; e++) { const q = sl.max[e] / env.opts.thr; cost[e] = g.elen[e] * (1 + q * q); } }   // prefer roads that score well below the threshold
    const r = route(g, blocked, cost); let stranded = 0, nBlocked = 0; const byStreet = new Map();
    for (let e = 0; e < g.ne; e++) {
      nBlocked += blocked[e];
      const u = g.eu[e], v = g.ev[e], n = (g.base[u] && !r.reach[u] ? g.b0[e] : 0) + (g.base[v] && !r.reach[v] ? g.b1[e] : 0);   // only homes that had a route when nothing was blocked
      if (n) { stranded += n; byStreet.set(g.ek[e], (byStreet.get(g.ek[e]) || 0) + n); }
    }
    return { sc, blocked, why, counts, nBlocked, stranded, byStreet, streetsCut: byStreet.size, r, cost,
      reason: e => reasons.get(e) || null, hazardOf: e => why[e] < 0 ? null : hazards[why[e]] };
  }
  /* blocked edges on the rim of the area a node is shut into */
  function blockers(g, ev, n) {
    const seen = new Uint8Array(g.nn), q = [n], out = new Set(); seen[n] = 1;
    while (q.length) { const a = q.pop(); for (let j = g.adjOff[a]; j < g.adjOff[a + 1]; j++) { const e = g.adjE[j]; if (ev.blocked[e]) { out.add(e); continue; } const m = g.eu[e] === a ? g.ev[e] : g.eu[e]; if (!seen[m]) { seen[m] = 1; q.push(m); } } }
    return [...out];
  }
  const auc = (pos, neg) => {                              // chance that a value from pos beats one from neg (ties count half)
    if (!pos.length || !neg.length) return null; const all = pos.map(v => [v, 1]).concat(neg.map(v => [v, 0])).sort((a, b) => a[0] - b[0]); let rs = 0;
    for (let i = 0; i < all.length;) { let j = i; while (j < all.length && all[j][0] === all[i][0]) j++; const rk = (i + j + 1) / 2; for (let k = i; k < j; k++) if (all[k][1]) rs += rk; i = j; }
    return (rs - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
  };
  function pointInRing(lon, lat, ring) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > lat) !== (b[1] > lat) && lon < (b[0] - a[0]) * (lat - a[1]) / (b[1] - a[1]) + a[0]) ins = !ins; } return ins; }

  const core = { Graph, route, pathFrom, pathLine, bridges, edgesWithin, mappedEdges, makeHazards, evaluate, blockers, auc, pointInRing, MAP_M, RUNOUT_CAP, FLOOD_MM, FLOOD_M };
  const API = root.GTEvac = { core };
  if (!root.document) return;

  /* ================================================ browser: model binding, validation, panel */
  const $ = s => document.querySelector(s), fmt = (v, d) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayOf = (start, iso) => Math.round((new Date(iso + 'T12:00:00Z') - new Date(start + 'T12:00:00Z')) / 864e5);
  const dateOf = (start, d) => { const t = new Date(start + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t; };
  const dstr = t => `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`;
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many || one + 's'}`;
  const listNames = (xs, n) => { const u = [...new Set(xs)]; return u.slice(0, n).join(', ') + (u.length > n ? ` and ${u.length - n} more` : ''); };

  let app = null, Mo, Sc, G, U_, g, env, hazards, br, spof, ready = false, on = false;
  const st = { mode: 'model', thr: 50, flood: false, local: true, ev: null, pickNode: -1, timer: 0, key: '', mine: false };

  /* The one place this view reads the hazard score. It is the score the map draws (GTModel.index, with the map's alert
     sensitivity and real-data switch), so when the model team changes what the map shows, change this line only. */
  const hazardScore = (i, sc) => Mo.index(i, sc);

  API.register = function (a) {                            // called once from app.js: adds this view to its tables, then waits to be opened
    app = a; Mo = root.GTModel; Sc = root.GTScene; G = root.GT; U_ = root.GT_USGS;
    if (!$('#evac') || !root.GT_ROADS || !U_) return;
    a.POSES.evac = { px: -0.6, py: 11.4, pz: 11.2, tx: 0, ty: 0, tz: 0 }; a.LOOKS.evac = { risk: 0.8, motion: 0, roads: 1, splitVis: 0, dim: 0.12, bld: 0.9 };
    a.ORDER.splice(Math.max(0, a.ORDER.indexOf('method')), 0, 'evac'); a.NAMES.evac = 'Getting out'; a.SUBS.evac = 'Which homes still have a road out in this storm'; a.SPLIT.evac = 1;
    new MutationObserver(() => { const now = $('#evac').classList.contains('on'); if (now !== on) { on = now; now ? open() : close(); } }).observe($('#evac'), { attributes: true, attributeFilter: ['class'] });
    setInterval(() => { if (on && ready && key() !== st.key) recompute(); }, 600);      // alert sensitivity and the real-data switch live in app.js and have no event
  };
  API.onStorm = function () { if (!on) return; const x = $('#evR72'); if (x && app) { x.value = app.S.r72; $('#evR72v').textContent = app.S.r72; } clearTimeout(st.timer); st.timer = setTimeout(recompute, 110); };
  API.pick = function (lon, lat) { if (ready) selectAt(lon, lat); };
  API.active = () => on;

  /* ------------------------------------------------ set-up, on first open */
  let F23 = [], F17 = [], m23, m17, in17, slopeMax, labels = [], surveyed;
  function init() {
    g = Graph(root.GT_ROADS, G.streets, { bbox: Mo.bbox, NX: Mo.NX, NY: Mo.NY });
    // recorded winter 2023 slides: the USGS reconnaissance points inside the box, and the ten local reports the site already carries
    F23 = U_.p23.map(p => ({ f: [p[0], p[1]], src: 'usgs', label: 'USGS mapped · ' + shortDate(p[5]) + (p[3] === 'RC' ? ' · road cut' : ' · hillslope'), what: p[7], day: dayOf(G.rain.wy2023.start, usDate(p[5])) }))
      .concat(G.events.map(e => ({ f: e.lonlat, src: 'local', label: 'Local report · ' + shortIso(e.date) + ' · ' + (e.where.length > 26 ? e.where.slice(0, 24) + '...' : e.where), what: e.what, day: dayOf(G.rain.wy2023.start, e.date), where: e.where })));
    m23 = mappedEdges(g, F23.map(f => f.f), MAP_M); F23.forEach((f, i) => f.edges = m23.touch[i]);
    F17 = U_.s17; m17 = mappedEdges(g, F17.map(s => [s[4], s[5], s[6], s[7]]), MAP_M);
    in17 = new Uint8Array(g.ne); slopeMax = new Float32Array(g.ne);
    for (let e = 0; e < g.ne; e++) {
      const q = g.geom(e), m = q[q.length >> 1]; in17[e] = U_.bound17.some(b => pointInRing(m[0], m[1], b.ring)) ? 1 : 0;
      let s = 0; for (let j = g.cellOff[e]; j < g.cellOff[e + 1]; j++) s = Math.max(s, Mo.L.slope[g.cells[j]]); slopeMax[e] = s;
    }
    surveyed = new Uint8Array(g.ne);                       // roads the USGS crews drove in January 2023 (within 50 m of a travel line)
    for (const ln of U_.travel23) for (let k = 0; k + 1 < ln.length; k++) for (const [e] of edgesWithin(g, [ln[k][0], ln[k][1], ln[k + 1][0], ln[k + 1][1]], 50)) surveyed[e] = 1;
    // debris sources worth tracing: cells within about 290 m of a road
    const near = new Uint8Array(Mo.N), R = 10;
    for (const c of g.cellEdges.keys()) { const r = Math.floor(c / Mo.NX), cc = c % Mo.NX; for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) { const rr = r + dr, c2 = cc + dc; if (rr >= 0 && c2 >= 0 && rr < Mo.NY && c2 < Mo.NX && dr * dr + dc * dc <= R * R) near[rr * Mo.NX + c2] = 1; } }
    const src = []; for (let i = 0; i < Mo.N; i++) if (near[i] && Mo.L.slope[i] >= 8) src.push(i);      // under 8 degrees the score has no slope term to speak of
    env = { g, score: hazardScore, runout: i => Mo.runout(i), srcCells: Int32Array.from(src), stream: i => Mo.L.dstream[i], mapped: null, opts: { thr: st.thr } };
    hazards = makeHazards(env); setMapped();
    br = bridges(g); spof = rankSpof();
    F23.forEach(f => { const el = document.createElement('div'); el.className = 'pin-label evac-mk ' + f.src; el.textContent = f.label; el.hidden = true; $('#labels').appendChild(el); f.lb = Sc.addLabel(f.f[0], f.f[1], el, 0.07); });
    wire(); renderStatic(); ready = true;
  }
  const usDate = s => { const m = String(s).match(/(\d+)\/(\d+)\/(\d+)/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : '2023-01-01'; };
  const shortDate = s => { const t = new Date(usDate(s) + 'T12:00:00Z'); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}, ${t.getUTCFullYear()}`; };
  const shortIso = s => { const t = new Date(s + 'T12:00:00Z'); return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`; };
  function setMapped(upToDay) {                            // which recorded slides count: all sources or USGS only, optionally only those reported by a given day
    const m = new Int32Array(g.ne); F23.forEach((f, i) => { if ((st.local || f.src === 'usgs') && (upToDay == null || f.day <= upToDay)) for (const e of f.edges) m[e] = i + 1; }); env.mapped = m;
  }
  const activeIds = mode => (mode === 'mapped' ? ['mapped23'] : mode === 'both' ? ['slide', 'runout', 'mapped23'] : ['slide', 'runout']).concat(st.flood && mode !== 'mapped' ? ['flood'] : []);
  const key = () => [app.S.r72, app.S.api, Mo.opts.bias, Mo.opts.motion, st.thr, st.mode, st.flood, st.local].join('|');
  const run = (sc, mode) => { env.opts.thr = st.thr; return evaluate(env, hazards, sc, activeIds(mode || st.mode)); };

  /* Roads that are a single way out, grouped by street: the worst point, and how much of the street is that critical. */
  function rankSpof() {
    const by = new Map();
    for (let e = 0; e < g.ne; e++) if (br.isBridge[e] && br.cut[e] > 0) { const k = g.ek[e], o = by.get(k); if (!o) by.set(k, { k, e, cut: br.cut[e], es: [e] }); else { o.es.push(e); if (br.cut[e] > o.cut) { o.cut = br.cut[e]; o.e = e; } } }
    const out = [...by.values()].map(o => { const es = o.es.filter(e => br.cut[e] >= o.cut * 0.5); return { ...o, es, len: es.reduce((a, e) => a + g.elen[e], 0), s23: es.some(e => m23.flag[e]), s17: es.filter(e => m17.flag[e]).length, in17: es.some(e => in17[e]) }; });
    return out.sort((a, b) => b.cut - a.cut);
  }
  const behind = e => { const c = br.far[e], a = br.tin[c], b = br.tout[c], ks = new Map(); for (let x = 0; x < g.ne; x++) { const u = g.eu[x], v = g.ev[x], n = (br.tin[u] >= a && br.tin[u] <= b ? g.b0[x] : 0) + (br.tin[v] >= a && br.tin[v] <= b ? g.b1[x] : 0); if (n) ks.set(g.ek[x], (ks.get(g.ek[x]) || 0) + n); } return [...ks].sort((p, q) => q[1] - p[1]); };

  /* ------------------------------------------------ scenarios from the gauge record
     "Only rain logged up to that day": each gauge value covers the 24 h up to that morning, so for a state on day `rep`
     the 72 h total started on day d may only count values up to rep. Uses replayBefore from app.js when main has it (PR #1). */
  const upTo = (rec, d, rep) => { let s = 0; for (let j = d + 1; j <= Math.min(d + 3, rep); j++) s += rec.mm[j] || 0; return s; };
  const before23 = (d, rep) => app.replayBefore ? app.replayBefore(d, rep) : { ...app.replaySc(d), r72: upTo(G.rain.wy2023, d, rep) };
  const before = (d, rep) => ({ r72: upTo(root.GT_RAIN, d, rep), api: root.GT_RAIN.api[d], era: 0, amt: 0 });
  function worstOf(scs, mode) { let best = null; for (const sc of scs) { const r = run(sc, mode); if (!best || r.stranded > best.stranded || (r.stranded === best.stranded && r.nBlocked > best.nBlocked)) best = r; } return best; }
  const day23 = (D, mode) => worstOf([before23(D - 3, D), before23(D - 2, D), before23(D - 1, D)], mode);     // the same three look-back days the backtest uses

  /* ------------------------------------------------ checks against the USGS inventories. Real inputs only: the simulated ground motion is switched off here. */
  let valCache = {};
  function validate() {
    const k = Mo.opts.bias + '|' + st.thr + '|' + st.local; if (valCache[k]) return valCache[k];
    const mo = Mo.opts.motion, mode = st.mode, fl = st.flood; Mo.opts.motion = 0; st.flood = false; setMapped();
    try {
      const R23 = G.rain.wy2023, D0 = dayOf(R23.start, '2022-12-31'), D1 = dayOf(R23.start, '2023-01-18'), out = { thr: st.thr, bias: Mo.opts.bias };
      // 2023: the wettest day inside the USGS window, by what the model strands
      let peak = null, pd = D0; for (let D = D0; D <= D1; D++) { const r = day23(D, 'model'); if (!peak || r.stranded > peak.stranded || (r.stranded === peak.stranded && r.nBlocked > peak.nBlocked)) { peak = r; pd = D; } }
      const onRoad = F23.map((f, i) => ({ f, i })).filter(o => o.f.edges.length && (st.local || o.f.src === 'usgs')), K = peak.nBlocked;
      const steep = topK(slopeMax, K, null), hitS = o => o.f.edges.some(e => peak.blocked[e]), hitB = o => o.f.edges.some(e => steep[e]);
      let unconf = 0, unconfSurveyed = 0; for (let e = 0; e < g.ne; e++) if (peak.blocked[e] && !env.mapped[e]) { unconf++; if (surveyed[e]) unconfSurveyed++; }
      const mappedOnly = run(peak.sc, 'mapped');
      out.y23 = { day: dstr(dateOf(R23.start, pd)), rain: Math.round(peak.sc.r72), api: Math.round(peak.sc.api), recorded: F23.filter(f => st.local || f.src === 'usgs').length, usgs: F23.filter(f => f.src === 'usgs').length, onRoad: onRoad.length,
        hits: onRoad.filter(hitS).length, misses: onRoad.filter(o => !hitS(o)).length, missed: onRoad.filter(o => !hitS(o)).map(o => o.f.where || 'Butters Road (USGS)'), blocked: K, unconfirmed: unconf, unconfirmedSurveyed: unconfSurveyed,
        slopeHits: onRoad.filter(hitB).length, strandedModel: peak.stranded, streetsModel: peak.streetsCut, strandedMapped: mappedOnly.stranded, streetsMapped: mappedOnly.streetsCut, blockedMapped: mappedOnly.nBlocked,
        surveyedKm: U_.meta.y2023.travel_km_inside, totalPoints: U_.meta.y2023.total };
      // 2016-17: the three wettest separate storms of that season up to the March 11, 2017 imagery, blocked roads pooled
      const RL = root.GT_RAIN, a = dayOf(RL.start, '2016-10-01'), b = dayOf(RL.start, '2017-03-11') - 3, days = [];
      const order = Array.from({ length: b - a + 1 }, (_, i) => a + i).sort((p, q) => Mo.Tof(before(q, q + 3)) - Mo.Tof(before(p, p + 3)));
      for (const d of order) { if (days.length >= 3) break; if (days.every(x => Math.abs(x - d) >= 14)) days.push(d); }
      const pool = new Uint8Array(g.ne); let top = null; for (const d of days) { const r = run(before(d, d + 3), 'model'); if (!top) top = r; for (let e = 0; e < g.ne; e++) if (r.blocked[e]) pool[e] = 1; }
      let nIn = 0, nMap = 0, hit = 0, miss = 0, un = 0, k17 = 0; const pos = [], neg = [], posS = [], negS = [], sl = hazards[0]; sl.prepare(top.sc);
      for (let e = 0; e < g.ne; e++) { if (!in17[e]) continue; nIn++; const m = m17.flag[e] > 0; if (pool[e]) k17++; if (m) { nMap++; pool[e] ? hit++ : miss++; pos.push(sl.max[e]); posS.push(slopeMax[e]); } else { if (pool[e]) un++; neg.push(sl.max[e]); negS.push(slopeMax[e]); } }
      const steep17 = topK(slopeMax, k17, in17); let sh = 0; for (let e = 0; e < g.ne; e++) if (steep17[e] && m17.flag[e]) sh++;
      out.y17 = { storms: days.map(d => ({ date: dstr(dateOf(RL.start, d + 3)), rain: Math.round(before(d, d + 3).r72), api: Math.round(RL.api[d]) })), polygons: F17.length, total: U_.meta.y2017.total, segments: nIn, mapped: nMap, blocked: k17, hits: hit, misses: miss, unconfirmed: un,
        slopeHits: sh, auc: auc(pos, neg), aucSlope: auc(posS, negS) };
      // runout: the model's debris path against the mapped length and direction of the longer 2016-17 slides (the 2023 release has no slide paths)
      const errs = [], angs = [], lens = [];
      for (const s of F17) { if (s[3] < 60) continue; const i0 = Mo.cellOf(s[4], s[5]), i1 = Mo.cellOf(s[6], s[7]); if (i0 < 0 || i1 < 0 || i0 === i1) continue; const up = Mo.L.elev[i0] >= Mo.L.elev[i1], head = up ? i0 : i1, toe = up ? [s[6], s[7]] : [s[4], s[5]], hd = up ? [s[4], s[5]] : [s[6], s[7]];
        const r = Mo.runout(head), end = Mo.lonlatOf(r.path[r.path.length - 1]); errs.push(r.length - s[3]); lens.push(s[3]);
        const b1 = Math.atan2((toe[0] - hd[0]) * KX, (toe[1] - hd[1]) * KY), b2 = Math.atan2((end[0] - hd[0]) * KX, (end[1] - hd[1]) * KY); let da = Math.abs(b1 - b2) * 180 / Math.PI; if (da > 180) da = 360 - da; if (r.path.length > 1) angs.push(da); }
      const med = xs => { const v = xs.slice().sort((p, q) => p - q); return v.length ? (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2 : null; };
      out.runout = { n: errs.length, medErr: med(errs), medAbsErr: med(errs.map(Math.abs)), medAngle: med(angs), medLen: med(lens), medAll: med(F17.map(s => s[3])) };
      out.spof = spof.slice(0, 3).map(o => ({ street: G.streets[o.k].n, town: G.streets[o.k].t, homes: o.cut, metres: Math.round(o.len), slide2023: o.s23, slide2017: o.s17 }));
      out.graph = g.meta;
      return valCache[k] = out;
    } finally { Mo.opts.motion = mo; st.mode = mode; st.flood = fl; setMapped(); }
  }
  function topK(vals, K, mask) { const idx = []; for (let e = 0; e < vals.length; e++) if (!mask || mask[e]) idx.push(e); idx.sort((p, q) => vals[q] - vals[p]); const f = new Uint8Array(vals.length); for (let j = 0; j < Math.min(K, idx.length); j++) f[idx[j]] = 1; return f; }
  API.validate = validate; API.state = () => ({ st, ev: st.ev, g, br, spof, F23, hazards, run, day23, before23 });
  /* Read-only surface for other views (all typed arrays are indexed by node or by edge; do not write to them).
     graph(): { nn, ne, x, y (metres from the SW corner), eu, ev, elen, b0, b1, nb, exits, base, geom(e), name(e) } plus lonlat(n).
     scenario(sc, mode): mode is 'model', 'mapped' or 'both'. Returns blocked[e], why[e], reason(e), next[n] (edge to take, -1 at an exit,
       -2 when cut off), metres[n] to the exit, reach[n], stranded, byStreet, and dangerCells: grid cells at or above the threshold plus the traced debris paths. */
  API.ensure = () => { if (!ready && app) init(); return ready; };
  API.graph = () => API.ensure() ? Object.assign(Object.create(g), { lonlat }) : null;
  API.nodeAt = (lon, lat) => API.ensure() ? nodeAt(lon, lat) : -1;
  API.usgs = () => ({ recorded2023: F23.map(f => ({ lonlat: f.f, source: f.src, label: f.label, day: f.day, edges: f.edges })), mapDistanceM: MAP_M });
  API.rainBefore = (d, rep) => before23(d, rep);
  API.scenario = function (sc, mode) {
    if (!API.ensure()) return null; setMapped(); const ev = run({ era: 0, amt: 0, ...sc }, mode || 'model'), next = Int32Array.from(ev.r.next);
    for (let n = 0; n < g.nn; n++) if (!ev.r.reach[n]) next[n] = -2;
    const danger = new Set(); if (mode !== 'mapped') { for (const c of g.cellEdges.keys()) if (hazardScore(c, ev.sc) >= st.thr) danger.add(c); const ro = hazards[1]; for (let e = 0; e < g.ne; e++) if (ro.hit[e] >= 0) { danger.add(ro.hit[e]); for (const c of Mo.runout(ro.hit[e]).path) danger.add(c); } }
    return { threshold: st.thr, blocked: ev.blocked, why: ev.why, reason: ev.reason, next, metres: ev.r.metres, reach: ev.r.reach, stranded: ev.stranded, byStreet: ev.byStreet, nBlocked: ev.nBlocked, counts: ev.counts, dangerCells: Int32Array.from(danger) };
  };

  /* ------------------------------------------------ panel */
  function open() { if (!ready) { try { init(); } catch (err) { console.error(err); $('#evNote').textContent = 'The road network could not be built in this browser.'; return; } } const x = $('#evR72'); x.value = app.S.r72; $('#evR72v').textContent = app.S.r72; recompute(); replayLine(); setTimeout(renderValidation, 60); }
  function close() { clearTimeout(st.timer); F23.forEach(f => f.lb && f.lb.show(false)); labels.forEach(l => l.show(false)); if (st.mine) { Sc.showStreet(null); Sc.showPath(null); Sc.highlight(0, 0, false); st.mine = false; } }
  function recompute() {
    if (!on || !ready) return; const t0 = performance.now(); st.key = key(); setMapped();
    const ev = st.ev = run({ r72: app.S.r72, api: app.S.api, era: 0, amt: 0 }); ev.ms = performance.now() - t0; API.lastMs = ev.ms;
    $('#evStranded').textContent = fmt(ev.stranded); $('#evStreets').textContent = fmt(ev.streetsCut); $('#evBlocked').textContent = fmt(ev.nBlocked);
    const parts = hazards.filter(h => h.id in ev.counts).map(h => `${h.label}: ${fmt(ev.counts[h.id])}`);
    $('#evHaz').textContent = (ev.nBlocked ? 'Road segments blocked, each counted under the first cause in this order. ' + parts.join('. ') + '. ' : 'No road segment is blocked at this setting. ')
      + `Counted over ${fmt(g.homes)} buildings on ${fmt(g.ne)} road segments. Storm: ${app.S.r72} mm in 72 hours on soil wetness ${app.S.api}.` + (st.mode !== 'model' ? ' Recorded slides are what was reported that winter, not a forecast, and do not change with the storm.' : '');
    const show = st.mode !== 'model'; F23.forEach(f => f.lb.show(show && (st.local || f.src === 'usgs')));
    renderCut(); draw(); if (st.pickNode >= 0) showRoute(st.pickNode, true);
  }
  function draw() { const segs = []; for (let e = 0; e < g.ne; e++) if (st.ev.blocked[e]) segs.push(g.geom(e)); Sc.showStreet(segs.length ? segs : null); st.mine = true; }
  function renderCut() {
    const ul = $('#evCut'); ul.textContent = ''; const rows = [...st.ev.byStreet].sort((a, b) => b[1] - a[1]).slice(0, 10);
    $('#evCutNote').textContent = rows.length ? 'Grouped by the street the buildings stand on. Press one to see what blocks it.' : 'No street is cut off at this setting.';
    for (const [k, n] of rows) { const s = G.streets[k], li = document.createElement('li'), b = document.createElement('button'); b.innerHTML = '<span class="nm"></span><span class="tw"></span><span class="tier High"></span>';
      b.children[0].textContent = s.n; b.children[1].textContent = s.t; b.children[2].textContent = plural(n, 'building'); b.setAttribute('aria-label', `${s.n}, ${s.t}: ${plural(n, 'building')} with no road out. Show on map.`);
      b.addEventListener('click', () => selectStreet(k)); li.appendChild(b); ul.appendChild(li); }
  }
  /* nearest road to a clicked place, then the nearer end of that piece of road */
  function nodeAt(lon, lat) { const hit = edgesWithin(g, [lon, lat], 250); if (!hit.length) return -1; hit.sort((a, b) => a[1] - b[1]); const e = hit[0][0], [x, y] = g.toXY(lon, lat), u = g.eu[e], v = g.ev[e]; return Math.hypot(g.x[u] - x, g.y[u] - y) <= Math.hypot(g.x[v] - x, g.y[v] - y) ? u : v; }
  function selectAt(lon, lat) { const n = nodeAt(lon, lat); if (n < 0) { $('#evRoute').textContent = 'No named street within 250 m of that spot.'; return; } showRoute(n); }
  function streetNode(k) {                                 // a stranded point on the street if there is one, else its point farthest from an exit
    let best = -1, bv = -1; for (let e = 0; e < g.ne; e++) if (g.ek[e] === k) for (const n of [g.eu[e], g.ev[e]]) { const v = (g.base[n] && !st.ev.r.reach[n] ? 1e9 + g.nb[n] : isFinite(st.ev.r.metres[n]) ? st.ev.r.metres[n] : 0); if (v > bv) { bv = v; best = n; } }
    return best;
  }
  function selectStreet(k) { const n = streetNode(k); if (n >= 0) showRoute(n, false, G.streets[k].n); }
  const lonlat = n => [Mo.bbox[0] + g.x[n] / KX, Mo.bbox[1] + g.y[n] / KY];
  const nodeStreet = n => { let best = -1, bl = -1; for (let j = g.adjOff[n]; j < g.adjOff[n + 1]; j++) { const e = g.adjE[j], w = (g.eu[e] === n ? g.b0[e] : g.b1[e]) * 1000 + g.elen[e]; if (w > bl) { bl = w; best = e; } } return best < 0 ? 'this spot' : g.name(best); };
  let baseRoute = null;
  function showRoute(n, quiet, label) {
    if (label) st.pickLabel = label; else if (!quiet) st.pickLabel = null;
    st.pickNode = n; const ev = st.ev, out = $('#evRoute'), ll = lonlat(n), here = st.pickLabel || nodeStreet(n); baseRoute = baseRoute || route(g, null, null);
    Sc.highlight(ll[0], ll[1], true); if (!quiet) app.flyTo(ll[0], ll[1], 6.2);
    if (!g.base[n]) { Sc.showPath(null); out.textContent = `${here}: this stretch has no link to the edge of the map in the street data even with nothing blocked (a missing driveway, private road or unnamed link), so it is left out of the counts.`; return; }
    const dry = pathFrom(g, baseRoute, n), avoided = dry.filter(e => ev.blocked[e]);
    if (ev.r.reach[n]) {
      const p = pathFrom(g, ev.r, n), len = p.reduce((a, e) => a + g.elen[e], 0), via = new Map(); for (const e of p) via.set(g.name(e), (via.get(g.name(e)) || 0) + g.elen[e]);
      Sc.showPath(p.length ? pathLine(g, p, n) : null);
      const exitName = p.length ? g.name(p[p.length - 1]) : here, dryLen = dry.reduce((a, e) => a + g.elen[e], 0);
      out.textContent = p.length ? `From ${here}: ${fmt(len / 1000, 1)} km to the edge of the map on ${exitName}, by way of ${listNames([...via].sort((a, b) => b[1] - a[1]).map(v => v[0]), 4)}. `
        + (avoided.length ? `It avoids ${plural(avoided.length, 'blocked segment')} on ${listNames(avoided.map(e => g.name(e)), 4)}, which adds ${fmt(Math.max(0, len - dryLen) / 1000, 1)} km to the usual ${fmt(dryLen / 1000, 1)} km.` : ev.nBlocked ? 'Nothing on it is blocked. It favours roads that score well below the threshold, so it may not be the shortest.' : 'Nothing is blocked at this setting.')
        : `${here} is at the edge of the map already.`;
    } else {
      const bl = blockers(g, ev, n).sort((a, b) => (dry.includes(b) ? 1 : 0) - (dry.includes(a) ? 1 : 0)), names = new Map(); for (const e of bl) if (!names.has(g.name(e))) names.set(g.name(e), ev.reason(e));
      Sc.showPath(null); Sc.showStreet(bl.map(e => g.geom(e)).concat(dry.length ? [pathLine(g, dry, n)] : [])); st.mine = true;
      out.textContent = `No road out from ${here} at this setting. ${plural(bl.length, 'blocked segment')} shut it in: ` + [...names].slice(0, 5).map(([nm, why]) => `${nm} (${why})`).join('; ') + (names.size > 5 ? `; and ${names.size - 5} more streets` : '') + '. The map shows those segments and the usual route out.';
    }
  }
  function showSpof(o) {
    const mid = g.geom(o.e), m = mid[mid.length >> 1], bs = behind(o.e); st.pickNode = -1;
    Sc.showPath(null); Sc.showStreet(o.es.map(e => g.geom(e))); st.mine = true; Sc.highlight(m[0], m[1], true); app.flyTo(m[0], m[1], 5.6);
    labels.forEach(l => l.show(false)); const near = []; for (const e of o.es) if (m17.flag[e]) near.push(m17.flag[e] - 1);
    [...new Set(near)].slice(0, 6).forEach(i => { let l = labels.find(x => x.i === i); if (!l) { const el = document.createElement('div'); el.className = 'pin-label evac-mk usgs'; el.textContent = `USGS mapped · 2017 · ${fmt(F17[i][2])} m²`; el.hidden = true; $('#labels').appendChild(el); l = Sc.addLabel(F17[i][0], F17[i][1], el, 0.07); l.i = i; labels.push(l); } l.show(true); });
    $('#evSpofOut').textContent = `${G.streets[o.k].n}, ${G.streets[o.k].t}: ${plural(o.cut, 'building')} sit behind this point with no other road out, on ${listNames(bs.map(b => G.streets[b[0]].n), 6)}. `
      + (o.s17 ? `USGS mapped ${plural(o.s17 === 1 ? 1 : new Set(near).size, 'slide')} from the 2016-17 season within ${MAP_M} m of this stretch. ` : o.in17 ? `No 2016-17 slide was mapped within ${MAP_M} m of this stretch. ` : 'This stretch lies outside the area USGS mapped in 2017. ') + (o.s23 ? 'A slide was recorded here in winter 2023.' : '');
  }
  function renderStatic() {
    const ol = $('#evSpof'); ol.textContent = '';
    for (const o of spof.slice(0, 12)) { const s = G.streets[o.k], li = document.createElement('li'), b = document.createElement('button'); b.innerHTML = '<span class="nm"></span><span class="tw"></span><span class="tier Elevated"></span><span class="tip-mm"></span>';
      b.children[0].textContent = s.n; b.children[1].textContent = s.t; b.children[2].textContent = plural(o.cut, 'building');
      b.children[3].textContent = `If this ${fmt(Math.round(o.len / 10) * 10)} m of ${s.n} fails, ${plural(o.cut, 'building')} ${o.cut === 1 ? 'has' : 'have'} no way out.` + (o.s23 ? ' Slide recorded here in winter 2023.' : '') + (o.s17 ? ' USGS mapped a 2016-17 slide within 30 m.' : '');
      b.setAttribute('aria-label', b.children[3].textContent + ' Show on map.'); b.addEventListener('click', () => showSpof(o)); li.appendChild(b); ol.appendChild(li); }
    const m = g.meta, tot = spof.reduce((a, o) => a + (o.cut >= 50 ? 1 : 0), 0), pc = v => fmt(v / m.buildings * 100, 1) + '%';
    $('#evSpofNote').textContent = `${fmt(spof.length)} streets have a stretch that is the only way out for at least one building, and ${fmt(tot)} of them carry 50 buildings or more. This list comes from the street layout alone, so it does not change with the storm or with the model.`;
    $('#evLimits').textContent = '';
    for (const t of [
      `Only the ${fmt(m.streets)} named streets are in the network. Driveways, private roads, unnamed links, fire roads and Highway 24 with its ramps are missing, so some real ways out are not counted.`,
      `A way out means reaching a road that leaves the map box (${fmt(m.exits)} such points). It is not a route to a shelter, and one-way rules, road width, traffic and closures are ignored.`,
      `Street ends within ${fmt(m.tol_m)} m of each other are treated as joined. That connects ${fmt(m.endpoints_joined / m.endpoints * 100)}% of street ends; a wrong join or a missed one changes routes.`,
      `Buildings are placed on the nearest named street. ${fmt(m.buildings_no_road)} of ${fmt(m.buildings)} (${pc(m.buildings_no_road)}) have none within ${fmt(m.max_bld_m)} m, and ${fmt(m.buildings_unlinked)} more (${pc(m.buildings_unlinked)}) sit on streets with no link to the map edge in this data. Both groups are left out, never counted as stranded.`,
      `Roads are blocked by the site's current score, which is a fixed formula and not a trained or calibrated model, read on 29 m cells along each road. A blocked road here means "scores at or above the level you picked", not a forecast that it will fail.`,
      `Debris paths are a downhill trace from the ${RUNOUT_CAP} highest-scoring cells near roads, a screening estimate of direction and reach.`,
      `The USGS inventories are incomplete. The January 2023 one is a reconnaissance with limited staff, time and road access: ${fmt(U_.meta.y2023.inside)} of its ${fmt(U_.meta.y2023.total)} points fall in this map. The 2016-17 map was drawn from one satellite image and has no dates. A road with no mapped slide is unconfirmed, not safe.`,
      'There is no wildfire, earthquake or flood model here. The creek switch is a screening proxy and has not been checked against anything.'
    ]) { const li = document.createElement('li'); li.textContent = t; $('#evLimits').appendChild(li); }
  }
  function renderValidation() {
    if (!on) return; let v; try { v = validate(); } catch (err) { console.error(err); return; }
    const a = v.y23, b = v.y17, r = v.runout, lvl = v.thr >= 75 ? 'High' : 'Elevated', p = (id, t) => { $(id).textContent = t; };
    p('#evHappened', `What happened: the ${plural(a.recorded, 'slide')} recorded in winter 2023 (${a.usgs} mapped by USGS, the rest from local reports) touch ${plural(a.blockedMapped, 'road segment')} and on their own cut off ${plural(a.strandedMapped, 'building')}. The score, on its worst day of that storm sequence (${a.day}, ${a.rain} mm in 72 hours), blocks ${plural(a.blocked, 'segment')} and cuts off ${plural(a.strandedModel, 'building')}.`);
    p('#evVal23', `Winter 2023, a spot check and not a validation. The USGS reconnaissance has ${a.totalPoints} points for the whole Bay Area and ${a.usgs} inside this map; its crews drove ${fmt(a.surveyedKm, 0)} km of road here. Adding the ten local reports gives ${a.recorded} recorded slides, ${a.onRoad} of them within ${MAP_M} m of a named street. At ${lvl} the score blocked the road at ${a.hits} of those ${a.onRoad} and missed ${a.misses}`
      + (a.missed.length ? ` (${listNames(a.missed, 4)})` : '') + `. It also blocked ${fmt(a.unconfirmed)} segments with no recorded slide, ${fmt(a.unconfirmedSurveyed)} of them on roads the USGS crews drove. Those are unconfirmed, not wrong: nobody mapped every road. Blocking the same number of segments by steepest slope alone reaches ${a.slopeHits} of the ${a.onRoad}.`);
    p('#evVal17', `2016-17 storm season. USGS mapped ${fmt(b.total)} slides from a March 11, 2017 satellite image, and ${fmt(b.polygons)} fall in this map. ${fmt(b.mapped)} of the ${fmt(b.segments)} road segments inside the mapped area have one within ${MAP_M} m. Replaying the three wettest storms of that season (${b.storms.map(s => s.date).join('; ')}) at ${lvl}, the score blocked ${fmt(b.hits)} of those ${fmt(b.mapped)}, missed ${fmt(b.misses)}, and blocked ${fmt(b.unconfirmed)} with no mapped slide. Steepest slope alone, blocking the same ${fmt(b.blocked)} segments, gets ${fmt(b.slopeHits)}. `
      + (b.auc == null ? '' : `Ranking instead of a cut-off: a segment with a mapped slide outscores one without ${fmt(b.auc * 10, 1)} times in 10, against ${fmt(b.aucSlope * 10, 1)} for slope alone. 5 is a coin flip.`));
    p('#evValRun', r.n ? `Debris reach. The 2023 release holds the routes the survey crews travelled, not slide paths, so the 2016-17 polygons are used. The typical mapped slide here is ${fmt(r.medAll)} m long, smaller than one 29 m cell of this map. For the ${r.n} that are 60 m or longer (median ${fmt(r.medLen)} m), the traced path is a median ${fmt(Math.abs(r.medErr))} m ${r.medErr >= 0 ? 'longer' : 'shorter'} than mapped (median miss ${fmt(r.medAbsErr)} m) and points ${fmt(r.medAngle)} degrees off the mapped direction. The trace is built for long debris flows and overshoots small slides.` : '');
    p('#evValNote', 'Neither inventory was used to build or tune the score: the map formula is fixed by hand, and the experimental model behind Ask was trained on four news reports from earlier winters. These checks use real terrain and real gauge rain only, with the simulated ground motion switched off, and follow the alert sensitivity set at the top of the page.');
  }
  /* buildings stranded per day through winter 2023, worked out a few days at a time so the page stays responsive */
  let lineKey = '', lineData = null, lineTok = 0;
  function replayLine() {
    const k = [Mo.opts.bias, Mo.opts.motion, st.thr, st.local, st.flood].join('|'); if (k === lineKey && lineData) return drawLine(); lineKey = k; const tok = ++lineTok;
    const R23 = G.rain.wy2023, D0 = dayOf(R23.start, '2022-12-01'), D1 = Math.min(R23.mm.length - 1, dayOf(R23.start, '2023-03-31')), model = [], mapped = [], cache = new Map(); lineData = { D0, D1, model, mapped, start: R23.start }; let D = D0;
    (function step() {
      if (tok !== lineTok) return; const t0 = performance.now();
      while (D <= D1 && performance.now() - t0 < 14) { model.push(day23(D, 'model').stranded);
        const n = F23.filter(f => (st.local || f.src === 'usgs') && f.day <= D).length; if (!cache.has(n)) { setMapped(D); cache.set(n, evaluate(env, hazards, { r72: 0, api: 0, era: 0, amt: 0 }, ['mapped23']).stranded); setMapped(); } mapped.push(cache.get(n)); D++; }
      drawLine(); if (D <= D1) setTimeout(step, 0);
    })();
  }
  function drawLine() {
    const cv = $('#evReplay'), d = lineData; if (!cv || !d || !cv.clientWidth) return; const css = n => getComputedStyle(cv).getPropertyValue(n).trim(), dpr = Math.min(2, root.devicePixelRatio || 1), w = cv.clientWidth, h = cv.clientHeight;
    cv.width = w * dpr; cv.height = h * dpr; const x = cv.getContext('2d'); x.scale(dpr, dpr); x.clearRect(0, 0, w, h);
    const L = 40, T = 8, pw = w - L - 8, ph = h - T - 18, n = d.D1 - d.D0, mx = Math.max(10, ...d.model, ...d.mapped), X = i => L + i / n * pw, Y = v => T + ph - v / mx * ph;
    x.font = '10px system-ui, sans-serif'; x.fillStyle = css('--ink-3'); x.textAlign = 'right'; x.fillText(fmt(mx), L - 6, T + 8); x.fillText('0', L - 6, T + ph); x.textAlign = 'center';
    for (let i = 0; i <= n; i++) { const t = dateOf(d.start, d.D0 + i); if (t.getUTCDate() === 1) { x.fillStyle = css('--line'); x.fillRect(Math.round(X(i)), T, 1, ph); x.fillStyle = css('--ink-3'); x.fillText(MONTHS[t.getUTCMonth()], X(i) + 14, h - 4); } }
    x.fillStyle = css('--line'); x.fillRect(L, T + ph, pw, 1);
    const line = (ys, col, dash) => { if (!ys.length) return; x.strokeStyle = col; x.lineWidth = 1.6; x.setLineDash(dash || []); x.beginPath(); ys.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v))); x.stroke(); x.setLineDash([]); };
    line(d.mapped, css('--ink-2'), [4, 3]); line(d.model, css('--t-high'));
    const done = d.model.length > n, pk = Math.max(0, ...d.model), pi = d.model.indexOf(pk);
    $('#evReplayCap').textContent = !done ? 'Working through the winter...' : `Solid line: buildings the score cuts off each day, using only rain the gauges had logged by that day. It peaks at ${fmt(pk)} on ${dstr(dateOf(d.start, d.D0 + pi))}. Dashed line: buildings cut off by the slides recorded up to that day, which reach ${fmt(d.mapped[d.mapped.length - 1])}. Recorded slides are kept blocked for the rest of the winter, since no reopening dates are known.`;
  }
  function wire() {
    const seg = (id, attr, fn) => $(id).addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', x === b); fn(b.dataset[attr]); });
    seg('#evMode', 'mode', v => { st.mode = v; recompute(); });
    seg('#evThr', 'thr', v => { st.thr = +v; recompute(); replayLine(); renderValidation(); });
    $('#evFlood').addEventListener('change', e => { st.flood = e.target.checked; recompute(); replayLine(); });
    $('#evLocal').addEventListener('change', e => { st.local = e.target.checked; recompute(); replayLine(); renderValidation(); });
    $('#evR72').addEventListener('input', e => app.setStorm(+e.target.value, app.S.api, true));
    $('#evPeak').addEventListener('click', () => { const R23 = G.rain.wy2023; let best = null; for (let D = dayOf(R23.start, '2022-12-31'); D <= dayOf(R23.start, '2023-01-18'); D++) for (let d = D - 3; d < D; d++) { const sc = before23(d, D); if (!best || Mo.Tof(sc) > Mo.Tof(best)) best = sc; } app.setStorm(Math.min(300, best.r72), Math.min(280, best.api), true); });
    $('#evFindF').addEventListener('submit', e => { e.preventDefault(); const q = $('#evFind').value.trim().toLowerCase(); if (!q) return; const ss = G.streets; let k = ss.findIndex(s => s.n.toLowerCase() === q); if (k < 0) k = ss.findIndex(s => s.n.toLowerCase().startsWith(q)); if (k < 0) k = ss.findIndex(s => s.n.toLowerCase().includes(q));
      if (k < 0) { $('#evRoute').textContent = 'No street by that name on this map.'; return; } selectStreet(k); });
    root.addEventListener('resize', () => { clearTimeout(drawLine.t); drawLine.t = setTimeout(drawLine, 200); });
  }
})(typeof window === 'undefined' ? globalThis : window);
