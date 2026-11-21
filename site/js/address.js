/* escape "Your address": type an address, get plain answers. Landslide risk (Lamorinda, the trained landslide model), flooding
   (San Francisco: the flood model plus 311 flood reports near you), a road out (the Getting out road network) and how long help takes
   to arrive (San Francisco: real emergency calls near you, checked on calls it never saw, and in the November 18, 2026 storm).
   Addresses come from Overture Maps address points packed by scripts/12_address_index.py. The lookup runs in this browser: nothing
   typed here is sent anywhere or stored. The only network call is the rain forecast for the area's centre (Open-Meteo, no key), which
   carries no address. Where a prediction does not exist for an area, the answer says so. */
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

  /* plain words for a 0..100 band */
  const word = v => v >= 75 ? 'High' : v >= 50 ? 'Elevated' : v >= 25 ? 'Guarded' : 'Low';
  function tile(o, head, level, cls, lines, todo, details, more) {
    const t = document.createElement('div'); t.className = 'tile addr-t';
    const h = document.createElement('div'); h.className = 'card-h'; const h3 = document.createElement('h3'); h3.textContent = head; h.appendChild(h3);
    if (level) { const b = document.createElement('span'); b.className = 'tier ' + (cls || ''); b.textContent = level; h.appendChild(b); }
    t.appendChild(h);
    for (const l of lines) { const p = document.createElement('p'); p.className = 'body'; p.textContent = l; t.appendChild(p); }
    if (todo && todo.length) { const ul = document.createElement('ul'); ul.className = 'addr-do'; ul.setAttribute('aria-label', 'What to do'); for (const x of todo) { const li = document.createElement('li'); li.innerHTML = '<svg class="ic ck" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span></span>'; li.lastChild.textContent = x; ul.appendChild(li); } t.appendChild(ul); }
    if (details && details.length) { const d = document.createElement('details'); d.className = 'addr-more'; const s = document.createElement('summary'); s.textContent = 'How we know'; d.appendChild(s); for (const x of details) { const p = document.createElement('p'); p.className = 'note'; p.textContent = x; d.appendChild(p); } t.appendChild(d); }
    if (more) { const r = document.createElement('div'); r.className = 'row'; const b = document.createElement('button'); b.type = 'button'; b.className = 'btn sm'; b.textContent = more[0]; b.addEventListener('click', more[1]); r.appendChild(b); t.appendChild(r); }
    o.appendChild(t); return t;
  }
  const open = (id, then) => () => { app.go(id); if (then) setTimeout(then, 80); };
  const ALERTS = () => REG.id === 'sf' ? 'Sign up for AlertSF emergency texts (text ALERTSF to 888-777).' : 'Sign up for Contra Costa County Community Warning System alerts (cwsalerts.com).';

  function render(hit, fc) {
    const o = out(); o.textContent = ''; o.hidden = false; last = hit;
    const st = storms(fc);
    const head = document.createElement('div'); head.className = 'addr-head';
    const h = document.createElement('h3'); h.textContent = hit.label; head.appendChild(h);
    const p = document.createElement('p'); p.className = 'note';
    p.textContent = (hit.note ? hit.note + ' ' : '') + (fc ? `Rain forecast for the next 7 days: ${rainTxt(fc.total)}. The wettest 3 days bring ${rainTxt(fc.max3)}.` : `The live rain forecast did not load, so "next few days" uses the last 3 days of gauge rain, ${rainTxt(st.next.r72)}.`);
    head.appendChild(p); o.appendChild(head);

    /* landslides */
    const ls = landslide(hit, st);
    if (ls.area === 'ok') {
      const lv = word(ls.vBig), nowLv = word(ls.vNext);
      const lines = [`Next few days: ${nowLv.toLowerCase()}. In ${st.big.short}: ${lv.toLowerCase()}. In a storm like that, the ground at your address scores higher than ${fmt(Math.max(0, Math.min(100, (1 - ls.top) * 100)))}% of the land in ${REG.places}.`];
      if (ls.tipWet === 0) lines.push('The slope near you scores Elevated even before more rain falls when the soil is soaked.');
      else if (ls.tipWet != null) lines.push(`When to watch: once the soil is soaked, about ${rainTxt(ls.tipWet)} of rain in 3 days pushes the slope near you to Elevated. That much rain fell about ${ls.times} ${ls.times === 1 ? 'time' : 'times'} since ${ls.since}${ls.lastDate ? ', most recently around ' + ls.lastDate : ''}.` + (fc ? (fc.max3 >= ls.tipWet ? ' The current forecast reaches that amount.' : ` The current forecast (${rainTxt(fc.max3)}) stays below it.`) : ''));
      else lines.push('Even 400 mm of rain in 3 days keeps the slope near you below Elevated.');
      const todo = ls.vBig >= 50 || ls.vNext >= 50 ? ['Before winter: clear gutters and drains, and send roof water away from the slope.', `When ${ls.tipWet ? rainTxt(ls.tipWet) : 'heavy rain'} or more is forecast: watch for new cracks, tilting fences or walls, doors that stick, and muddy water. Be ready to leave.`, 'During heavy rain at night, stay awake and listen. Many debris flows happen while people sleep.', ALERTS(), 'If the ground is moving, leave right away and call 911.']
        : ['Your slope is not among the riskiest, but no slope is guaranteed safe. Watch for new cracks or tilting after big storms.', ALERTS()];
      tile(o, 'Landslides', lv === nowLv ? lv : `${nowLv} now · ${lv} in a big storm`, lv, lines, todo, [
        `From the trained landslide model: 300 decision trees learned from 1,398 slides the USGS mapped in the 2016 to 2017 storms. It looks at the ${ls.cells} ground cells (about 30 m each) within about 60 m of the address and reports the riskiest.`,
        `Next few days uses ${st.next.name}: ${rainTxt(st.next.r72)}, on soil as wet as the gauges measured on ${dstr(st.asOf)}. The big storm is ${st.big.name}: ${rainTxt(st.big.r72)} in 3 days on soaked soil.`,
        `Scores: ${fmt(ls.vNext, 1)} and ${fmt(ls.vBig, 1)} out of 100. Low under 25, Guarded 25 to 50, Elevated 50 to 75, High 75 and up. These rank ground against other ground. They are not the chance of a slide.`,
        `Steepest ground within 60 m: ${fmt(ls.slope)} degrees. Nearest creek: ${ls.creek >= 1000 ? 'over 1 km' : 'about ' + fmt(Math.round(ls.creek / 10) * 10) + ' m'} away.`,
        root.GTLocalModel && root.GTLocalModel.report ? (r => `Checked on 11 winter 2023 slides it never saw: on average a slide site scored above ${Math.round(r.holdout_winter2023.tuned.mean_land_percentile * 100)}% of the land (slope steepness alone: ${Math.round(r.holdout_winter2023.slope_alone.mean_land_percentile * 100)}%). Promising, not proven.`)(root.GTLocalModel.report) : '',
        'For a real concern, call your city engineering staff or a licensed geotechnical engineer.'].filter(Boolean), ['Open the slope behind you', open('inspect', () => app.select && app.select(hit.lon, hit.lat))]);
    } else {
      tile(o, 'Landslides', 'No prediction here', '', [ls.area === 'edge' ? 'This address is at the edge of our map, so we have no landslide score for it.' : `We don't have a landslide prediction for ${REG.short} yet. Too few slides have been recorded here to train one, so we won't guess.`].concat(ls.slope != null ? [`What we can say from real terrain: the steepest ground within 60 m of you slopes about ${fmt(ls.slope)} degrees${ls.slope >= 25 ? ', which is steep. Steep ground near homes is where slides usually start' : ls.slope >= 15 ? ', a moderate slope' : ', fairly gentle'}.`] : []),
        ls.slope >= 15 ? ['After heavy rain, watch for new cracks, tilting walls or fences, and muddy runoff.', ALERTS()] : [ALERTS()], ['The map draws a placeholder score from slope and rain, which is not a trained prediction, so it is not used here.']);
    }

    /* flooding */
    const fl = flood(hit);
    if (fl.area === 'ok') {
      const hst = fl.hist || { reports: 0, days: 0 }, pct = fl.rank ? fl.rank / fl.of : 1;
      const level = hst.days >= 5 || pct <= 0.1 ? 'High' : hst.days >= 1 || pct <= 0.33 ? 'Elevated' : 'Low';
      const lines = [];
      if (hst.days) lines.push(`Neighbors within ${fl.fm.radius_m} m have reported flooding to 311 on ${hst.days} rainy ${hst.days === 1 ? 'day' : 'days'} since ${fl.fm.first.slice(0, 4)}, most recently ${dstr(new Date(hst.last + 'T12:00:00Z'))}.` + (hst.nov18 ? ` ${hst.nov18} ${hst.nov18 === 1 ? 'report' : 'reports'} came in the November 18, 2026 storm.` : ''));
      else lines.push(`No flooding has been reported to 311 within ${fl.fm.radius_m} m of you on a rainy day since ${fl.fm.first.slice(0, 4)}.`);
      if (hst.days) lines.push(`When to watch: flooding near you has usually come after about ${rainTxt(hst.typical)} of rain over 3 days, and once after as little as ${rainTxt(hst.lightest)}.` + (fc ? (fc.max3 >= hst.lightest ? ` The forecast brings ${rainTxt(fc.max3)}, so flooding near you is possible this week.` : ` The forecast (${rainTxt(fc.max3)}) is below that.`) : ''));
      if (fl.rank) lines.push(`Our flood model ranks your street, ${fl.street}, ${fmt(fl.rank)} of ${fmt(fl.of)} San Francisco streets for flooding in a storm like November 18, 2026 (1 floods most).`);
      tile(o, 'Flooding', level, level, lines,
        level === 'Low' ? ['Keep the storm drain in front of you clear of leaves before big storms.', ALERTS()] : ['Before a storm: clear the storm drain near you, move cars and valuables out of garages and basements, and keep sandbags handy (the city gives them out free during storms).', 'Never drive or walk through flooded streets. A foot of moving water can float a car.', 'Report flooding to 311.', ALERTS()],
        [`311 history: ${fl.fm.what}. ${fmt(fl.fm.reports)} reports in all. 311 shows where people reported, which is not every place that flooded.`,
          fl.rank ? `Flood model: 300 decision trees trained on 311 flood reports before October 2022. On storms it never saw it scored 0.89 (winter 2023) and 0.91 (November 2026), where 0.5 is a coin flip. Your street scored ${fmt(fl.score, 1)} out of 100 on the ${fmt(fl.rain)} mm storm of November 18, 2026. It is a ranking, not a chance of flooding, and it does not change with the forecast.` : 'No street with a flood model score within 200 m.'], ['See how the storm unfolded', open('response')]);
    } else {
      tile(o, 'Flooding', 'No prediction here', '', [`We don't have a flood prediction for ${REG.short} yet.` + (ls.creek != null ? ` Nearest creek: ${ls.creek >= 1000 ? 'over 1 km away' : 'about ' + fmt(Math.round(ls.creek / 10) * 10) + ' m away'}.` : '')],
        ls.creek != null && ls.creek < 150 ? ['Creeks can rise fast in heavy rain. Never cross a flooded road or creek.', ALERTS()] : [ALERTS()], []);
    }

    /* help arrival */
    const hp = help(hit);
    if (hp.area === 'ok') {
      const cs = hp.m.check_storm, cv = hp.m.check, slower = cs.median_signed_err_min < 0 ? -cs.median_signed_err_min * 60 : 0;
      const lines = [`After you call 911 for an emergency, the first fire truck or ambulance usually reaches your block in about ${fmt(hp.med, 0)} minutes. 9 in 10 times it arrives within ${fmt(Math.ceil(hp.p90))} minutes.`,
        `In a storm: during the November 18, 2026 storm, emergency calls across the city were reached ${slower >= 15 ? 'about ' + fmt(Math.round(slower / 5) * 5) + ' seconds slower than usual' : 'about as fast as usual'}, and ${fmt(Math.round((1 - cs.within_slow) * 100))} in 100 took longer than the slow time, against ${fmt(Math.round((1 - cv.within_slow) * 100))} in 100 normally. So expect about ${fmt(hp.med, 0)} minutes, and up to ${fmt(Math.ceil(hp.p90))} or a little more.`];
      if (hp.nb && !hp.nb.few) lines.push(`In ${hp.nb.label}, the typical wait in that storm was ${fmt(hp.nb.storm_med, 1)} minutes against ${fmt(hp.nb.dry_med, 1)} on dry days.`);
      tile(o, 'Help arriving', `About ${fmt(hp.med, 0)} min`, '', lines,
        ['In an emergency, call 911 right away. Don\'t wait for water or a slide to get worse.', 'Make sure your house number is easy to see from the street, day and night.', 'If you or someone at home needs help to leave, plan that before the storm.'],
        [`From ${fmt(hp.calls)} real emergency calls (lights and sirens) within ${hp.m.radius_m} m of your block, September 2025 to August 2026: the time from the call being received to the first unit on scene. Typical is the middle call, slow is the 9 in 10 mark.`,
          `Checked on ${fmt(cv.n)} October 2026 calls it never saw: ${fmt(cv.within_typical * 100)}% arrived within the typical time and ${fmt(cv.within_slow * 100)}% within the slow time (50% and 90% would be perfect). In the storm window: ${fmt(cs.within_typical * 100)}% and ${fmt(cs.within_slow * 100)}% of ${fmt(cs.n)} calls.`,
          'Source: DataSF Fire Department and Emergency Medical Services Dispatched Calls for Service. Call positions are block-level.'], ['See help times in the storm', open('response')]);
    } else if (hp.area === 'few') {
      tile(o, 'Help arriving', 'Not enough calls', '', [`Fewer than ${hp.m.min_calls} emergency calls came from within ${hp.m.radius_m} m of this address in a year, so we can't give a reliable time.`], ['In an emergency, call 911 right away.'], []);
    } else {
      tile(o, 'Help arriving', 'No estimate here', '', [`We don't have emergency response records for ${REG.short}, so we can't say how long help would take to reach you. The county does not publish them the way San Francisco does.`], ['In an emergency, call 911 right away. Don\'t wait for things to get worse.', 'Make sure your house number is easy to see from the street.', 'If anyone at home needs help to leave, plan that before the storm.'], []);
    }

    /* road out */
    const ro = roadOut(hit, st.big);
    if (ro) {
      if (ro.ok) {
        tile(o, 'Your way out', ro.blockedNearby ? 'You have a way out' : 'Roads open', 'Low', [`In ${st.big.short}, you would still have a road out: about ${fmt(ro.km, 1)} km by way of ${ro.via.join(', ')}, leaving the area on ${ro.exit}. The map shows the route.`],
          ['Know a second way out in case a road you expect is closed.', 'Keep your gas tank at least half full in storm season.', ALERTS()],
          ['From the Getting out view: the named street network, with road segments closed where the map\'s landslide score' + (REG.landslideModel ? ' (the trained model)' : ' (a placeholder formula from slope and rain, since San Francisco has no landslide model)') + ' is Elevated or higher, or where debris traced downhill from risky slopes would cross. It does not know about fallen trees, floods on the road or traffic.'], ['Open your route out', open('evac', () => { if (app.setStorm) app.setStorm(Math.min(300, st.big.r72), Math.min(280, st.big.api)); setTimeout(() => root.GTEvac.pick && root.GTEvac.pick(hit.lon, hit.lat), 400); })]);
        if (ro.line.length > 1) Sc.showPath(ro.line);
      } else {
        tile(o, 'Your way out', ro.why === 'cut' ? 'Could be cut off' : 'Not known', ro.why === 'cut' ? 'High' : '', [ro.why === 'cut' ? `In ${st.big.short}, the roads around you could be blocked${ro.names.length ? ' on ' + ro.names.slice(0, 3).join(', ') : ''}, leaving no road out.` : ro.why === 'far' ? 'There is no named street within 250 m of this address in our road data.' : 'This address connects to the street network through a road our data does not have (a private road or a driveway), so we cannot trace a route.'],
          ro.why === 'cut' ? ['Plan to leave early, before a big storm peaks, rather than wait.', 'Ask a neighbor with a different route out if you can ride with them (see Neighbor rides).', 'Keep a go-bag ready: water, medicine, phone charger, documents.', ALERTS()] : [ALERTS()],
          ['From the Getting out view, which closes road segments where the map\'s landslide score' + (REG.landslideModel ? ' (the trained model)' : ' (a placeholder formula from slope and rain, since San Francisco has no landslide model)') + ' is Elevated or higher or where traced debris would cross.'], ro.why === 'cut' ? ['Find a neighbor to ride with', open('rides')] : ['Open your route out', open('evac', () => { if (app.setStorm) app.setStorm(Math.min(300, st.big.r72), Math.min(280, st.big.api)); setTimeout(() => root.GTEvac.pick && root.GTEvac.pick(hit.lon, hit.lat), 400); })]);
      }
    }

    { const y = $('#srYouTxt'); if (y && hp.area !== 'none') { y.textContent = hp.area === 'ok' ? `At ${hit.label}: help usually arrives in about ${fmt(hp.med, 0)} minutes after a 911 emergency call, and within ${fmt(Math.ceil(hp.p90))} minutes 9 in 10 times. In the November 18, 2026 storm it was about the same, with a few more slow calls.` : `At ${hit.label}: too few emergency calls nearby to estimate a time.`; const b = $('#srYouBtn'); if (b) b.textContent = 'Check another address'; } }
    const f = document.createElement('p'); f.className = 'foot'; f.textContent = 'A student project built on public data. It cannot tell you a home is safe. In danger, leave if you can and call 911. Follow the National Weather Service and your city.'; o.appendChild(f);
    Sc.highlight(hit.lon, hit.lat, true); app.flyTo(hit.lon, hit.lat, 5.6);
    { const vs = $('#viewScroll'); if (vs && vs.scrollHeight > vs.clientHeight) vs.scrollTo({ top: Math.max(0, head.offsetTop - vs.offsetTop - 8), behavior: 'smooth' }); }
  }
  API.last = () => last;
})(typeof window === 'undefined' ? globalThis : window);
