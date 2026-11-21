/* GroundTruth data + placeholder risk model.
   Everything here mirrors section 12 of the ML plan. When the trained gradient-boosted
   model exists, replace GTModel.index() with a tree walker over exported trees. */
(function () {
  const G = window.GT, A = window.GT_ASSETS, M = G.meta;
  const NX = M.nx, NY = M.ny, N = NX * NY;
  const [W, S, E, Nn] = M.bbox;

  function loadImage(src) {
    return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  }
  function pixels(im) {
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(im, 0, 0);
    return x.getImageData(0, 0, c.width, c.height).data;
  }

  const L = {};          // per-cell Float32 layers
  const images = {};     // decoded <img> for textures

  async function load() {
    const names = ['height', 'terrain', 'motion', 'cover', 'hydro', 's2_2023', 's2_2026', 'roads'];
    const ims = await Promise.all(names.map(n => loadImage(A[n])));
    names.forEach((n, i) => images[n] = ims[i]);
    const h = pixels(images.height), t = pixels(images.terrain), m = pixels(images.motion), c = pixels(images.cover), y = pixels(images.hydro);
    const f = () => new Float32Array(N);
    Object.assign(L, { elev: f(), slope: f(), aspect: f(), planc: f(), vpre: f(), v23: f(), vnow: f(), ndvi23: f(), ndvi26: f(), coh: f(), twi: f(), dstream: f(), droad: f() });
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      L.elev[i] = (h[p] * 256 + h[p + 1]) / 100;
      L.slope[i] = t[p] / 255 * 51; L.aspect[i] = t[p + 1] / 255 * 360; L.planc[i] = t[p + 2] / 255 * 0.04 - 0.02;
      L.vpre[i] = m[p] / 255 * 40 - 8; L.v23[i] = m[p + 1] / 255 * 80 - 8; L.vnow[i] = m[p + 2] / 255 * 40 - 8;
      L.ndvi23[i] = c[p] / 255 * 1.2 - 0.2; L.ndvi26[i] = c[p + 1] / 255 * 1.2 - 0.2; L.coh[i] = c[p + 2] / 255;
      L.twi[i] = y[p] / 255 * 20; L.dstream[i] = y[p + 1] / 255 * 1020; L.droad[i] = y[p + 2] / 255 * 1020;
    }
    if (A.buildings) {                                     // real building footprints (Overture), count of buildings per cell
      images.buildings = await loadImage(A.buildings); const b = pixels(images.buildings); L.bld = new Uint8Array(N); const idx = [];
      for (let i = 0, p = 0; i < N; i++, p += 4) { L.bld[i] = b[p]; if (b[p]) idx.push(i); }
      bldCells = Int32Array.from(idx); for (const i of idx) bldTotal += L.bld[i];
    }
    if (window.GT_LS_LAYERS) await loadLandslide(window.GT_LS_LAYERS);
    indexStreets();
  }
  /* Trained landslide model (Lamorinda): its score for every cell, precomputed for each storm region its trees can tell apart
     (model/export_landslide_layers.py). When it is loaded, index() reads it instead of the placeholder formula. */
  let LS = null;
  async function loadLandslide(m) {
    const im = await loadImage(m.png), px = pixels(im), per = m.nx * m.ny, layers = [];
    for (let k = 0; k < m.keys.length; k++) { const f = Math.floor(k / 3), ch = k % 3, a = new Uint8Array(per), o = f * per * 4 + ch; for (let i = 0; i < per; i++) a[i] = px[o + i * 4]; layers.push(a); }
    const table = new Int16Array(16 * 16 * 16).fill(-1);
    m.keys.forEach((key, n) => { const [a, b, c] = key.split(',').map(Number); table[(a * 16 + b) * 16 + c] = n; });
    LS = { cuts: m.cuts, layers, table, lut: new Float32Array(256), lutBias: null, memo: { r: NaN, a: NaN, lay: null } };
  }
  const sideOf = (x, cs) => { let n = 0; for (const c of cs) if (x > c) n++; return n; };
  function lsLayer(sc) {                                    // the precomputed layer for this storm (0..255 per cell)
    const r = Math.max(0, Math.min(400, sc.r72)), a = Math.max(0, Math.min(280, sc.api)), m = LS.memo;
    if (r === m.r && a === m.a) return m.lay;
    const t = 0.55 * Math.min(1.5, r / 200) + 0.45 * Math.min(1.3, a / 200);
    const n = LS.table[(sideOf(r, LS.cuts.r72) * 16 + sideOf(a, LS.cuts.api)) * 16 + sideOf(t, LS.cuts.T)];
    m.r = r; m.a = a; m.lay = LS.layers[n < 0 ? 0 : n]; return m.lay;
  }
  /* alert sensitivity on the model: Fewer alerts is the model as trained; the other settings shift its log-odds by the same steps as the placeholder intercept */
  function lsLut() {
    if (LS.lutBias !== opts.bias) { const off = opts.bias + 6.5; for (let v = 0; v < 256; v++) { const p = Math.min(0.998, Math.max(0.002, v / 255)); LS.lut[v] = off ? 100 * sig(Math.log(p / (1 - p)) + off) : v / 2.55; } LS.lutBias = opts.bias; }
    return LS.lut;
  }
  let bldCells = new Int32Array(0), bldTotal = 0;
  /* buildings standing on ground scored Elevated (50 to 74) and High (75 and up) */
  function buildingsAt(sc) { let el = 0, hi = 0; for (let j = 0; j < bldCells.length; j++) { const i = bldCells[j], v = index(i, sc); if (v >= 75) hi += L.bld[i]; else if (v >= 50) el += L.bld[i]; } return { el, hi, total: bldTotal }; }
  function buildingsNear(cells, rad) {                    // buildings within rad cells of any listed cell, each counted once
    if (!L.bld) return 0; const seen = new Set(); let n = 0;
    for (const i of cells) { const r = Math.floor(i / NX), c = i % NX; for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) { const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= NY || cc >= NX) continue; const j = rr * NX + cc; if (!seen.has(j)) { seen.add(j); n += L.bld[j]; } } }
    return n;
  }
  function streetBuildings(k, sc) { let n = 0, tot = 0; for (const i of streetCells[k]) { if (!L.bld[i]) continue; tot += L.bld[i]; if (index(i, sc) >= 50) n += L.bld[i]; } return { flagged: n, total: tot }; }

  const clip = (x, a, b) => x < a ? a : x > b ? b : x;
  const sig = z => 1 / (1 + Math.exp(-z));

  /* scenario: {r72: mm forecast in 72 h, api: antecedent index mm, era: 0 = today, 1 = winter 2023, amt: 0..1 share of the 2023 speed-up reached}
     opts.motion = 0 drops the simulated ground motion terms, so the score rests on real terrain and real rain only. */
  const opts = { motion: 0, bias: -6.5 };              // bias is the alert sensitivity: a higher intercept flags more ground
  function recentV(i, sc) { return sc.era ? L.vpre[i] + (L.v23[i] - L.vpre[i]) * sc.amt : L.vnow[i]; }
  const Tof = sc => 0.55 * Math.min(1.5, sc.r72 / 200) + 0.45 * Math.min(1.3, sc.api / 200);
  function terms(i, sc) {
    const s = clip((L.slope[i] - 8) / 22, 0, 1), h = clip(-L.planc[i] / 0.01, 0, 1);
    const vr = recentV(i, sc), m = opts.motion * clip(vr / 20, 0, 1), a = opts.motion * clip((vr - L.vpre[i]) / 15, 0, 1);
    const T = Tof(sc);
    if (LS && window.GTLocalModel) {                       // what-if changes from the trained model, in score points
      const ml = window.GTLocalModel; return { s, h, m, a, T, vr, model: true,
        parts: ml.explainCell(i, Math.max(0, Math.min(400, sc.r72)), Math.max(0, Math.min(280, sc.api))).map(x => [x.name[0].toUpperCase() + x.name.slice(1), x.change]) };
    }
    return { s, h, m, a, T, vr,
      parts: [
        ['Slope steepness', 3.0 * s], ['Hollow that collects water', 0.8 * h], ['Ground already moving', 1.0 * m],
        ['Speeding up', 1.2 * a], ['Rain and wet soil', 3.5 * T], ['Steep slope under this storm', 2.0 * s * T], ['Moving ground under this storm', 1.6 * m * T]
      ] };
  }
  function index(i, sc) {                                  // same sum as terms(), without allocating
    if (LS) return lsLut()[lsLayer(sc)[i]];
    const s = clip((L.slope[i] - 8) / 22, 0, 1), h = clip(-L.planc[i] / 0.01, 0, 1), T = Tof(sc); let m = 0, a = 0;
    if (opts.motion) { const vr = recentV(i, sc); m = clip(vr / 20, 0, 1); a = clip((vr - L.vpre[i]) / 15, 0, 1); }
    return 100 * sig(opts.bias + 3.0 * s + 0.8 * h + m + 1.2 * a + 3.5 * T + 2.0 * s * T + 1.6 * m * T);
  }
  const TIERS = [[75, 'High'], [50, 'Elevated'], [25, 'Guarded'], [0, 'Low']];
  const tier = v => TIERS.find(t => v >= t[0])[1];

  /* area statistics for a scenario, sampled every 2nd cell for speed */
  function areaStats(sc) {
    let hi = 0, el = 0, n = 0;
    for (let r = 0; r < NY; r += 2) for (let c = 0; c < NX; c += 2) { const v = index(r * NX + c, sc); n++; if (v >= 75) hi++; else if (v >= 50) el++; }
    return { high: hi / n, elevated: el / n, highKm2: hi / n * 14.06 * 13.34 };
  }

  const cellOf = (lon, lat) => {
    const c = Math.round((lon - W) / (E - W) * NX - 0.5), r = Math.round((Nn - lat) / (Nn - S) * NY - 0.5);
    return (r < 0 || c < 0 || r >= NY || c >= NX) ? -1 : r * NX + c;
  };
  const lonlatOf = i => [W + ((i % NX) + 0.5) * (E - W) / NX, Nn - (Math.floor(i / NX) + 0.5) * (Nn - S) / NY];

  /* streets: cells within ~60 m of each sampled centreline point */
  let streetCells = [];
  function indexStreets() {
    streetCells = G.streets.map(st => {
      const set = new Set();
      for (const [lo, la] of st.p) {
        const i = cellOf(lo, la); if (i < 0) continue; const r = Math.floor(i / NX), c = i % NX;
        for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
          const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < NY && cc < NX && dr * dr + dc * dc <= 5) set.add(rr * NX + cc);
        }
      }
      return Int32Array.from(set);
    });
  }
  /* street score: mean of the worst 10% of its cells, so one stray pixel cannot set it */
  function streetScore(k, sc) {
    const cells = streetCells[k]; if (!cells.length) return null;
    const v = new Float32Array(cells.length); let worst = cells[0], wv = -1;
    for (let j = 0; j < cells.length; j++) { v[j] = index(cells[j], sc); if (v[j] > wv) { wv = v[j]; worst = cells[j]; } }
    v.sort(); const n = Math.min(v.length, Math.max(3, Math.ceil(v.length * 0.1))); let s = 0; for (let j = 0; j < n; j++) s += v[v.length - 1 - j];
    return { score: s / n, worst, n: cells.length };
  }
  function rankStreets(sc, top) {
    const out = [];
    for (let k = 0; k < G.streets.length; k++) { const r = streetScore(k, sc); if (r && r.n >= 12) out.push({ k, name: G.streets[k].n, town: G.streets[k].t, score: r.score, worst: r.worst }); }
    out.sort((a, b) => b.score - a.score);
    return { top: out.slice(0, top), all: out, elevated: out.filter(o => o.score >= 50).length, high: out.filter(o => o.score >= 75).length, total: out.length };
  }

  /* InSAR series maths, as in section 6 of the plan: line + annual cycle by least squares */
  function solve(Amat, b) {
    const n = b.length, Mx = Amat.map((r, i) => [...r, b[i]]);
    for (let i = 0; i < n; i++) {
      let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(Mx[r][i]) > Math.abs(Mx[p][i])) p = r;
      [Mx[i], Mx[p]] = [Mx[p], Mx[i]];
      for (let r = i + 1; r < n; r++) { const f = Mx[r][i] / Mx[i][i]; for (let c = i; c <= n; c++) Mx[r][c] -= f * Mx[i][c]; }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = Mx[i][n]; for (let c = i + 1; c < n; c++) s -= Mx[i][c] * x[c]; x[i] = s / Mx[i][i]; }
    return x;
  }
  function fitSeries(t, d, seasonal) {
    const rows = t.map(x => seasonal ? [1, x, Math.sin(2 * Math.PI * x), Math.cos(2 * Math.PI * x)] : [1, x]);
    const k = rows[0].length, AtA = Array.from({ length: k }, () => new Array(k).fill(0)), Atb = new Array(k).fill(0);
    rows.forEach((r, i) => { for (let a = 0; a < k; a++) { Atb[a] += r[a] * d[i]; for (let b = 0; b < k; b++) AtA[a][b] += r[a] * r[b]; } });
    const th = solve(AtA, Atb);
    let ss = 0; rows.forEach((r, i) => { let p = 0; for (let a = 0; a < k; a++) p += r[a] * th[a]; ss += (d[i] - p) ** 2; });
    return { theta: th, v: th[1], rms: Math.sqrt(ss / Math.max(1, t.length - k)) };
  }
  function analyseSeries(pt) {
    const n = pt.disp_mm.length, t = Array.from({ length: n }, (_, k) => k * G.insar.step_days / 365.25);
    const long = fitSeries(t, pt.disp_mm, true);
    const m = 12, rec = fitSeries(t.slice(n - m), pt.disp_mm.slice(n - m), false);
    return { t, long, recent: rec, accel: rec.v - long.v };
  }

  /* Tipping point: the 72 h rain at which a score first reaches `level`, holding soil wetness fixed. The score only rises with rain, so bisection is exact.
     f(r72) is any score function. Returns 0 if already there, null if 400 mm is not enough. */
  function tipping(f, level) {
    if (f(0) >= level) return 0; if (f(400) < level) return null;
    let lo = 0, hi = 400; for (let k = 0; k < 11; k++) { const mid = (lo + hi) / 2; if (f(mid) >= level) hi = mid; else lo = mid; }
    return Math.round(hi);
  }
  const tipCell = (i, sc, level) => tipping(r => index(i, { ...sc, r72: r }), level);
  const tipStreet = (k, sc, level) => tipping(r => streetScore(k, { ...sc, r72: r }).score, level);

  /* Which street centreline runs through each cell (for runout tracing). */
  let cellStreet = null;
  function streetGrid() {
    if (cellStreet) return cellStreet; cellStreet = new Int32Array(N).fill(-1);
    G.streets.forEach((st, k) => { for (const seg of st.g) for (let j = 0; j + 1 < seg.length; j++) {
      const [x0, y0] = seg[j], [x1, y1] = seg[j + 1], n = Math.max(1, Math.ceil(Math.hypot((x1 - x0) * 87800, (y1 - y0) * 110950) / 14));
      for (let q = 0; q <= n; q++) { const i = cellOf(x0 + (x1 - x0) * q / n, y0 + (y1 - y0) * q / n); if (i >= 0) cellStreet[i] = k; } } });
    return cellStreet;
  }
  /* Runout: follow the steepest way down from a cell. Debris starts to drop out once the path gradient falls under about 10 degrees
     (deposition starts at 8 to 27 degrees in field surveys) and then travels a further 0.4 x the height already fallen (Vandre 1985, as used by Lorente et al. 2003).
     A screening estimate of direction and reach, not a flow simulation. */
  const CW = (E - W) / NX * 87800, CH = (Nn - S) / NY * 110950;
  function runout(i0) {
    const sg = streetGrid(), path = [i0], hits = new Map(), z0 = L.elev[i0], seen = new Set([i0]);
    let i = i0, len = 0, dep = -1, depLen = 0, depDrop = 0, creek = -1, flat = 0, why = 'flat';
    for (let step = 0; step < 500; step++) {
      const r = Math.floor(i / NX), c = i % NX; let best = -1, bg = 0, bd = 0;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr < 0 || cc < 0 || rr >= NY || cc >= NX) continue;
        const j = rr * NX + cc; if (seen.has(j)) continue; const d = Math.hypot(dc * CW, dr * CH), g = (L.elev[i] - L.elev[j]) / d; if (g > bg) { bg = g; best = j; bd = d; } }
      if (best < 0) { why = rEdge(r, c) ? 'edge' : 'basin'; break; }
      i = best; seen.add(i); len += bd; path.push(i);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = Math.floor(i / NX) + dr, cc = i % NX + dc; if (rr < 0 || cc < 0 || rr >= NY || cc >= NX) continue; const k = sg[rr * NX + cc]; if (k >= 0 && !hits.has(k)) hits.set(k, Math.round(len)); }
      if (creek < 0 && L.dstream[i] < 16 && len > 40) creek = Math.round(len);
      if (dep < 0) { flat = bg < 0.176 ? flat + bd : 0; if (flat >= 55 && len > 80) { dep = path.length - 1; depLen = len; depDrop = z0 - L.elev[i]; } }
      else if (len - depLen >= 0.4 * depDrop) { why = 'reach'; break; }
      if (len > 3000) { why = 'far'; break; }
    }
    const drop = z0 - L.elev[i];
    return { path, length: Math.round(len), drop: Math.round(drop), reachAngle: len ? Math.atan(drop / len) * 180 / Math.PI : 0, creek, why,
      streets: [...hits].map(([k, d]) => ({ k, name: G.streets[k].n, town: G.streets[k].t, dist: d })).sort((a, b) => a.dist - b.dist) };
  }
  const rEdge = (r, c) => r < 2 || c < 2 || r > NY - 3 || c > NX - 3;

  /* Whole-map score for one scenario, sampled every 2nd cell, sorted: used for area shares and percentiles. */
  function sortedField(sc) {
    const out = new Float32Array(Math.ceil(NY / 2) * Math.ceil(NX / 2)); let n = 0;
    for (let r = 0; r < NY; r += 2) for (let c = 0; c < NX; c += 2) out[n++] = index(r * NX + c, sc);
    return out.subarray(0, n).sort();
  }
  const shareAbove = (sorted, v) => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; } return 1 - lo / sorted.length; };
  /* highest score within `rad` cells of a place (street-level positions are only good to about 150 m) */
  function maxNear(lon, lat, sc, rad) {
    const i = cellOf(lon, lat); if (i < 0) return 0; const r0 = Math.floor(i / NX), c0 = i % NX; let mx = 0;
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) { const rr = r0 + dr, cc = c0 + dc; if (rr < 0 || cc < 0 || rr >= NY || cc >= NX || dr * dr + dc * dc > rad * rad) continue; const v = index(rr * NX + cc, sc); if (v > mx) mx = v; }
    return mx;
  }

  window.GTModel = { landslide: () => !!LS, lsLayer: sc => LS ? lsLayer(sc) : null, cellsForStreet: k => streetCells[k] || new Int32Array(0), load, L, images, NX, NY, N, bbox: M.bbox, index, terms, tier, areaStats, cellOf, lonlatOf, streetScore, rankStreets, analyseSeries, recentV, opts, Tof, buildingsAt, buildingsNear, streetBuildings, tipCell, tipStreet, runout, sortedField, shareAbove, maxNear, cellM: [CW, CH] };
})();
