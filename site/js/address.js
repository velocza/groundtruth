/* escape "Your address": type an address, get plain answers. Landslide risk (Lamorinda, the trained landslide model), flooding
   (San Francisco: the flood model plus 311 flood reports near you), a road out (the Getting out road network) and how long help takes
   to arrive (San Francisco: real emergency calls near you, checked on calls it never saw, and in the November 18, 2026 storm).
   Addresses come from Overture Maps address points packed by scripts/12_address_index.py. The lookup runs in this browser: nothing
   typed here is sent anywhere or stored. The only network call is the rain forecast for the area's centre (Open-Meteo, no key), which
   carries no address. Where a prediction does not exist for an area, the answer says so. Each answer is a measure drawn as a card by
   site/js/cards.js; another model adds or replaces one with GTAddress.addMeasure (see cards.js). */
(function (root) {
  'use strict';
  const $ = s => document.querySelector(s);
  const fmt = (v, d) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d; };
  const dstr = d => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  const dshort = d => `${WD[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  const inches = mm => mm >= 25.4 ? `${fmt(mm / 25.4, 1)} inches` : `${fmt(mm / 25.4, 1)} inch`;
  const rainTxt = mm => `${fmt(mm)} mm (${inches(mm)})`;
  const API = root.GTAddress = {};

  /* ------------------------------------------------ address matching (pure, no page access) */
  const ABBR = { street: 'st', road: 'rd', avenue: 'ave', av: 'ave', drive: 'dr', boulevard: 'blvd', lane: 'ln', court: 'ct', place: 'pl', terrace: 'ter', circle: 'cir', highway: 'hwy', parkway: 'pkwy', trail: 'trl', square: 'sq', alley: 'aly', plaza: 'plz', crescent: 'cres', expressway: 'expy', freeway: 'fwy', heights: 'hts', point: 'pt', north: 'n', south: 's', east: 'e', west: 'w', saint: 'st', mount: 'mt', first: '1st', second: '2nd', third: '3rd', fourth: '4th', fifth: '5th', sixth: '6th', seventh: '7th', eighth: '8th', ninth: '9th', tenth: '10th' };
  const normSt = s => String(s).toLowerCase().replace(/[.,'’#]/g, ' ').split(/\s+/).filter(Boolean).map(w => ABBR[w] || w).join(' ');
  function Index(A) {
    const bin = atob(A.pts), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const dv = new DataView(u8.buffer), [W, S] = A.meta.bbox, [QX, QY] = A.meta.q;
    const streets = A.streets.map(([name, c, off, n]) => ({ name, city: A.cities[c] || '', off, n, key: normSt(name) }));
    const num = j => dv.getUint16(j * 6, true), ll = j => [W + dv.getUint16(j * 6 + 2, true) * QX, S + dv.getUint16(j * 6 + 4, true) * QY];
    const cityKeys = A.cities.filter(Boolean).map(c => [c, c.toLowerCase()]).sort((a, b) => b[1].length - a[1].length);
    function parse(q) {
      let t = ' ' + String(q).toLowerCase().replace(/\b(ca|california|usa|united states)\b/g, ' ').replace(/\b\d{5}(-\d{4})?\b\s*$/, ' ').replace(/,/g, ' , ') + ' ';
      let city = ''; for (const [c, k] of cityKeys) { const i = t.lastIndexOf(' ' + k + ' '); if (i > 2) { city = c; t = t.slice(0, i) + ' ' + t.slice(i + k.length + 1); break; } }
      t = t.replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
      const m = t.match(/^(\d+)\s*[a-z]?\b\s*(.*)$/); const number = m ? +m[1] : null; let st = m ? m[2] : t;
      st = st.replace(/\b(apt|unit|suite|ste)\b.*$/, '').replace(/\s#.*$/, '');
      return { number, key: normSt(st), city };
    }
    function streetsFor(key, city) {
      if (!key) return [];
      const inCity = s => !city || s.city === city, toks = key.split(' ');
      let hit = streets.filter(s => inCity(s) && s.key === key);
      if (!hit.length) hit = streets.filter(s => inCity(s) && (s.key.startsWith(key + ' ') || s.key.startsWith(key)));
      if (!hit.length) hit = streets.filter(s => inCity(s) && toks.every(t => s.key.split(' ').some(w => w.startsWith(t))));
      return hit;
    }
    /* best point on one street for a house number: the same number, else the nearest number on the same side of the street */
    function pointOn(s, number) {
      if (number == null) { const j = s.off + (s.n >> 1); return { ll: ll(j), number: null, exact: false }; }
      let best = -1, bd = 1e9;
      for (let j = s.off; j < s.off + s.n; j++) { const v = num(j), d = Math.abs(v - number) + ((v - number) % 2 ? 6 : 0); if (d < bd) { bd = d; best = j; } }
      return { ll: ll(best), number: num(best), exact: num(best) === number };
    }
    function range(s) { return [num(s.off), num(s.off + s.n - 1)]; }
    /* -> { ok, lon, lat, label, exact, note } or { ok: false, choices: [...] } */
    function find(q) {
      const p = parse(q); let ss = streetsFor(p.key, p.city);
      if (!ss.length && p.city) ss = streetsFor(p.key, '');
      if (!ss.length) return { ok: false, why: 'none', parsed: p };
      const named = [...new Set(ss.map(s => s.name))];
      if (named.length > 1 && !ss.some(s => s.key === p.key)) return { ok: false, why: 'many', choices: ss.slice(0, 8).map(s => label(s, p.number)) };
      if (ss.some(s => s.key === p.key)) ss = ss.filter(s => s.key === p.key);
      if (ss.length > 1 && p.number != null) { const inR = ss.filter(s => { const [a, b] = range(s); return p.number >= a && p.number <= b; }); if (inR.length) ss = inR; }
      if (ss.length > 1) { const ex = ss.filter(s => pointOn(s, p.number).exact); if (ex.length === 1) ss = ex; }
      if (ss.length > 1) return { ok: false, why: 'city', choices: ss.slice(0, 8).map(s => label(s, p.number)) };
      const s = ss[0], pt = pointOn(s, p.number);
      return { ok: true, lon: pt.ll[0], lat: pt.ll[1], street: s.name, city: s.city, number: pt.number, exact: pt.exact, asked: p.number,
        label: (pt.number != null ? pt.number + ' ' : '') + s.name + (s.city ? ', ' + s.city : ''),
        note: p.number == null ? 'No house number given, so this uses the middle of the street.' : pt.exact ? '' : `${p.number} is not in the address list, so this uses ${pt.number}, the closest listed number${(pt.number - p.number) % 2 ? '' : ' on the same side of the street'}.` };
    }
    const label = (s, n) => (n != null ? n + ' ' : '') + s.name + (s.city ? ', ' + s.city : '');
    function suggest(q, k) {
      const p = parse(q); if (!p.key || p.key.length < 2) return [];
      const out = [], seen = new Set();
      for (const s of streets) { if (out.length >= (k || 6)) break; if (p.city && s.city !== p.city) continue; if (s.key.startsWith(p.key) || s.key.includes(' ' + p.key)) { const l = label(s, p.number); if (!seen.has(l)) { seen.add(l); out.push(l); } } }
      return out;
    }
    return { find, suggest, parse, streets, count: A.meta.addresses };
  }
  API.Index = Index; API.normSt = normSt;
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------ page */
  let app = null, REG, G, Mo, Sc, idx = null, loading = null, forecast = null, fcTried = null, last = null;
  const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  function ensure() {
    if (!loading) loading = Promise.all([loadScript(REG.dir + '/addresses.js')].concat(REG.id === 'sf' ? [loadScript(REG.dir + '/address_help.js')] : []))
      .then(() => { idx = Index(root.GT_ADDR); return idx; }).catch(e => { loading = null; throw e; });
    return loading;
  }
  /* the live rain forecast for the middle of the area (no address in the request) */
  function getForecast() {
    if (fcTried) return fcTried;
    const b = Mo.bbox, lat = ((b[1] + b[3]) / 2).toFixed(2), lon = ((b[0] + b[2]) / 2).toFixed(2), ctl = root.AbortController ? new AbortController() : null;
    const t = setTimeout(() => ctl && ctl.abort(), 7000);
    fcTried = fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=precipitation_sum&timezone=America%2FLos_Angeles&forecast_days=7`, ctl ? { signal: ctl.signal } : {})
      .then(r => r.ok ? r.json() : null).then(j => {
        clearTimeout(t); if (!j || !j.daily || !j.daily.time) return null;
        const d = j.daily.time, mm = j.daily.precipitation_sum.map(v => v || 0); let bi = 0, bv = -1;
        for (let i = 0; i + 2 < mm.length; i++) { const v = mm[i] + mm[i + 1] + mm[i + 2]; if (v > bv) { bv = v; bi = i; } }
        return forecast = { days: d, mm, max3: bv, from: d[bi], to: d[bi + 2], total: mm.reduce((a, c) => a + c, 0) };
      }).catch(() => (clearTimeout(t), null));
    return fcTried;
  }

  API.register = function (a) {
    app = a; REG = root.GT_REGION || { id: 'lamorinda', dir: 'data' }; G = root.GT; Mo = root.GTModel; Sc = root.GTScene;
    const form = $('#addrForm'); if (!form) return;
    const inp = $('#addrIn'), sugg = $('#addrSugg');
    const hide = () => { sugg.hidden = true; sugg.textContent = ''; };
    inp.addEventListener('focus', () => { ensure().catch(() => {}); getForecast(); }, { once: true });
    inp.addEventListener('input', () => {
      hide(); if (!idx) { ensure().catch(() => {}); return; }
      const xs = idx.suggest(inp.value, 6); if (!xs.length || xs[0].toLowerCase() === inp.value.trim().toLowerCase()) return;
      for (const l of xs) { const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button'; b.innerHTML = '<span></span><small></small>'; const k = l.lastIndexOf(', '); b.firstChild.textContent = k > 0 ? l.slice(0, k) : l; b.lastChild.textContent = k > 0 ? l.slice(k + 2) : ''; b.dataset.v = l; b.addEventListener('click', () => { inp.value = l; hide(); check(l); }); li.appendChild(b); sugg.appendChild(li); }
      sugg.hidden = false;
    });
    inp.addEventListener('keydown', e => {
      if (sugg.hidden || !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return; e.preventDefault(); if (e.key === 'Escape') return hide();
      const bs = Array.from(sugg.querySelectorAll('button')), i = bs.findIndex(b => b.classList.contains('act')), n = (i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length; bs.forEach(b => b.classList.remove('act')); bs[n].classList.add('act');
    });
    form.addEventListener('submit', e => { e.preventDefault(); const a2 = sugg.querySelector('.act'); if (a2 && !sugg.hidden) inp.value = a2.dataset.v; hide(); check(inp.value); });
    document.addEventListener('click', e => { if (!form.contains(e.target)) hide(); });
  };

  /* ------------------------------------------------ the answer */
  const out = () => $('#addrOut');
  function status(txt) { const o = out(); o.hidden = false; o.textContent = ''; const p = document.createElement('p'); p.className = 'note'; p.setAttribute('role', 'status'); p.textContent = txt; o.appendChild(p); }
  API.check = check;
  async function check(q) {
    q = String(q || '').trim(); if (!q) return;
    if (app && app.active && app.active() !== 'top') app.go('top');
    $('#addrIn').value = q; status('Looking up the address...');
    try { await ensure(); } catch (e) { status('The address list did not load. Reload the page and try again.'); return; }
    const hit = idx.find(q);
    if (!hit.ok) {
      const o = out(); o.textContent = '';
      const p = document.createElement('p'); p.className = 'body';
      p.textContent = hit.why === 'none' ? `We could not find "${q}" in ${REG.places}. Try the house number and street, like ${REG.id === 'sf' ? '1 Dr Carlton B Goodlett Pl' : '3400 Mt Diablo Blvd, Lafayette'}.` : 'Which one do you mean?';
      o.appendChild(p);
      if (hit.choices) { const r = document.createElement('div'); r.className = 'row'; for (const c of hit.choices) { const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = c; b.addEventListener('click', () => check(c)); r.appendChild(b); } o.appendChild(r); }
      return;
    }
    status('Checking ' + hit.label + '...');
    await new Promise(r => setTimeout(r, 30));
    const fc = await Promise.race([getForecast(), new Promise(r => setTimeout(() => r(null), 4000))]);
    render(hit, fc);
  }

  /* storms the answer talks about */
  function storms(fc) {
    const R = G.rain.recent, n = R.mm.length - 1, apiNow = R.api[n], asOf = addDays(R.start, n);
    const big = REG.id === 'sf' && root.GT_FLOOD ? { r72: root.GT_FLOOD.meta.rain_72h_mm, api: root.GT_FLOOD.meta.api_mm, name: 'the November 18, 2026 storm', short: 'a storm like November 18, 2026' }
      : (() => { const sc = app.replaySc(app.peakDay), d = addDays(G.rain.wy2023.start, app.peakDay); return { r72: sc.r72, api: sc.api, name: `the worst days of winter 2023 (${dstr(d)})`, short: 'a storm like January 2023' }; })();
    const next = fc ? { r72: fc.max3, api: apiNow, name: `the wettest 3 days in the forecast (${dshort(new Date(fc.from + 'T12:00:00Z'))} to ${dshort(new Date(fc.to + 'T12:00:00Z'))})`, live: true }
      : { r72: R.mm[n] + R.mm[n - 1] + R.mm[n - 2], api: apiNow, name: `the last 3 days of gauge rain (to ${dstr(asOf)})`, live: false };
    return { next, big, apiNow, asOf };
  }
  const near = (lon, lat, rad) => { const i = Mo.cellOf(lon, lat); if (i < 0) return []; const r0 = Math.floor(i / Mo.NX), c0 = i % Mo.NX, ids = [];
    for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) { const r = r0 + dr, c = c0 + dc; if (r >= 0 && c >= 0 && r < Mo.NY && c < Mo.NX && dr * dr + dc * dc <= rad * rad + 1) ids.push(r * Mo.NX + c); } return ids; };

  /* Landslide: the trained model (Lamorinda) at the ground within about 60 m of the address */
  function landslide(hit, st) {
    const ml = REG.landslideModel && root.GTLocalModel, ids = near(hit.lon, hit.lat, 2), L = Mo.L;
    const slope = ids.length ? Math.max(...ids.map(i => L.slope[i])) : null, creek = ids.length ? Math.min(...ids.map(i => L.dstream[i])) : null;
    if (!ml) return { area: 'none', slope, creek };
    const cells = ids.filter(i => ml.valid[i]); if (!cells.length) return { area: 'edge', slope, creek };
    const at = (r72, api) => Math.max(...cells.map(i => ml.predict(ml.cellFeatures(i, Math.min(400, r72), Math.min(280, api)))));
    const vNext = at(st.next.r72, st.next.api), vBig = at(st.big.r72, st.big.api);
    const tip = (api, lvl) => { if (at(0, api) >= lvl) return 0; if (at(400, api) < lvl) return null; let lo = 0, hi = 400; for (let k = 0; k < 11; k++) { const m = (lo + hi) / 2; if (at(m, api) >= lvl) hi = m; else lo = m; } return Math.round(hi); };
    const tipNow = tip(st.apiNow, 50), tipWet = tip(Math.max(st.apiNow, st.big.api), 50);
    const A = ml.area(Math.min(400, st.big.r72), Math.min(280, st.big.api)); let below = 0, n = 0; for (let i = 0; i < A.length; i++) if (ml.valid[i]) { n++; if (A[i] < vBig) below++; }
    const RL = root.GT_RAIN; let times = 0, lastD = -1, prev = -99; const t = tipWet;
    if (t != null && RL) for (let d = 0; d + 3 < RL.mm.length; d++) { const r = (RL.mm[d + 1] || 0) + (RL.mm[d + 2] || 0) + (RL.mm[d + 3] || 0); if (r >= t && d - prev > 7) { times++; lastD = d; prev = d; } else if (r >= t) prev = d; }
    return { area: 'ok', vNext, vBig, top: 1 - below / n, tipNow, tipWet, times, lastDate: lastD >= 0 ? dstr(addDays(RL.start, lastD + 1)) : null, since: RL ? dstr(addDays(RL.start, 0)) : '', slope, creek, cells: cells.length };
  }
  /* Flooding (San Francisco): the flood model's street score, and 311 flood reports near the address on rain days */
  function flood(hit) {
    const F = root.GT_FLOOD, H = root.GT_HELP; if (!F || !H) return { area: 'none' };
    let best = null, bd = 1e9; const kx = 88000, ky = 111000;
    for (const s of G.streets) { if (!F.streets[s.n]) continue; for (const p of s.p) { const d = Math.hypot((p[0] - hit.lon) * kx, (p[1] - hit.lat) * ky); if (d < bd) { bd = d; best = s.n; } } }
    const fm = H.meta.flood, i = Math.floor((hit.lon - H.meta.origin[0]) * kx / fm.cell_m), j = Math.floor((hit.lat - H.meta.origin[1]) * ky / fm.cell_m);
    const cell = (i >= 0 && j >= 0 && i < fm.nx && j < fm.ny) ? floodCell(H, j * fm.nx + i) : null;
    const v = best && bd < 200 ? F.streets[best] : null;
    return { area: 'ok', street: v ? best : null, score: v ? v[0] : null, rank: v ? v[1] : null, of: F.meta.n_streets, rain: F.meta.rain_72h_mm, hist: cell, fm };
  }
  function floodCell(H, k) { if (!H._f) { H._f = new Map(); for (const r of H.flood) H._f.set(r[0], r); } const r = H._f.get(k); return r ? { reports: r[1], days: r[2], typical: r[3], lightest: r[4], last: r[5], nov18: r[6] } : { reports: 0, days: 0 }; }
  /* Help arrival (San Francisco): real emergency calls near the address */
  function help(hit) {
    const H = root.GT_HELP; if (!H) return { area: 'none' };
    const m = H.meta.help, [kx, ky] = H.meta.mpd, i = Math.floor((hit.lon - H.meta.origin[0]) * kx / m.cell_m), j = Math.floor((hit.lat - H.meta.origin[1]) * ky / m.cell_m);
    if (!H._h) { H._h = new Map(); for (const r of H.help) H._h.set(r[0], r); }
    const r = i >= 0 && j >= 0 && i < m.nx && j < m.ny ? H._h.get(j * m.nx + i) : null;
    let nb = null; const D = root.GT_STORM, SR = root.GTStormResp;
    if (D && SR) { const k = SR.nbAt(D, hit.lon, hit.lat); if (k >= 0) nb = D.cmp.nb[k]; }
    return r ? { area: 'ok', calls: r[1], med: r[2], p90: r[3], m, nb, city: D && D.cmp.city } : { area: 'few', m };
  }
  /* A road out, in the big storm, from the Getting out road network */
  function roadOut(hit, sc) {
    const E = root.GTEvac; if (!E || !E.ensure || !E.ensure()) return null;
    const g = E.graph(), n = E.nodeAt(hit.lon, hit.lat); if (!g || n < 0) return { ok: false, why: 'far' };
    const s = E.scenario({ r72: sc.r72, api: sc.api });
    if (!g.base[n]) return { ok: false, why: 'unlinked' };
    if (!s.reach[n]) { const names = new Set(); for (let e = 0; e < g.ne; e++) if (s.blocked[e] && (g.eu[e] === n || g.ev[e] === n)) names.add(g.name(e)); return { ok: false, why: 'cut', names: [...names], blocked: s.nBlocked }; }
    const via = new Map(), line = []; let m = n, km = 0, guard = 0, exit = '';
    while (s.next[m] >= 0 && guard++ < 5000) { const e = s.next[m], q = g.geom(e), o = g.eu[e] === m ? g.ev[e] : g.eu[e], p0 = g.lonlat(m);
      const seg = Math.hypot(q[0][0] - p0[0], q[0][1] - p0[1]) <= Math.hypot(q[q.length - 1][0] - p0[0], q[q.length - 1][1] - p0[1]) ? q : q.slice().reverse();
      line.push(...seg); km += g.elen[e] / 1000; via.set(g.name(e), (via.get(g.name(e)) || 0) + g.elen[e]); exit = g.name(e); m = o; }
    let avoided = 0; for (let e = 0; e < g.ne; e++) if (s.blocked[e]) avoided++;
    return { ok: true, km, exit, via: [...via].sort((a, b) => b[1] - a[1]).map(v => v[0]).slice(0, 4), line, blockedNearby: avoided };
  }

  /* ------------------------------------------------ measures: one card each, drawn by GTCards from the numbers computed above.
     Other models add or replace a card with GTAddress.addMeasure({ id, order, run(ctx) }) (see the top of cards.js). */
  const word = v => v >= 75 ? 'High' : v >= 50 ? 'Elevated' : v >= 25 ? 'Guarded' : 'Low';
  const open = (id, then) => () => { app.go(id); if (then) setTimeout(then, 80); };
  const ALERTS = () => REG.id === 'sf' ? 'Sign up for AlertSF emergency texts (text ALERTSF to 888-777).' : 'Sign up for Contra Costa County Community Warning System alerts (cwsalerts.com).';
  const creekTxt = c => c >= 1000 ? 'over 1 km' : fmt(Math.round(c / 10) * 10) + ' m';
  const MEASURES = [];
  API.addMeasure = m => { const i = MEASURES.findIndex(x => x.id === m.id); if (i >= 0) MEASURES[i] = m; else MEASURES.push(m); MEASURES.sort((a, b) => (a.order || 0) - (b.order || 0)); if (last && last._fc !== undefined && document.querySelector('#addrOut .mc')) render(last, last._fc); };
  API.measures = () => MEASURES.map(m => m.id);

  API.addMeasure({ id: 'landslide', order: 10, run(c) {
    const { hit, storms: st, fc } = c, ls = landslide(hit, st); c.prior.landslideRaw = ls;
    if (ls.area !== 'ok') return { title: 'Landslides', icon: 'slide', tone: 'none', big: 'No prediction', chip: 'No model',
      line: ls.area === 'edge' ? 'This address is at the edge of our map, so there is no landslide score for it.' : `There is no landslide model for ${REG.short} yet. Too few slides are on record here to train one, so we won't guess.`,
      stats: ls.slope != null ? [[fmt(ls.slope) + '°', 'steepest ground within 60 m'], [ls.slope >= 25 ? 'Steep' : ls.slope >= 15 ? 'Moderate' : 'Gentle', 'slope, from real terrain']] : [],
      todo: ls.slope >= 15 ? ['After heavy rain, watch for new cracks, tilting walls or fences, and muddy runoff.', ALERTS()] : [ALERTS()],
      how: ['The map draws a placeholder score from slope and rain, which is not a trained prediction, so it is not used here.', ls.slope >= 25 ? 'Steep ground near homes is where slides usually start.' : ''] };
    const lv = word(ls.vBig), nowLv = word(ls.vNext), pctAbove = Math.round(Math.max(0, Math.min(100, (1 - ls.top) * 100)));
    const watch = ls.tipWet === 0 ? 'already Elevated when the soil is soaked' : ls.tipWet != null ? rainTxt(ls.tipWet) + ' in 3 days' : 'not reached even at 400 mm';
    return { title: 'Landslides', icon: 'slide', level: lv, score: ls.vBig, kicker: `In ${st.big.short}`, chip: lv,
      line: lv === nowLv ? `${lv} now and in a big storm. In a storm like that, the ground here scores above ${pctAbove}% of the land in ${REG.places}.`
        : `${nowLv} for the next few days, ${lv.toLowerCase()} in a big storm. Then the ground here scores above ${pctAbove}% of the land in ${REG.places}.`,
      stats: [[fmt(ls.vBig) + '/100', 'model score in that storm'], [nowLv, 'next few days'], [ls.tipWet ? `${fmt(ls.tipWet)} mm` : ls.tipWet === 0 ? 'Soaked soil' : '400+ mm', 'rain that tips it to Elevated']],
      todo: ls.vBig >= 50 || ls.vNext >= 50 ? ['Before winter: clear gutters and drains, and send roof water away from the slope.', `When ${ls.tipWet ? rainTxt(ls.tipWet) : 'heavy rain'} or more is forecast: watch for new cracks, tilting fences, doors that stick, muddy water. Be ready to leave.`, 'If the ground is moving, leave right away and call 911.', 'During heavy rain at night, stay awake and listen. Many debris flows happen while people sleep.', ALERTS()]
        : ['No slope is guaranteed safe. Watch for new cracks or tilting after big storms.', ALERTS()],
      how: [`From the trained landslide model: 300 decision trees learned from 1,398 slides the USGS mapped in the 2016 to 2017 storms. It looks at the ${ls.cells} ground cells (about 30 m each) within about 60 m of the address and reports the riskiest.`,
        `When to watch: once the soil is soaked, ${watch} pushes the slope near you to Elevated.` + (ls.tipWet ? ` That much rain fell about ${ls.times} ${ls.times === 1 ? 'time' : 'times'} since ${ls.since}${ls.lastDate ? ', most recently around ' + ls.lastDate : ''}.` + (fc ? (fc.max3 >= ls.tipWet ? ' The current forecast reaches that amount.' : ` The current forecast (${rainTxt(fc.max3)}) stays below it.`) : '') : ''),
        `Next few days uses ${st.next.name}: ${rainTxt(st.next.r72)}, on soil as wet as the gauges measured on ${dstr(st.asOf)}. The big storm is ${st.big.name}: ${rainTxt(st.big.r72)} in 3 days on soaked soil.`,
        `Scores: ${fmt(ls.vNext, 1)} and ${fmt(ls.vBig, 1)} out of 100. Low under 25, Guarded 25 to 50, Elevated 50 to 75, High 75 and up. These rank ground against other ground. They are not the chance of a slide.`,
        `Steepest ground within 60 m: ${fmt(ls.slope)} degrees. Nearest creek: ${ls.creek >= 1000 ? 'over 1 km' : 'about ' + creekTxt(ls.creek)} away.`,
        root.GTLocalModel && root.GTLocalModel.report ? (r => `Checked on 11 winter 2023 slides it never saw: on average a slide site scored above ${Math.round(r.holdout_winter2023.tuned.mean_land_percentile * 100)}% of the land (slope steepness alone: ${Math.round(r.holdout_winter2023.slope_alone.mean_land_percentile * 100)}%). Promising, not proven.`)(root.GTLocalModel.report) : '',
        'For a real concern, call your city engineering staff or a licensed geotechnical engineer.'],
      actions: [['Open the slope behind you', open('inspect', () => app.select && app.select(hit.lon, hit.lat))]] };
  } });

  API.addMeasure({ id: 'flood', order: 20, run(c) {
    const { hit, fc } = c, fl = flood(hit), creek = c.prior.landslideRaw ? c.prior.landslideRaw.creek : null;
    if (fl.area !== 'ok' && root.GTFloodL && root.GTFloodL.at(hit.lon, hit.lat)) {   /* Lamorinda flood score (floodl.js) */
      const st = c.storms, FL = root.GTFloodL, f = FL.at(hit.lon, hit.lat), M = FL.meta, chk = M.checks || [], rc = M.rain_checks || [];
      const sNext = f.at(st.next.r72, st.next.api), sBig = f.at(st.big.r72, st.big.api), cTxt = f.creekM >= 1000 ? 'over 1 km' : f.creekM < 20 ? 'right beside you' : fmt(Math.round(f.creekM / 10) * 10) + ' m';
      const rs = rc.map(r => r.r72).sort((a, b) => a - b);
      return { title: 'Flooding', icon: 'flood', level: f.level, score: sBig, kicker: `In ${st.big.short}`, chip: f.level,
        line: (f.fema === '1%' ? `Ground within about 60 m of you is in a FEMA 1% annual chance flood zone${f.floodway ? ' (the floodway)' : ''}.` : f.fema === '0.2%' ? 'Ground within about 60 m of you is in FEMA\'s 0.2% annual chance (500 year) flood zone.' : 'You are outside FEMA\'s mapped flood zones.') + ` More flood-prone than ${fmt(Math.round(f.below * 100))}% of the area.`,
        stats: [[fmt(sBig, 0) + '/100', 'flood score in that storm'], [cTxt, 'to the nearest creek'], [`${fmt(Math.round(f.hand * 2) / 2, 1)} m`, 'above the creek bed']],
        todo: f.level === 'Low' ? ['Keep the storm drain and gutters near you clear of leaves before big storms.', ALERTS()] : ['Before a storm: move cars, valuables and anything that floats out of garages and low rooms, and keep sandbags handy (Lafayette, Orinda and Moraga hand them out before big storms).', 'Never drive or walk through moving water or cross a flooded creek crossing. A foot of moving water can float a car.', 'FEMA flood zones are where flood insurance matters most. Homeowner policies usually do not cover floods.', ALERTS()],
        how: [`Flood score: ${fmt(sNext, 0)} out of 100 for ${st.next.name}, and ${fmt(sBig, 0)} in ${st.big.short}.` + (f.creekName ? ` Nearest creek: ${f.creekName} or a branch of it.` : '') + (f.handMin < f.hand ? ` The lowest ground within 60 m sits about ${fmt(Math.round(f.handMin * 2) / 2, 1)} m above the creek bed.` : ''),
          rs.length ? `When to watch: the creek floods NOAA logged in and around Lamorinda since 2015 came with ${rainTxt(rs[0])} to ${rainTxt(rs[rs.length - 1])} of rain over 3 days.` + (st.next.live ? (st.next.r72 >= rs[0] ? ` The forecast brings ${rainTxt(st.next.r72)}, in that range.` : ` The forecast (${rainTxt(st.next.r72)}) is below that.`) : '') : '',
          'How the score works: FEMA\'s National Flood Hazard Layer zones come first. Outside them, ground that is low (under about 3 m above the nearest USGS-mapped creek) and close to the creek scores higher. A small amount is added for low, wet hollows. The storm factor grows with 3 day rain and how wet the soil already is. Weights are set by hand from these real public layers. It is not trained on past floods, because too few Lamorinda floods have a recorded location to train or fairly test one.',
          chk.length ? `Checked against ${chk.length} NOAA Storm Events flood reports with a location inside the map: ${chk.filter(x => x.score >= 45).length} of them land on ground this score calls Elevated or High (NOAA positions are approximate). That is a thin check, not proof.` : 'There are no located past flood reports inside the map to check it against, so it is untested.',
          `Data: ${M.sources.join('; ')}.`],
        actions: [['Show flood-prone ground on the map', open('top', () => { FL.show(); app.flyTo && app.flyTo(hit.lon, hit.lat, 5.6); })]] };
    }
    if (fl.area !== 'ok') return { title: 'Flooding', icon: 'flood', tone: 'none', big: 'No prediction', chip: 'No model',
      line: `There is no flood model for ${REG.short} yet.`, stats: creek != null ? [[creekTxt(creek), 'to the nearest creek']] : [],
      todo: creek != null && creek < 150 ? ['Creeks can rise fast in heavy rain. Never cross a flooded road or creek.', ALERTS()] : [ALERTS()] };
    const hst = fl.hist || { reports: 0, days: 0 }, pct = fl.rank ? fl.rank / fl.of : 1;
    const level = hst.days >= 5 || pct <= 0.1 ? 'High' : hst.days >= 1 || pct <= 0.33 ? 'Elevated' : 'Low';
    const since = fl.fm.first.slice(0, 4);
    return { title: 'Flooding', icon: 'flood', level, kicker: 'Street flooding near you', chip: level,
      line: hst.days ? `Neighbors within ${fl.fm.radius_m} m reported flooding on ${hst.days} rainy ${hst.days === 1 ? 'day' : 'days'} since ${since}, most recently ${dstr(new Date(hst.last + 'T12:00:00Z'))}.` : `No flooding has been reported to 311 within ${fl.fm.radius_m} m of you on a rainy day since ${since}.`,
      stats: [[fmt(hst.days), 'rainy days with reports'], fl.rank ? [`${fmt(Math.round((1 - pct) * 100))}%`, 'of streets flood less than yours'] : ['–', 'no street score nearby'], hst.days ? [`${fmt(hst.typical)} mm`, 'rain that usually floods it'] : [hst.nov18 ? fmt(hst.nov18) : '0', 'reports on Nov 18, 2026']],
      todo: level === 'Low' ? ['Keep the storm drain in front of you clear of leaves before big storms.', ALERTS()] : ['Before a storm: clear the storm drain, move cars and valuables out of garages and basements, keep sandbags handy (the city gives them out free).', 'Never drive or walk through flooded streets. A foot of moving water can float a car.', 'Report flooding to 311.', ALERTS()],
      how: [hst.days ? `When to watch: flooding near you has usually come after about ${rainTxt(hst.typical)} of rain over 3 days, and once after as little as ${rainTxt(hst.lightest)}.` + (fc ? (fc.max3 >= hst.lightest ? ` The forecast brings ${rainTxt(fc.max3)}, so flooding near you is possible this week.` : ` The forecast (${rainTxt(fc.max3)}) is below that.`) : '') + (hst.nov18 ? ` ${hst.nov18} ${hst.nov18 === 1 ? 'report' : 'reports'} came in the November 18, 2026 storm.` : '') : '',
        fl.rank ? `Our flood model ranks your street, ${fl.street}, ${fmt(fl.rank)} of ${fmt(fl.of)} San Francisco streets for flooding in a storm like November 18, 2026 (1 floods most).` : '',
        `311 history: ${fl.fm.what}. ${fmt(fl.fm.reports)} reports in all. 311 shows where people reported, which is not every place that flooded.`,
        fl.rank ? `Flood model: 300 decision trees trained on 311 flood reports before October 2022. On storms it never saw it scored 0.89 (winter 2023) and 0.91 (November 2026), where 0.5 is a coin flip. Your street scored ${fmt(fl.score, 1)} out of 100 on the ${fmt(fl.rain)} mm storm of November 18, 2026. It is a ranking, not a chance of flooding, and it does not change with the forecast.` : 'No street with a flood model score within 200 m.'],
      actions: [['See how the storm unfolded', open('response')]] };
  } });

  API.addMeasure({ id: 'help', order: 30, run(c) {
    const { hit } = c, hp = help(hit), plan = root.GTRescue ? root.GTRescue.plan(hit.lon, hit.lat) : null; c.prior.helpRaw = hp;
    const first = plan ? plan.stations[0] : null, F = root.GT_FIRE;
    const extra = plan ? (t => { const b = root.GTRescue.block(plan); t.querySelector('.mc-stats') ? t.querySelector('.mc-stats').after(b) : t.appendChild(b); c.after.push(() => root.GTRescue.play(plan, b)); }) : null;
    const todo = ['In an emergency, call 911 right away. Don\'t wait for water or a slide to get worse.', 'Make sure your house number is easy to see from the street, day and night.', 'If you or someone at home needs help to leave, plan that before the storm.'];
    const routeHow = plan ? `The map drives an engine from each of the ${plan.stations.length} stations with the shortest modelled drive (${plan.stations.map(s => s.name).join(', ')}), along the shortest path on the street network. The route only draws the way: the minutes come from the drive-time model, plus ${fmt(plan.turnout, 1)} min, the median time an engine takes to leave the station. Station positions: ${F.stations[0].src.startsWith('Overture') ? 'Overture Maps places' : 'published addresses'}, with published addresses for the few Overture lacks.` + (plan.stations.some(s => s.extrapolated) ? ` Some of these stations are farther than the ${fmt(root.GTRescue.curve(F.meta).fitTo / 1000, 2)} km the model was fitted on, so their times extend its curve in a straight line.` : '') : '';
    if (hp.area === 'ok') {
      const cs = hp.m.check_storm, cv = hp.m.check, slower = cs.median_signed_err_min < 0 ? -cs.median_signed_err_min * 60 : 0;
      const H = root.GT_HELP; let faster = 0; for (const r of H.help) if (r[2] > hp.med) faster++;
      const pf = Math.round(faster / H.help.length * 100);
      return { title: 'Help in a storm', icon: 'help', big: fmt(hp.med, 0), unit: 'min', kicker: 'After a 911 call, first unit on scene', chip: `${fmt(hp.med, 0)} min`,
        level: hp.med > H.meta.help.city.p90 ? 'High' : hp.med > H.meta.help.city.med * 1.25 ? 'Elevated' : '',
        line: `The first fire engine or ambulance usually reaches your block in about ${fmt(hp.med, 0)} minutes. 9 in 10 times it is there within ${fmt(Math.ceil(hp.p90))}.`,
        stats: [[`${fmt(Math.ceil(hp.p90))} min`, '9 in 10 calls'], [`${pf}%`, 'of city blocks wait longer'], [slower >= 15 ? `+${fmt(Math.round(slower / 5) * 5)} s` : 'Same', 'in the Nov 18, 2026 storm']],
        extra, todo,
        how: [`From ${fmt(hp.calls)} real emergency calls (lights and sirens) within ${hp.m.radius_m} m of your block, September 2025 to August 2026: the time from the call being received to the first unit on scene. Typical is the middle call, slow is the 9 in 10 mark.`,
          `In the November 18, 2026 storm, emergency calls across the city were reached ${slower >= 15 ? 'about ' + fmt(Math.round(slower / 5) * 5) + ' seconds slower than usual' : 'about as fast as usual'}, and ${fmt(Math.round((1 - cs.within_slow) * 100))} in 100 took longer than the slow time, against ${fmt(Math.round((1 - cv.within_slow) * 100))} in 100 normally.` + (hp.nb && !hp.nb.few ? ` In ${hp.nb.label}, the typical wait in that storm was ${fmt(hp.nb.storm_med, 1)} minutes against ${fmt(hp.nb.dry_med, 1)} on dry days.` : ''),
          `Checked on ${fmt(cv.n)} October 2026 calls it never saw: ${fmt(cv.within_typical * 100)}% arrived within the typical time and ${fmt(cv.within_slow * 100)}% within the slow time (50% and 90% would be perfect). In the storm window: ${fmt(cs.within_typical * 100)}% and ${fmt(cs.within_slow * 100)}% of ${fmt(cs.n)} calls.`,
          routeHow, plan ? `Drive-time model: ${F.meta.curve_rule} Checked on ${fmt(F.meta.curve_check.n)} October 2026 trips it was not fitted on: median error ${fmt(F.meta.curve_check.mae, 2)} min.` : '',
          'Source: DataSF Fire Department and Emergency Medical Services Dispatched Calls for Service. Call positions are block-level.'],
        actions: [['See help times in the storm', open('response')]] };
    }
    if (hp.area === 'few') return { title: 'Help in a storm', icon: 'help', tone: first ? '' : 'none', badge: first ? 'Modelled' : '', big: first ? fmt(plan.turnout + first.drive, 0) : 'Not enough calls', unit: first ? 'min drive' : '', kicker: first ? 'Modelled drive from the nearest station' : '', chip: first ? `${fmt(plan.turnout + first.drive, 0)} min` : 'Few calls',
      line: `Fewer than ${hp.m.min_calls} emergency calls came from within ${hp.m.radius_m} m in a year, so there is no measured time here. The drive time comes from the drive-time model.`, extra, todo: ['In an emergency, call 911 right away.'], how: [routeHow] };
    /* no 911 records here (Lamorinda): the drive-time estimate, labelled as one */
    if (!first) return { title: 'Help in a storm', icon: 'help', tone: 'none', big: 'No estimate', chip: 'No records', line: `There are no emergency response records for ${REG.short}.`, todo };
    const est = plan.turnout + first.drive;
    return { title: 'Help in a storm', icon: 'help', badge: 'Estimate', big: '≈ ' + fmt(est, 0), unit: 'min drive', kicker: `From ${first.name}, ${first.agency}`, chip: `≈ ${fmt(est, 0)} min`,
      line: `${REG.short} has no public 911 records, so this is an estimate: about ${fmt(est, 0)} minutes for an engine to leave ${first.name} and drive here, before the time it takes to answer the call.`,
      stats: [[`${fmt(first.gridM / 1000, 1)} km`, 'street-grid distance'], [plan.stations[1] ? `${fmt(plan.turnout + plan.stations[1].drive, 0)} min` : '–', 'next station'], ['Estimate', 'not measured here']],
      extra, todo,
      how: [F.meta.note, routeHow, `Drive-time model: ${F.meta.curve_rule} In San Francisco it was checked on ${fmt(F.meta.curve_check.n)} October 2026 trips it was not fitted on (median error ${fmt(F.meta.curve_check.mae, 2)} min). It was never checked in ${REG.short}.`, 'Contra Costa County does not publish dispatch records the way San Francisco does.'] };
  } });

  API.addMeasure({ id: 'wayout', order: 40, run(c) {
    const { hit, storms: st } = c, ro = roadOut(hit, st.big); if (!ro) return null;
    const how = ['From the Getting out view: the named street network, with road segments closed where the map\'s landslide score' + (REG.landslideModel ? ' (the trained model)' : ' (a placeholder formula from slope and rain, since San Francisco has no landslide model)') + ' is Elevated or higher, or where debris traced downhill from risky slopes would cross. It does not know about fallen trees, floods on the road or traffic.'];
    const openRoute = open('evac', () => { if (app.setStorm) app.setStorm(Math.min(300, st.big.r72), Math.min(280, st.big.api)); setTimeout(() => root.GTEvac.pick && root.GTEvac.pick(hit.lon, hit.lat), 400); });
    if (ro.ok) {
      return { title: 'Your way out', icon: 'route', tone: 'ok', level: 'Low', big: 'Open', kicker: `In ${st.big.short}`, chip: 'Open',
        line: `You would still have a road out, leaving the area on ${ro.exit}.`,
        stats: [[`${fmt(ro.km, 1)} km`, 'to leave the area'], [ro.via[0] || '–', 'main road'], [fmt(ro.blockedNearby), 'road segments closed in that storm']],
        todo: ['Know a second way out in case a road you expect is closed.', 'Keep your gas tank at least half full in storm season.', ALERTS()], how: [`The route goes by way of ${ro.via.join(', ')}.`].concat(how), actions: [['Open your route out', openRoute]] };
    }
    const cut = ro.why === 'cut';
    return { title: 'Your way out', icon: 'route', level: cut ? 'High' : '', tone: cut ? '' : 'none', big: cut ? 'Cut off' : 'Not known', kicker: `In ${st.big.short}`, chip: cut ? 'Cut off' : 'Not known',
      line: cut ? `The roads around you could be blocked${ro.names.length ? ' on ' + ro.names.slice(0, 3).join(', ') : ''}, leaving no road out.` : ro.why === 'far' ? 'There is no named street within 250 m of this address in our road data.' : 'This address joins the street network by a road our data does not have (a private road or a driveway), so we cannot trace a route.',
      stats: cut ? [[fmt(ro.blocked), 'road segments closed in that storm']] : [],
      todo: cut ? ['Plan to leave early, before a big storm peaks, rather than wait.', 'Ask a neighbor with a different route out to ride with them (see Neighbor rides).', 'Keep a go-bag ready: water, medicine, phone charger, documents.', ALERTS()] : [ALERTS()],
      how, actions: [cut ? ['Find a neighbor to ride with', open('rides')] : ['Open your route out', openRoute]] };
  } });

  /* measures from scripts that loaded before this one: window.GT_MEASURES = [..]; later ones can push to it too */
  (Array.isArray(root.GT_MEASURES) ? root.GT_MEASURES : []).forEach(m => API.addMeasure(m)); root.GT_MEASURES = { push: m => API.addMeasure(m) };

  function render(hit, fc) {
    const o = out(); o.textContent = ''; o.hidden = false; last = hit; hit._fc = fc;
    const st = storms(fc), C = root.GTCards;
    if (root.GTRescue) root.GTRescue.stop(); Sc.showPath(null);
    const head = document.createElement('div'); head.className = 'addr-head';
    const h = document.createElement('h3'); h.textContent = hit.label; head.appendChild(h);
    const p = document.createElement('p'); p.className = 'note';
    p.textContent = (hit.note ? hit.note + ' ' : '') + (fc ? `Rain forecast, next 7 days: ${rainTxt(fc.total)}. Wettest 3 days: ${rainTxt(fc.max3)}.` : `The live rain forecast did not load, so "next few days" uses the last 3 days of gauge rain, ${rainTxt(st.next.r72)}.`);
    head.appendChild(p); o.appendChild(head);
    const ctx = { hit, fc, storms: st, region: REG, app, scene: Sc, cards: C, prior: {}, after: [] }, made = [];
    for (const m of MEASURES) {
      let spec = null; try { spec = m.run(ctx); } catch (e) { console.error('measure ' + m.id, e); spec = { title: m.title || m.id, icon: m.icon, tone: 'none', big: 'Unavailable', line: 'This answer could not be worked out for this address.' }; }
      if (!spec) continue; spec.id = spec.id || m.id; ctx.prior[m.id] = spec; made.push({ spec, node: C.card(spec) });
    }
    o.appendChild(C.summary(made)); for (const x of made) o.appendChild(x.node);
    { const hv = ctx.prior.helpRaw, y = $("#srYouTxt");
      if (y && hv && hv.area !== 'none') { y.textContent = hv.area === 'ok' ? `At ${hit.label}: help usually arrives in about ${fmt(hv.med, 0)} minutes after a 911 emergency call, and within ${fmt(Math.ceil(hv.p90))} minutes 9 in 10 times. In the November 18, 2026 storm it was about the same, with a few more slow calls.` : `At ${hit.label}: too few emergency calls nearby to estimate a time.`; const b = $('#srYouBtn'); if (b) b.textContent = 'Check another address'; } }
    const f = document.createElement('p'); f.className = 'foot'; f.textContent = 'A student project built on public data. It cannot tell you a home is safe. In danger, leave if you can and call 911. Follow the National Weather Service and your city.'; o.appendChild(f);
    Sc.highlight(hit.lon, hit.lat, true); app.flyTo(hit.lon, hit.lat, 5.6);
    for (const fn of ctx.after) try { fn(); } catch (e) { console.error(e); }
    { const vs = $('#viewScroll'); if (vs && vs.scrollHeight > vs.clientHeight) vs.scrollTo({ top: Math.max(0, head.offsetTop - vs.offsetTop - 8), behavior: 'smooth' }); }
  }
  API.last = () => last;
})(typeof window === 'undefined' ? globalThis : window);
