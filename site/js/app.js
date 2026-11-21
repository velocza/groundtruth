/* escape dashboard logic: view switching, storm controls, 2023 replay, slope inspector, street agent. */
(async function () {
  const G = window.GT, Mo = window.GTModel, Sc = window.GTScene;
  const $ = s => document.querySelector(s), $$ = s => Array.from(document.querySelectorAll(s));
  const REG = window.GT_REGION || { id: 'lamorinda', short: 'Lamorinda', places: 'Lafayette, Orinda and Moraga', placesOr: 'Lafayette, Orinda or Moraga', motion: true, towns: [['Lafayette', -122.118, 37.886], ['Orinda', -122.183, 37.877], ['Moraga', -122.130, 37.835]] };
  const TOWNS = G.meta.towns || REG.towns, TOWN_NAMES = TOWNS.map(t => t[0]);     // named parts of the area shown
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt = (v, d) => Number(v).toLocaleString('en-US', { maximumFractionDigits: d || 0, minimumFractionDigits: d || 0 });
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d; };
  const dstr = d => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;

  try { await Mo.load(); Sc.build($('#gl')); }
  catch (err) { $('#loading p').textContent = 'The 3D map could not start in this browser. The rest of the page still works.'; $('#loading .bar').hidden = true; setTimeout(() => $('#loading').classList.add('off'), 2600); console.error(err); return; }
  Sc.setReduced(reduce);
  const U = Sc.u;

  /* ------------------------------------------------ scenario state */
  const S = { r72: 60, api: 120, era: 0, amt: 0 };                 // what the storm panel is set to (used by the agent too)
  let localSimulation = null;
  let backendState = null;
  async function backendStreet(k, r72, api) {
    if (!backendState || REG.id !== 'lamorinda') return null;       // the Python backend scores Lamorinda streets only
    const res = await fetch('/api/predict', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({street_id:k, rain_72h_mm:Math.max(0,Math.min(400,r72)), api_mm:Math.max(0,Math.min(280,api))})});
    if (!res.ok) throw new Error('Server prediction failed.');
    return (await res.json()).prediction;
  }
  const view = { r72: 60, api: 120 };                              // tweened copy that feeds the shader
  function pushScenario(sc, fast) {
    U.uEra.value = sc.era; U.uAmt.value = sc.amt;
    gsap.to(view, { r72: sc.r72, api: sc.api, duration: fast ? 0.15 : 0.6, ease: 'power2.out', overwrite: true,
      onUpdate() { U.uR72.value = view.r72; U.uApi.value = view.api; Sc.rain.value = Math.min(1, view.r72 / 220); } });
    if (LSM) { const lay = Mo.lsLayer(sc); if (lay !== lsShown) { lsShown = lay; if (!(window.GTFloodL && GTFloodL.on)) Sc.setLandslide(lay, !fast); } }   // the trained model's map for this storm
  }
  const LSM = Mo.landslide();                                      // Lamorinda: the map, chips and backtest use the trained landslide model
  let lsShown = null;

  /* ------------------------------------------------ rain record helpers (real gauges) */
  const R23 = G.rain.wy2023, RNOW = G.rain.recent;
  const next72 = (rec, d) => (rec.mm[d + 1] || 0) + (rec.mm[d + 2] || 0) + (rec.mm[d + 3] || 0);
  const D0 = 80, D1 = 181;                                         // Dec 20, 2022 to Mar 31, 2023
  const wetCum = []; { let c = 0; for (let d = 0; d < R23.mm.length; d++) { c += Math.max(0, R23.api[d] - 60); wetCum.push(c); } }
  const seasonCum = []; { let c = 0; for (const v of R23.mm) { c += v || 0; seasonCum.push(c); } }
  const replaySc = d => ({ r72: next72(R23, d), api: R23.api[d], era: 1, amt: Math.min(1, wetCum[d] / wetCum[D1]) });
  let peakDay = D0; { let best = -1; for (let d = D0; d <= D1; d++) { const sc = replaySc(d), T = 0.55 * Math.min(1.5, sc.r72 / 200) + 0.45 * Math.min(1.3, sc.api / 200); if (T > best) { best = T; peakDay = d; } } }
  const lastNow = RNOW.mm.length - 1;
  const PRESETS = {
    today: () => ({ r72: RNOW.mm[lastNow] + RNOW.mm[lastNow - 1] + RNOW.mm[lastNow - 2], api: RNOW.api[lastNow] }),
    nye: () => ({ r72: next72(R23, 90), api: R23.api[90] }),
    peak: () => ({ r72: next72(R23, peakDay), api: R23.api[peakDay] }),
    dry: () => ({ r72: 0, api: 6 })
  };
  { const pd = addDays(R23.start, peakDay); $('[data-preset=peak]').textContent = `${MONTHS[pd.getUTCMonth()]} ${pd.getUTCDate()}, ${pd.getUTCFullYear()}`; }

  /* ------------------------------------------------ hindcast: every day of the real gauge record since Oct 2015, scored with today's ground */
  const RL = window.GT_RAIN, HN = RL.mm.length;
  const hsc = d => ({ r72: (RL.mm[d + 1] || 0) + (RL.mm[d + 2] || 0) + (RL.mm[d + 3] || 0), api: RL.api[d], era: 0, amt: 0 });
  const hT = Float32Array.from({ length: HN }, (_, d) => Mo.Tof(hsc(d)));
  const hWY = Int16Array.from({ length: HN }, (_, d) => { const t = addDays(RL.start, d); return t.getUTCFullYear() + (t.getUTCMonth() >= 9 ? 1 : 0); });
  /* season rain to date against the same date in the other water years of the gauge record */
  function seasonStats(d) {
    const doy = k => { const t = addDays(RL.start, k), y = t.getUTCFullYear() - (t.getUTCMonth() >= 9 ? 0 : 1); return Math.round((t - new Date(Date.UTC(y, 9, 1, 12))) / 864e5); };
    const n = doy(d); let total = 0; for (let k = d - n; k <= d; k++) total += RL.mm[k] || 0;
    const others = []; for (let k = 0; k < HN; k++) if (doy(k) === 0 && k + n < HN && k !== d - n) { let s = 0; for (let j = k; j <= k + n; j++) s += RL.mm[j] || 0; others.push(s); }
    const mean = others.length ? others.reduce((a, b) => a + b, 0) / others.length : 0;
    return { total, mean, pct: mean > 0 ? total / mean * 100 : null, years: others.length };
  }
  let timing = null;                                               // set once the slide lists exist: how many dated slides followed a top 5% trigger day
  function hindcast(score) {                                       // score(sc) -> 0..100
    const years = {}; let el = 0, hi = 0, worst = -1, wd = 0;
    for (let y = hWY[0]; y <= hWY[HN - 1]; y++) years[y] = [0, 0];
    const tMin = LSM ? -1 : (-Mo.opts.bias - 6) / 7.1 - 0.01;       // placeholder: below this trigger the score cannot reach 50 even on the steepest, fastest cell
    for (let d = 0; d < HN - 3; d++) { if (hT[d] < tMin) continue; const v = score(hsc(d)); if (v > worst) { worst = v; wd = d; } if (v >= 75) { hi++; years[hWY[d]][1]++; } else if (v >= 50) { el++; years[hWY[d]][0]++; } }
    return { years, el, hi, worst, worstDate: dstr(addDays(RL.start, wd)) };
  }

  /* ------------------------------------------------ storm panel */
  const r72El = $('#r72'), apiEl = $('#api');
  const fill = el => { const f = (el.value - el.min) / (el.max - el.min); el.style.setProperty('--fill', (f * 100) + '%'); el.style.setProperty('--tw', Math.round(8 + f * Math.max(0, el.clientWidth - 16)) + 'px'); };
  const refill = () => $$('input[type=range]').forEach(fill);
  let statTimer = 0, lastRank = null, lastArea = null, lastBld = null, listTab = 'top';
  const store = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  let watch = store.get('gt.watch', []).filter(n => G.streets.some(s => s.n === n));
  const stormSc = () => ({ r72: S.r72, api: S.api, era: 0, amt: 0 });
  const tipText = (el, hi) => el === 0 && hi === 0 ? 'Already High before any more rain' : el === 0 ? (hi == null ? 'Already Elevated. High needs more than 400 mm' : `Already Elevated. High at ${hi} mm`) : el == null ? 'Stays below Elevated even at 400 mm' : hi == null ? `Elevated at ${el} mm. High needs more than 400 mm` : `Elevated at ${el} mm, High at ${hi} mm`;
  function streetRow(s, mine) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.innerHTML = `<span class="nm"></span><span class="tw"></span><span class="tier ${Mo.tier(s.score)}">${fmt(s.score)}</span>`;
    b.querySelector('.nm').textContent = s.name; b.querySelector('.tw').textContent = s.town;
    b.setAttribute('aria-label', `${s.name}, ${s.town}, score ${fmt(s.score)}. Show on map.`);
    b.addEventListener('click', () => flyToStreet(s.k)); li.appendChild(b);
    if (mine) {
      const sc = stormSc(), t = document.createElement('span'); t.className = 'tip-mm'; t.textContent = tipText(Mo.tipStreet(s.k, sc, 50), Mo.tipStreet(s.k, sc, 75)) + ' of rain in 72 hours'; b.appendChild(t);
      const x = document.createElement('button'); x.className = 'x'; x.textContent = 'Remove'; x.setAttribute('aria-label', 'Stop watching ' + s.name); x.addEventListener('click', () => toggleWatch(s.name)); li.className = 'mine'; li.appendChild(x);
    }
    return li;
  }
  function renderList() {
    const ul = $('#topStreets'); ul.textContent = ''; if (!lastRank) return;
    const mine = listTab === 'mine', rows = mine ? lastRank.all.filter(s => watch.includes(s.name)).slice(0, 8) : lastRank.top;
    for (const s of rows) ul.appendChild(streetRow(s, mine));
    $('#mineEmpty').hidden = !(mine && !rows.length);
    $('#tabTop').setAttribute('aria-pressed', !mine); $('#tabMine').setAttribute('aria-pressed', mine); $('#tabMine').textContent = watch.length ? `My streets (${watch.length})` : 'My streets';
  }
  function toggleWatch(name) { watch = watch.includes(name) ? watch.filter(n => n !== name) : [...watch, name]; store.set('gt.watch', watch); renderList(); return watch.includes(name); }
  $('#tabTop').addEventListener('click', () => { listTab = 'top'; renderList(); }); $('#tabMine').addEventListener('click', () => { listTab = 'mine'; renderList(); });
  function stormStats() {
    const sc = stormSc();
    lastArea = Mo.areaStats(sc); lastRank = Mo.rankStreets(sc, 6);
    lastBld = Mo.buildingsAt(sc);
    $('#stHigh').textContent = fmt(lastArea.highKm2, 1); $('#stStreets').textContent = fmt(lastRank.elevated); $('#stBld').textContent = fmt(lastBld.el + lastBld.hi);
    $('#stThr').textContent = fmt(S.r72 / 201 * 100) + '%';
    { const T = Mo.Tof(sc); let n = 0, last = -1; for (let d = 0; d < HN - 3; d++) if (hT[d] >= T) { n++; last = d; }
      $('#stHist').textContent = n ? `The gauges saw rain and soil this wet or wetter on ${fmt(n)} of ${fmt(HN - 3)} days since October 2015, most recently ${dstr(addDays(RL.start, last))}.` + (timing && T >= timing.p95 ? ` That is in the wettest 5% of days, the band that ${timing.hit} of the ${timing.n} dated slides in this project followed within three days.` : '') : 'Nothing in the gauge record since October 2015 matches rain and soil this wet.'; }
    renderList();
  }
  function setStorm(r72, api, fromUser) {
    S.r72 = Math.round(r72); S.api = Math.round(api);
    r72El.value = S.r72; apiEl.value = S.api; fill(r72El); fill(apiEl);
    $('#r72v').textContent = S.r72; $('#apiv').textContent = S.api; { const x = $('#exR72'); x.value = S.r72; fill(x); $('#exR72v').textContent = S.r72; $('#kpR72').textContent = S.r72; $('#kpApi').textContent = S.api; }
    if (active === 'storm' || active === 'ask' || active === 'inspect' || exploring) pushScenario({ r72: S.r72, api: S.api, era: 0, amt: 0 }, fromUser);
    clearTimeout(statTimer); statTimer = setTimeout(stormStats, fromUser ? 90 : 0);
    if (sel) renderInspector();
    if (window.GTEvac && GTEvac.onStorm) GTEvac.onStorm();
    if (window.GTRides && GTRides.storm) GTRides.storm(S.r72, S.api);
  }
  r72El.addEventListener('input', () => setStorm(+r72El.value, S.api, true));
  $('#exR72').addEventListener('input', e => setStorm(+e.target.value, S.api, true));
  { const dl = $('#exStreets'), seen = new Set(); for (const s of G.streets) { if (seen.has(s.n)) continue; seen.add(s.n); const o = document.createElement('option'); o.value = s.n; dl.appendChild(o); }
    $('#exFindF').addEventListener('submit', e => { e.preventDefault(); const q = $('#exFind').value.trim().toLowerCase(), out = $('#exFindOut'); if (!q) return;
      if (window.GTAddress && GTAddress.check) { GTAddress.check($('#exFind').value.trim()); $('#exFind').value = ''; return; }   // the top search is the address check
      let k = G.streets.findIndex(s => s.n.toLowerCase() === q); if (k < 0) k = G.streets.findIndex(s => s.n.toLowerCase().startsWith(q)); if (k < 0) k = G.streets.findIndex(s => s.n.toLowerCase().includes(q));
      if (k < 0) { out.textContent = 'No street by that name on this map.'; return; }
      const r = Mo.streetScore(k, stormSc()); flyToStreet(k); if (!r) { out.textContent = G.streets[k].n + ": at the edge of the map, no score."; return; } out.textContent = `${G.streets[k].n}, ${G.streets[k].t || ''}: ${Math.round(r.score)} ${Mo.tier(r.score)}`.replace(', :', ':'); clearTimeout(out._t); out._t = setTimeout(() => out.textContent = '', 6000); }); }
  apiEl.addEventListener('input', () => setStorm(S.r72, +apiEl.value, true));
  const stormPicks = [];
  { /* storm library: the wettest independent storms in the gauge record, at least two weeks apart */
    const order = Array.from({ length: HN - 3 }, (_, d) => d).sort((a, b) => hT[b] - hT[a]), picks = stormPicks;
    for (const d of order) { if (picks.length >= 8) break; if (picks.every(p => Math.abs(p - d) >= 14)) picks.push(d); }
    const sel = $('#stormLib');
    for (const d of picks) { const sc = hsc(d), o = document.createElement('option'); o.value = d; o.textContent = `${dstr(addDays(RL.start, d))}: ${fmt(sc.r72)} mm, soil ${fmt(sc.api)}`; sel.appendChild(o); }
    sel.addEventListener('change', () => { if (sel.value === '') return; const sc = hsc(+sel.value); setStorm(Math.min(300, Math.round(sc.r72)), Math.min(280, Math.round(sc.api)), true); });
  }
  $$('[data-preset]').forEach(b => b.addEventListener('click', () => {
    const p = PRESETS[b.dataset.preset](), o = { r: S.r72, a: S.api };
    gsap.to(o, { r: Math.min(300, p.r72), a: Math.min(280, p.api), duration: reduce ? 0 : 0.9, ease: 'power3.out', onUpdate: () => setStorm(o.r, o.a, true) });
  }));

  /* ------------------------------------------------ street highlight + camera flights */
  let streetOn = -1;
  function flyToStreet(k) {
    const st = G.streets[k], mid = st.p[Math.floor(st.p.length / 2)];
    Sc.showStreet(st.g); Sc.highlight(mid[0], mid[1], true); U.uHiR.value = 0.02; streetOn = k;
    gsap.to(U.uRoads, { value: 1, duration: 0.5 });
    flyTo(mid[0], mid[1], 5.2);
  }
  function flyTo(lon, lat, dist) {
    dist = dist || 4.2; const p = Sc.focusPose(lon, lat, dist * 0.5, $('#inspector').classList.contains('on') && $('.stage').clientWidth > 700 ? -0.14 : 0);
    if (exploring) { gsap.to(Sc.orbit, { tx: p.tx, tz: p.tz, dist: dist * 0.42, duration: reduce ? 0 : 1.4, ease: 'power3.inOut' }); }
    else gsap.to(Sc.cam, { ...p, duration: reduce ? 0 : 1.6, ease: 'power3.inOut', overwrite: 'auto' });
  }

  /* ------------------------------------------------ views */
  const POSES = {
    top: { px: -2.0, py: 4.4, pz: 8.2, tx: -0.2, ty: 0.1, tz: -0.6 },
    motion: { px: 4.4, py: 4.6, pz: 6.6, tx: 1.2, ty: 0.2, tz: -1.2 },
    storm: { px: -0.8, py: 10.2, pz: 11.6, tx: 0, ty: 0, tz: -0.2 },
    replay: { px: 0.3, py: 13.2, pz: 9.8, tx: 0, ty: 0, tz: 0.3 },
    backtest: { px: 1.2, py: 12.2, pz: 10.6, tx: 0.2, ty: 0, tz: 0.2 },
    inspect: { px: 5.6, py: 4.6, pz: 5.4, tx: 2.2, ty: 0.2, tz: -1.4 },
    ask: { px: 3.6, py: 7.6, pz: 10.2, tx: 0.8, ty: 0, tz: -0.2 },
    method: { px: 0, py: 14, pz: 13, tx: 0, ty: 0, tz: 0.6 },
    record: { px: 0, py: 14, pz: 13, tx: 0, ty: 0, tz: 0.6 }
  };
  const LOOKS = {                                                  // what the terrain shows in each chapter
    top: { risk: 0.75, motion: 0, roads: 0, splitVis: 0, dim: 0, bld: 0 },
    motion: { risk: 0, motion: 1, roads: 0, splitVis: 1, dim: 0, bld: 0 },
    storm: { risk: 1, motion: 0, roads: 0.5, splitVis: 0, dim: 0, bld: 0.9 },
    replay: { risk: 1, motion: 0, roads: 0.35, splitVis: 0, dim: 0, bld: 0.5 },
    backtest: { risk: 1, motion: 0, roads: 0.45, splitVis: 0, dim: 0, bld: 0.5 },
    inspect: { risk: 0.7, motion: 0, roads: 0.2, splitVis: 0, dim: 0, bld: 0.6 },
    ask: { risk: 1, motion: 0, roads: 1, splitVis: 0, dim: 0, bld: 0.9 },
    method: { risk: 0.5, motion: 0, roads: 0, splitVis: 0, dim: 0.2, bld: 0 },
    record: { risk: 0.75, motion: 0, roads: 0, splitVis: 0, dim: 0, bld: 0 }
  };
  const ORDER = ['top', 'motion', 'storm', 'replay', 'backtest', 'record', 'inspect', 'ask', 'method'].filter(id => id !== 'motion' || REG.motion);
  const NAMES = { top: 'escape', motion: 'Ground motion', storm: 'Storm map', replay: '2023 replay', backtest: 'Backtest', inspect: 'Slopes', ask: 'Ask', method: 'Data and method', record: 'Track record' };
  const SUBS = { record: 'Our predictions next to what really happened', top: 'Storm safety for your address in ' + REG.places, storm: 'Set a rain forecast and see what it exposes', replay: 'Real gauge rain, December 2022 to April 2023', backtest: 'The score checked against the slides that were reported', inspect: 'One 30 m cell at a time', ask: 'Check a street by name', method: REG.motion ? 'What is real, what is simulated and what comes next' : 'What is real and what comes next' };
  const SPLIT = { storm: 1, backtest: 1, ask: 1, method: 1 };       // long views sit beside the map; short ones float over it
  if (window.GTEvac && GTEvac.register) GTEvac.register({ POSES, LOOKS, ORDER, NAMES, SUBS, SPLIT, S, setStorm, flyTo, replaySc, replayBefore: typeof replayBefore === 'function' ? replayBefore : null });   // the Getting out view adds itself
  if (window.GTRides && GTRides.register) GTRides.register({ POSES, LOOKS, ORDER, NAMES, SUBS, SPLIT });   // the Neighbor rides view adds itself
  if (window.GTStormResp && GTStormResp.register) GTStormResp.register({ POSES, LOOKS, ORDER, NAMES, SUBS, SPLIT });   // the Storm response view adds itself (San Francisco only)
  if (window.GTFloodL && GTFloodL.register) GTFloodL.register({ restore: () => { if (LSM && lsShown) Sc.setLandslide(lsShown, true); } });   // Lamorinda flood map puts the landslide layer back
  if (window.GTAddress && GTAddress.register) GTAddress.register({ S, flyTo, replaySc, peakDay, go: (id, q) => go(id, q), active: () => active, select: (lo, la) => select(lo, la), setStorm: (r, a) => setStorm(r, a, true) });   // the address check on the Overview
  const shiftO = { v: 0 };
  function updShift(now) {
    const on = $('.app').dataset.mode === 'overlay' && window.innerWidth > 900, px = on ? ($('.view').offsetWidth + 12) / 2 : 0;
    gsap.to(shiftO, { v: px, duration: reduce || now ? 0 : 0.7, ease: 'power3.inOut', overwrite: true, onUpdate: () => Sc.setShift(shiftO.v) });
  }
  let active = 'top', exploring = false, replayDay = D0;
  Object.assign(Sc.cam, POSES.top);

  function applyLook(id) {
    const k = LOOKS[id], d = reduce ? 0 : 0.9;
    Sc.setLayer('roads', true); Sc.setLayer('buildings', true); Sc.setLayer('labels', true);   // the base map is always whole inside a view; Free look can switch layers off
    gsap.to(U.uRisk, { value: k.risk, duration: d, overwrite: true }); gsap.to(U.uMotion, { value: k.motion, duration: d, overwrite: true });
    gsap.to(U.uRoads, { value: k.roads, duration: d, overwrite: true }); gsap.to(U.uSplitVis, { value: k.splitVis, duration: d, overwrite: true });
    gsap.to(U.uDim, { value: k.dim, duration: d, overwrite: true }); gsap.to(U.uBld, { value: k.bld, duration: d, overwrite: true });
    gsap.to(U.uSplit, { value: id === 'motion' && $('#split') ? $('#split').value / 100 : 0, duration: d, overwrite: true });
  }
  function enter(id) {
    if (exploring) return;
    active = id; applyLook(id);
    $$('.rail a.nav').forEach(a => a.dataset.go === id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
    ORDER.forEach(k => $('#' + k).classList.toggle('on', k === id)); $('#viewTitle').textContent = NAMES[id]; $('#viewSub').textContent = SUBS[id];
    $('.app').dataset.mode = 'split';   // old map system: every view sits beside the map (SPLIT is kept for views that register) Sc.resize(); updShift();
    if (id === 'top') pushScenario({ r72: 140, api: 230, era: 0, amt: 0 });
    else if (id === 'motion' || id === 'method') pushScenario({ r72: 0, api: 60, era: 0, amt: 0 });
    else if (id === 'replay') setReplay(replayDay, true);
    else if (id === 'backtest') pushScenario(replaySc(peakDay));
    else pushScenario({ r72: S.r72, api: S.api, era: 0, amt: 0 });
    showEvents(id === 'replay' || id === 'backtest', id === 'backtest');
    $('#inspector').classList.toggle('on', !!sel);
    samplePts.forEach(p => p.ring.show(id === 'inspect'));
    if (id !== 'ask' && id !== 'storm') { Sc.showStreet(null); streetOn = -1; if (id !== 'inspect' && id !== 'backtest') Sc.highlight(0, 0, false); }
    if (id !== 'inspect') Sc.showPath(null);
    if (id !== 'top' && id !== 'response' && window.GTRescue) GTRescue.stop();
    if (reduce) Object.assign(Sc.cam, POSES[id]);
    requestAnimationFrame(() => { refill(); if (id === 'replay') drawRain(); if (id === 'backtest') drawTimeline(); });
  }
  function go(id, quiet) {                                        // switch the view: panel, look, camera
    if (!POSES[id]) return;
    if (window.GTFloodL) GTFloodL.hide();                          // the Lamorinda flood map is shown from the address answer only
    if (exploring) { active = id; setExplore(false); } else enter(id);
    gsap.to(Sc.cam, { ...POSES[id], duration: reduce ? 0 : 1.3, ease: 'power3.inOut', overwrite: true });
    const vs = $('#viewScroll'); vs.scrollTop = 0;
    if (!quiet && getComputedStyle(document.body).overflowY !== 'hidden') { const r = $('.rail').getBoundingClientRect(); if (r.top < 0) window.scrollTo(0, window.scrollY + r.top - 8); }
    const a = $(`.rail a.nav[data-go="${id}"]`); if (a && a.scrollIntoView && a.parentNode.scrollWidth > a.parentNode.clientWidth) a.parentNode.scrollLeft = a.offsetLeft - 40;
  }
  document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('[data-go]'); if (!a) return; e.preventDefault(); go(a.dataset.go); });

  let setReplay = () => {};

  /* ------------------------------------------------ compare slider */
  if ($('#split')) { $('#split').addEventListener('input', e => { fill(e.target); U.uSplit.value = e.target.value / 100; }); fill($('#split')); }

  /* ------------------------------------------------ replay */
  const events = G.events.map(e => {
    const el = document.createElement('div'); el.className = 'pin-label ev'; el.textContent = e.where.length > 34 ? e.where.slice(0, 32) + '...' : e.where; el.hidden = true; $('#labels').appendChild(el);
    const day = Math.round((new Date(e.date + 'T12:00:00Z') - new Date(R23.start + 'T12:00:00Z')) / 864e5);
    return { ...e, day, mk: Sc.addMarker(e.lonlat[0], e.lonlat[1], el) };
  });
  let eventsOn = false, eventsAll = false;
  function showEvents(on, all) { eventsOn = on; eventsAll = !!all; events.forEach(e => e.mk.show(on && (eventsAll || e.day <= replayDay))); }
  setReplay = function (d, force) {
    d = Math.max(D0, Math.min(D1, Math.round(d))); if (d === replayDay && !force) return; replayDay = d;
    const sc = replaySc(d);
    if (active === 'replay' && !exploring) pushScenario(sc, true);
    $('#rpDate').textContent = dstr(addDays(R23.start, d)); $('#rpRain').textContent = fmt(sc.r72); $('#rpApi').textContent = fmt(sc.api);
    events.forEach(e => e.mk.show(eventsOn && (eventsAll || e.day <= d)));
    $('#rpSeason').textContent = fmt(seasonCum[d]); { const sc2 = $('#rpScrub'); sc2.value = d; fill(sc2); }
    const log = $('#rpLog'), seen = events.filter(e => e.day <= d).sort((a, b) => a.day - b.day).slice(-4);
    log.textContent = '';
    if (!seen.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No slides reported yet. The first comes with the New Year\'s Eve storm.'; log.appendChild(li); }
    for (const e of seen) { const li = document.createElement('li'), b = document.createElement('b'), s = document.createElement('span'); const ed = addDays(R23.start, e.day);
      b.textContent = `${MONTHS[ed.getUTCMonth()]} ${ed.getUTCDate()}`; s.textContent = `${e.where}, ${e.town}. ${e.what}`; li.append(b, s); log.appendChild(li); }
    drawRain();
  };
  let playing = null;
  const scrub = $('#rpScrub'); scrub.min = D0; scrub.max = D1; scrub.value = D0;
  const stopPlay = label => { if (playing) { playing.kill(); playing = null; } $('#playBtn').textContent = label || 'Play the winter'; };
  function playReplay(seconds) {
    const o = { d: replayDay >= D1 - 1 ? D0 : replayDay }; $('#playBtn').textContent = 'Pause';
    return new Promise(done => { playing = gsap.to(o, { d: D1, duration: (D1 - o.d) / (D1 - D0) * (seconds || 22), ease: 'none', onUpdate: () => setReplay(o.d),
      onComplete: () => { playing = null; $('#playBtn').textContent = 'Play again'; done(); }, onInterrupt: done }); });
  }
  $('#playBtn').addEventListener('click', () => { if (playing) stopPlay(); else playReplay(); });
  scrub.addEventListener('input', () => { if (playing) stopPlay(); setReplay(+scrub.value); });

  /* ------------------------------------------------ canvas charts */
  let cssEl = document.documentElement;                          // charts read tokens from their own scope: the stage stays dark in the light theme
  const css = n => getComputedStyle(cssEl).getPropertyValue(n).trim();
  function prep(cv) { cssEl = cv; const r = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.max(10, r.width * dpr); cv.height = Math.max(10, r.height * dpr); const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [x, r.width, r.height]; }
  function drawRain() {
    const cv = $('#rainChart'); if (!cv.offsetParent) return; const [x, w, h] = prep(cv);
    const a = 60, b = D1 + 6, n = b - a, L = 34, Rr = 40, T = 6, B = 20, pw = w - L - Rr, ph = h - T - B;
    const X = d => L + (d - a) / n * pw, maxR = 80, maxA = 300;
    x.font = '11px "JetBrains Mono", monospace'; x.fillStyle = css('--ink-3'); x.strokeStyle = css('--line'); x.lineWidth = 1;
    for (const v of [0, 40, 80]) { const y = T + ph - v / maxR * ph; x.beginPath(); x.moveTo(L, y + .5); x.lineTo(L + pw, y + .5); x.stroke(); x.textAlign = 'right'; x.fillText(v, L - 6, y + 4); }
    x.textAlign = 'left'; x.fillStyle = css('--accent'); for (const v of [100, 200, 300]) x.fillText(v, L + pw + 6, T + ph - v / maxA * ph + 4);
    x.fillStyle = css('--ink-3'); x.textAlign = 'center';
    for (const [d, lb] of [[61, 'Dec'], [92, 'Jan'], [123, 'Feb'], [151, 'Mar']]) x.fillText(lb, X(d) + 12, h - 5);
    const bw = Math.max(1.5, pw / n - 1.2);
    for (let d = a; d < b; d++) { const v = R23.mm[d] || 0, bh = Math.min(v, maxR) / maxR * ph; x.fillStyle = css('--rain'); x.globalAlpha = d <= replayDay ? 1 : 0.3; x.fillRect(X(d), T + ph - bh, bw, bh); x.globalAlpha = 1; }
    x.beginPath(); for (let d = a; d < b; d++) { const y = T + ph - Math.min(R23.api[d], maxA) / maxA * ph; d === a ? x.moveTo(X(d), y) : x.lineTo(X(d), y); } x.strokeStyle = css('--accent'); x.lineWidth = 1.6; x.stroke();
    for (const e of events) { x.fillStyle = e.day <= replayDay ? css('--t-high') : css('--ink-3'); x.beginPath(); x.arc(X(e.day) + bw / 2, T + 4, 3, 0, 7); x.fill(); }
    const px = X(replayDay) + bw / 2; x.strokeStyle = css('--ink'); x.lineWidth = 1; x.beginPath(); x.moveTo(px, T); x.lineTo(px, T + ph); x.stroke();
  }
  function drawSeries(pt) {
    const cv = $('#tsChart'); if (!REG.motion) return null; const [x, w, h] = prep(cv); if (!pt) { x.fillStyle = css('--ink-3'); x.font = '12.5px "Segoe UI", system-ui, sans-serif'; x.fillText(REG.motion ? 'No motion record at this cell in the sample.' : 'Real radar motion data comes next.', 0, 20); return; }
    const an = Mo.analyseSeries(pt), d = pt.disp_mm, t = an.t, L = 34, R = 8, T = 8, B = 20, pw = w - L - R, ph = h - T - B;
    const lo = Math.min(...d, 0), hi = Math.max(...d, 0), pad = (hi - lo) * 0.08 + 2, X = v => L + v / t[t.length - 1] * pw, Y = v => T + (hi + pad - v) / (hi - lo + 2 * pad) * ph;
    x.font = '11px "JetBrains Mono", monospace'; x.fillStyle = css('--ink-3'); x.strokeStyle = css('--line'); x.lineWidth = 1;
    const step = (hi - lo) > 120 ? 50 : (hi - lo) > 40 ? 20 : 10;
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) { x.beginPath(); x.moveTo(L, Y(v) + .5); x.lineTo(L + pw, Y(v) + .5); x.stroke(); x.textAlign = 'right'; x.fillText(v, L - 6, Y(v) + 4); }
    x.textAlign = 'center'; const y0 = 2016.5; for (let yr = 2018; yr <= 2026; yr += 2) x.fillText(yr, X(yr - y0), h - 5);
    const w23 = [2022.99 - y0, 2023.25 - y0]; x.fillStyle = 'rgba(143,180,255,.14)'; x.fillRect(X(w23[0]), T, X(w23[1]) - X(w23[0]), ph);
    x.fillStyle = css('--ink-2'); for (let k = 0; k < d.length; k++) x.fillRect(X(t[k]) - 1, Y(d[k]) - 1, 2, 2);
    const th = an.long.theta; x.beginPath(); for (let k = 0; k < t.length; k++) { const v = th[0] + th[1] * t[k] + th[2] * Math.sin(2 * Math.PI * t[k]) + th[3] * Math.cos(2 * Math.PI * t[k]); k ? x.lineTo(X(t[k]), Y(v)) : x.moveTo(X(t[k]), Y(v)); }
    x.strokeStyle = css('--accent'); x.lineWidth = 1.6; x.stroke();
    return an;
  }

  /* ------------------------------------------------ inspector */
  let sel = null;                                                  // {i, lon, lat, pt}
  const samplePts = (REG.motion ? G.insar.points : []).map(p => {
    const el = document.createElement('div'); el.className = 'pin-label'; el.style.cssText = 'padding:0;width:12px;height:12px;border-radius:50%;margin:-6px 0 0 -6px;background:transparent;border:1.5px solid ' + (p.kind === 'creep' ? '#ffcf7a' : '#8fb4ff'); el.hidden = true; $('#labels').appendChild(el);
    return { p, ring: Sc.addLabel(p.lonlat[0], p.lonlat[1], el, 0.06) };
  });
  function nearestSample(lon, lat) {
    let best = null, bd = 1e9; for (const s of samplePts) { const dx = (s.p.lonlat[0] - lon) * 87800, dy = (s.p.lonlat[1] - lat) * 110950, d = Math.hypot(dx, dy); if (d < bd) { bd = d; best = s.p; } }
    return { pt: best, dist: bd };
  }
  function currentSc() { return exploring ? stormSc() : active === 'replay' ? replaySc(replayDay) : active === 'backtest' ? replaySc(peakDay) : stormSc(); }
  function select(lon, lat) {
    const i = Mo.cellOf(lon, lat); if (i < 0) return; Sc.showPath(null); $('#runOut').hidden = true;
    const ns = nearestSample(lon, lat); sel = { i, lon, lat, pt: ns.dist < 130 ? ns.pt : null, near: ns };
    Sc.highlight(lon, lat, true); U.uHiR.value = 0.011; renderInspector();
    $('#inspector').classList.add('on');
  }
  function renderInspector() {
    if (!sel) return; const sc = currentSc(), i = sel.i, L = Mo.L, t = Mo.terms(i, sc), v = Mo.index(i, sc), tr = Mo.tier(v);
    const town = TOWNS.slice().sort((a, b) => Math.hypot((sel.lon - a[1]) * .79, sel.lat - a[2]) - Math.hypot((sel.lon - b[1]) * .79, sel.lat - b[2]))[0][0];
    $('#inTitle').textContent = `Slope near ${town}`; $('#inSub').textContent = `${sel.lat.toFixed(4)} N, ${Math.abs(sel.lon).toFixed(4)} W. ${fmt(L.elev[i])} m elevation.`;
    $('#inScore').textContent = fmt(v); const te = $('#inTier'); te.textContent = tr; te.className = 'tier ' + tr;
    const an = drawSeries(sel.pt);
    const kv = [['Slope', fmt(L.slope[i], 1) + '°, faces ' + ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(L.aspect[i] / 45) % 8]], ['Buildings within 90 m', fmt(Mo.buildingsNear([i], 3))], ['_', ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(L.aspect[i] / 45) % 8]], ['To a stream', fmt(L.dstream[i]) + ' m'],
      [REG.motion ? 'Long-term speed' : '_', fmt(L.vpre[i], 1) + ' mm/yr'], [REG.motion ? 'Recent speed' : '_', fmt(an ? -an.recent.v : t.vr, 1) + ' mm/yr'], ['Greenness 2023 to 2026', fmt(L.ndvi23[i], 2) + ' to ' + fmt(L.ndvi26[i], 2)]];
    $('#inKv').innerHTML = kv.filter(k => k[0] !== '_').map(k => `<div><dt>${k[0]}</dt><dd>${k[1]}</dd></div>`).join('');
    const parts = t.parts.filter(p => p[1] > 0.04).sort((a, b) => b[1] - a[1]).slice(0, 4), mx = Math.max(0.5, ...parts.map(p => p[1]));
    $('#inWhy').innerHTML = parts.map(p => `<li><span>${p[0]}</span><i style="width:${(p[1] / mx * 90).toFixed(0)}px"></i><b>+${p[1].toFixed(1)}</b></li>`).join('') || '<li><span>Nothing is pushing this cell up under the current storm.</span></li>';
    const tE = Mo.tipCell(i, sc, 50), tH = Mo.tipCell(i, sc, 75);
    $('#inTip').innerHTML = `Rain in 72 hours that tips this cell, with soil wetness held at ${fmt(sc.api)} mm: <b>${tipText(tE, tH)}</b>.`;
    drawTip(i, sc, tE, tH);
    const hk = Mo.opts.motion + '|' + Mo.opts.bias; if (!sel.hc || sel.hcKey !== hk) { sel.hc = hindcast(s2 => Mo.index(i, s2)); sel.hcKey = hk; }
    $('#histCap').innerHTML = sel.hc.el + sel.hc.hi ? `Against every day of real rain since October 2015, this cell would have scored Elevated on <b>${sel.hc.el}</b> ${sel.hc.el === 1 ? 'day' : 'days'} and High on <b>${sel.hc.hi}</b>. Worst: ${sel.hc.worstDate}, score ${fmt(sel.hc.worst)}.` : `Against every day of real rain since October 2015, this cell never reaches Elevated. Its worst day is ${sel.hc.worstDate}, score ${fmt(sel.hc.worst)}.`;
    drawHist(sel.hc);
    if (REG.motion) $('#tsCap').textContent = !samplePts.length ? 'No ground motion record for this area yet. Nothing is simulated in its place.' : sel.pt ? `Simulated motion record, point ${sel.pt.id}. Long-term ${fmt(-an.long.v, 1)} mm/yr, last 5 months ${fmt(-an.recent.v, 1)} mm/yr.` : `Nearest point with a motion record is ${fmt(sel.near.dist)} m away.`;
  }
  function drawTip(i, sc, tE, tH) {
    const cv = $('#tipChart'); if (!cv.offsetParent) return; const [x, w, h] = prep(cv), L = 26, R = 14, T = 4, B = 16, pw = w - L - R, ph = h - T - B, X = r => L + r / 300 * pw, Y = v => T + (100 - v) / 100 * ph;
    x.font = '10.5px "JetBrains Mono", monospace'; x.fillStyle = css('--ink-3'); x.strokeStyle = css('--line'); x.lineWidth = 1;
    for (const v of [50, 75]) { x.beginPath(); x.setLineDash([3, 3]); x.moveTo(L, Y(v) + .5); x.lineTo(L + pw, Y(v) + .5); x.stroke(); x.textAlign = 'right'; x.fillText(v, L - 5, Y(v) + 3.5); }
    x.setLineDash([]); x.textAlign = 'center'; for (const r of [0, 100, 200, 300]) x.fillText(r, X(r), h - 3);
    x.beginPath(); for (let r = 0; r <= 300; r += 6) { const v = Mo.index(i, { ...sc, r72: r }); r ? x.lineTo(X(r), Y(v)) : x.moveTo(X(r), Y(v)); } x.strokeStyle = css('--accent'); x.lineWidth = 1.6; x.stroke();
    const now = Math.min(300, sc.r72); x.fillStyle = css('--ink'); x.beginPath(); x.arc(X(now), Y(Mo.index(i, sc)), 3.2, 0, 7); x.fill();
    for (const [t, c] of [[tE, '--t-elevated'], [tH, '--t-high']]) if (t != null && t > 0 && t <= 300) { x.fillStyle = css(c); x.fillRect(X(t) - 1, T, 2, ph); }
  }
  function drawHist(hc) {
    const cv = $('#histChart'); if (!cv.offsetParent) return; const [x, w, h] = prep(cv), ys = Object.keys(hc.years).map(Number), L = 26, R = 6, T = 4, B = 15, pw = w - L - R, ph = h - T - B;
    const mx = Math.max(4, ...ys.map(y => hc.years[y][0] + hc.years[y][1])), bw = pw / ys.length;
    x.font = '10.5px "JetBrains Mono", monospace'; x.fillStyle = css('--ink-3'); x.strokeStyle = css('--line'); x.lineWidth = 1;
    x.beginPath(); x.moveTo(L, T + ph + .5); x.lineTo(L + pw, T + ph + .5); x.stroke(); x.textAlign = 'right'; x.fillText(mx, L - 5, T + 8); x.fillText(0, L - 5, T + ph + 3);
    ys.forEach((y, n) => { const [e, hi] = hc.years[y], X0 = L + n * bw + 2, he = e / mx * ph, hh = hi / mx * ph;
      x.fillStyle = css('--t-elevated'); x.fillRect(X0, T + ph - he - hh, bw - 4, he); x.fillStyle = css('--t-high'); x.fillRect(X0, T + ph - hh, bw - 4, hh);
      x.fillStyle = css('--ink-3'); x.textAlign = 'center'; x.fillText("'" + String(y).slice(2), X0 + (bw - 4) / 2, h - 3); });
  }
  $('#runBtn').addEventListener('click', () => {
    if (!sel) return; const ro = Mo.runout(sel.i), out = $('#runOut');
    Sc.showPath(ro.path.map(Mo.lonlatOf));
    const end = { reach: 'where debris would be expected to stop', flat: 'where the ground levels out', basin: 'in a closed low spot', edge: 'at the edge of the map', far: 'after 3 km, where the trace is cut off' }[ro.why];
    const st = ro.streets.slice(0, 4).map(s => `${s.name} after ${fmt(s.dist)} m`);
    out.textContent = `Downhill path: ${fmt(ro.length)} m long with a ${fmt(ro.drop)} m drop, ending ${end}. ` + (st.length ? `In the way: ${st.join(', ')}${ro.streets.length > 4 ? ` and ${ro.streets.length - 4} more` : ''}. ` : 'No mapped street lies on the path. ') + (ro.creek >= 0 ? `It joins a creek line after ${fmt(ro.creek)} m. ` : '') + `${fmt(Mo.buildingsNear(ro.path, 1))} buildings stand within about 30 m of it. ` + 'A screening estimate from the terrain, not a flow simulation.';
    out.hidden = false; lastRunout = ro;
  });
  let lastRunout = null;
  $('#inClose').addEventListener('click', () => { sel = null; $('#inspector').classList.remove('on'); Sc.highlight(0, 0, false); Sc.showPath(null); });
  /* map moves in free look: drag to move, right-drag or Shift-drag to turn and tilt, scroll or pinch to zoom toward the pointer, double-click to step in */
  const glEl = $('#gl'), ptrs = new Map(); let down = null, pinch = null;
  glEl.addEventListener('contextmenu', e => e.preventDefault());
  glEl.addEventListener('pointerdown', e => {
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); pinch = null;
    down = { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, turn: e.button === 2 || e.button === 1 || e.shiftKey || e.ctrlKey || e.metaKey, drag: ptrs.size > 1 };
    if (exploring) try { glEl.setPointerCapture(e.pointerId); } catch (err) {}
  });
  glEl.addEventListener('pointermove', e => {
    const p = ptrs.get(e.pointerId); if (!p || !down) return;
    if (ptrs.size >= 2 && exploring) {
      p.x = e.clientX; p.y = e.clientY; const [a, b] = [...ptrs.values()], d = Math.max(24, Math.hypot(b.x - a.x, b.y - a.y)), ang = Math.atan2(b.y - a.y, b.x - a.x), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (pinch) { let da = ang - pinch.ang; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI; Sc.nav.zoom(pinch.d / d, cx, cy); Sc.nav.twist(da); Sc.nav.pan(cx - pinch.cx, cy - pinch.cy); }
      pinch = { d, ang, cx, cy }; down.drag = true; return;
    }
    if (!down.drag && Math.hypot(e.clientX - down.sx, e.clientY - down.sy) < 6) return;
    if (!exploring) { if (e.pointerType !== 'mouse') return; setExplore(true); down.x = e.clientX; down.y = e.clientY; try { glEl.setPointerCapture(e.pointerId); } catch (err) {} }
    const dx = e.clientX - down.x, dy = e.clientY - down.y; down.x = p.x = e.clientX; down.y = p.y = e.clientY; down.drag = true;
    if (down.turn) Sc.nav.rotate(dx, dy); else Sc.nav.pan(dx, dy);
  });
  const ptrEnd = e => {
    const moved = down && (down.drag || Math.hypot(e.clientX - down.sx, e.clientY - down.sy) > 6); ptrs.delete(e.pointerId); pinch = null; if (!ptrs.size) down = null;
    if (moved || e.type === 'pointercancel' || e.button !== 0) return;
    const ll = Sc.pick(e.clientX, e.clientY); if (ll && active === 'evac' && window.GTEvac) return GTEvac.pick(ll[0], ll[1]);
    if (ll) select(ll[0], ll[1]);
  };
  glEl.addEventListener('pointerup', ptrEnd); glEl.addEventListener('pointercancel', ptrEnd);
  glEl.addEventListener('dblclick', e => { if (exploring) Sc.nav.zoom(0.5, e.clientX, e.clientY); });
  glEl.addEventListener('wheel', e => { if (!exploring) { if (getComputedStyle(document.body).overflowY !== 'hidden') return; setExplore(true); } e.preventDefault();
    const dy = e.deltaY * (e.deltaMode === 1 ? 33 : 1) * (e.ctrlKey ? 5 : 1); Sc.nav.zoom(Math.exp(Math.max(-0.5, Math.min(0.5, dy * 0.0017))), e.clientX, e.clientY); }, { passive: false });
  $('#jumpFast').addEventListener('click', () => {
    if (!samplePts.length) { const rk = Mo.rankStreets(currentSc(), 1).top[0]; if (rk) { const [lo, la] = Mo.lonlatOf(rk.worst); select(lo, la); flyTo(lo, la, 4.4); } return; }   // no motion points in this area: open the most exposed street cell
    const p = samplePts.map(s => s.p).filter(p => p.kind === 'creep').sort((a, b) => a.disp_mm[a.disp_mm.length - 1] - b.disp_mm[b.disp_mm.length - 1])[0];
    select(p.lonlat[0], p.lonlat[1]); flyTo(p.lonlat[0], p.lonlat[1], 4.4);
  });

  /* ------------------------------------------------ real data only: drop the simulated motion from the score everywhere */
  function setReal(on) {
    Mo.opts.motion = on ? 0 : 1; gsap.to(U.uUseMotion, { value: on ? 0 : 1, duration: reduce ? 0 : 0.6 });
    $('#realOnly').checked = on; $('#exReal').setAttribute('aria-pressed', on);
    const f = $('#simflag'); f.textContent = on ? 'Score from real terrain and gauge rain' : 'Score includes simulated ground motion'; f.classList.toggle('real', on);
    stormStats(); if (sel) renderInspector(); renderBacktest();
  }
  const SENS = { '-6.5': 'Fewer alerts', '-5.7': 'Balanced', '-4.9': 'More alerts' };
  function setBias(b) {
    Mo.opts.bias = b; gsap.to(U.uBias, { value: b, duration: reduce ? 0 : 0.6 }); gsap.to(U.uLSOff, { value: b + 6.5, duration: reduce ? 0 : 0.6 });
    $$('[data-bias]').forEach(x => x.setAttribute('aria-pressed', +x.dataset.bias === b));
    stormStats(); if (sel) renderInspector(); renderBacktest();
  }
  $$('[data-bias]').forEach(x => x.addEventListener('click', () => setBias(+x.dataset.bias)));
  $('#realOnly').addEventListener('change', e => setReal(e.target.checked));
  $('#exReal').addEventListener('click', () => setReal(Mo.opts.motion === 1));

  /* ------------------------------------------------ backtest: the ten reported slides against the score in the three days before each report */
  const nullPts = (() => { let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296, out = []; while (out.length < 240) { const st = G.streets[Math.floor(rnd() * G.streets.length)], q = st.p[Math.floor(rnd() * st.p.length)]; if (Mo.cellOf(q[0], q[1]) >= 0) out.push(q); } return out; })();
  const RAD = 10;                                                   // 10 cells, about 300 m: reports name a street, not a spot
  function backtest() {
    const fields = new Map(), field = d => { if (!fields.has(d)) fields.set(d, Mo.sortedField(replaySc(d))); return fields.get(d); };
    const nulls = new Map(), nullOf = d => { if (!nulls.has(d)) { const sc = replaySc(d); nulls.set(d, Float32Array.from(nullPts, q => Mo.maxNear(q[0], q[1], sc, RAD)).sort()); } return nulls.get(d); };
    const rows = events.map(e => {
      let peak = 0, pd = e.day - 1;
      for (let d = e.day - 3; d < e.day; d++) { const v = Mo.maxNear(e.lonlat[0], e.lonlat[1], replaySc(d), RAD); if (v > peak) { peak = v; pd = d; } }
      const nu = nullOf(pd);
      return { e, peak, pd, area: Mo.shareAbove(field(pd), 50), top: Mo.shareAbove(field(pd), peak), beats: 1 - Mo.shareAbove(nu, peak), nullTop: Mo.shareAbove(field(pd), nu[nu.length >> 1]) };
    });
    const med = xs => { const v = xs.slice().sort((a, b) => a - b); return (v[(v.length - 1) >> 1] + v[v.length >> 1]) / 2; };
    return { rows, area: rows.reduce((a, r) => a + r.area, 0) / rows.length, bld: (b => b.el + b.hi)(Mo.buildingsAt(replaySc(peakDay))), hits: rows.filter(r => r.peak >= 50).length, top: med(rows.map(r => r.top)), nullTop: med(rows.map(r => r.nullTop)), auc: rows.reduce((a, r) => a + r.beats, 0) / rows.length };
  }
  /* alert burden: days in the 11 year gauge record on which 100 or more buildings would sit on Elevated or High ground. The score only sees rain through T, so buildings are tabulated per T step. */
  const ALERT_BLD = 100;
  function alertDays() {
    if (LSM) {                                                     // the model sees rain and soil wetness separately, so tabulate buildings per storm region
      const per = new Map(), cnt = d => { const sc = hsc(d), lay = Mo.lsLayer(sc); if (!per.has(lay)) { const b = Mo.buildingsAt(sc); per.set(lay, b.el + b.hi); } return per.get(lay); };
      const years = {}; for (let y = hWY[0]; y <= hWY[HN - 1]; y++) years[y] = 0;
      let total = 0; for (let d = 0; d < HN - 3; d++) if (cnt(d) >= ALERT_BLD) { total++; years[hWY[d]]++; }
      const ys = Object.keys(years); return { total, years, n: ys.length, perYear: total / ys.length, wy23: years[2023] || 0, quiet: ys.filter(y => !years[y]).length };
    }
    const tab = new Int32Array(143).fill(-1), at = t => { const k = Math.min(142, Math.round(t * 100)); if (tab[k] < 0) { const T = k / 100, sc = T <= 0.825 ? { r72: T * 200 / 0.55, api: 0, era: 0, amt: 0 } : { r72: 300, api: (T - 0.825) * 200 / 0.45, era: 0, amt: 0 }, b = Mo.buildingsAt(sc); tab[k] = b.el + b.hi; } return tab[k]; };
    const years = {}; for (let y = hWY[0]; y <= hWY[HN - 1]; y++) years[y] = 0;
    let total = 0; for (let d = 0; d < HN - 3; d++) if (at(hT[d]) >= ALERT_BLD) { total++; years[hWY[d]]++; }
    const ys = Object.keys(years); return { total, years, n: ys.length, perYear: total / ys.length, wy23: years[2023] || 0, quiet: ys.filter(y => !years[y]).length };
  }
  /* slides from other winters, found in local news after the model was fixed: a spot check outside the test winter */
  const OTHER = (() => {
    if (REG.id !== 'lamorinda') return [];                         // the spot check slides are Lamorinda reports
    const pts = n => { const s = G.streets.find(x => x.n === n); return s ? s.p : null; }, mid = p => p && p[p.length >> 1];
    const aug = pts('Augusta Drive'), can = pts('Canyon Road');
    let bridge = null; if (aug && can) { let bd = 1e9; for (const q of can) for (const a of aug) { const d = Math.hypot((q[0] - a[0]) * 0.79, q[1] - a[1]); if (d < bd) { bd = d; bridge = q; } } }
    return [['2016-03-13', 'Augusta Drive, Moraga', mid(aug)], ['2017-02-09', 'Van Tassel Lane, Orinda', mid(pts('Van Tassel Lane'))], ['2017-04-18', 'Canyon bridge, Moraga', bridge], ['2019-02-13', 'Canyon bridge again', bridge]]
      .filter(e => e[2] && Mo.cellOf(e[2][0], e[2][1]) >= 0).map(([date, where, q]) => ({ date, where, q, day: Math.round((new Date(date + 'T12:00:00Z') - new Date(RL.start + 'T12:00:00Z')) / 864e5) }));
  })();
  function drawTimeline() {
    const cv = $('#tlChart'); if (!cv || !cv.offsetParent) return; const [x, w, h] = prep(cv), L = 8, R = 8, T = 22, B = 16, pw = w - L - R, ph = h - T - B, n = HN - 3;
    const off = Math.round((new Date(R23.start + 'T12:00:00Z') - new Date(RL.start + 'T12:00:00Z')) / 864e5);
    const all = events.map(e => ({ day: e.day + off, test: true })).concat(OTHER.map(e => ({ day: e.day, test: false })));
    const sorted = Float32Array.from(hT.subarray(0, n)).sort(), p95 = sorted[Math.floor(n * 0.95)], tmax = sorted[n - 1] || 1;
    const X = d => L + d / (n - 1) * pw, Y = t => T + ph - t / tmax * ph;
    x.clearRect(0, 0, w, h); x.font = '10.5px "JetBrains Mono", monospace'; x.textAlign = 'center';
    for (let d = 0; d < n; d++) { const t = addDays(RL.start, d); if (t.getUTCMonth() === 0 && t.getUTCDate() === 1) { x.fillStyle = css('--ink-3'); x.fillText("'" + String(t.getUTCFullYear()).slice(2), X(d), h - 4); x.fillStyle = css('--line'); x.fillRect(Math.round(X(d)), T, 1, ph); } }
    x.fillStyle = css('--ink-3'); x.globalAlpha = 0.55; for (let px = 0; px < pw; px++) { const d0 = Math.floor(px / pw * n), d1 = Math.max(d0 + 1, Math.floor((px + 1) / pw * n)); let m = 0; for (let d = d0; d < d1 && d < n; d++) if (hT[d] > m) m = hT[d]; if (m >= p95) { x.globalAlpha = 1; x.fillStyle = css('--accent'); } else { x.globalAlpha = 0.55; x.fillStyle = css('--ink-3'); } x.fillRect(L + px, Y(m), 1, T + ph - Y(m)); }
    x.globalAlpha = 1; x.strokeStyle = css('--accent'); x.setLineDash([3, 3]); x.beginPath(); x.moveTo(L, Y(p95) + .5); x.lineTo(L + pw, Y(p95) + .5); x.stroke(); x.setLineDash([]);
    let hit = 0; for (const e of all) { let m = 0; for (let d = e.day - 3; d < e.day; d++) if (d >= 0 && d < n && hT[d] > m) m = hT[d]; if (m >= p95) hit++; x.beginPath(); x.arc(X(e.day), 11, 3.5, 0, 6.3); if (e.test) { x.fillStyle = css('--t-elevated'); x.fill(); } else { x.strokeStyle = css('--ink'); x.lineWidth = 1.5; x.stroke(); x.lineWidth = 1; } }
    let base = 0; for (let d = 3; d < n; d++) if (hT[d - 1] >= p95 || hT[d - 2] >= p95 || hT[d - 3] >= p95) base++; base = base / (n - 3) * 100;
    $('#tlCap').textContent = `Each bar is one day of the rain trigger, from real gauge rain. Bright bars are the wettest 5% of days, above the dashed line. Dots mark every dated slide in this project: filled for winter 2023${OTHER.length ? ', open for the four from other winters' : ''}. ${hit} of ${all.length} were reported within three days after a top 5% day. Only ${fmt(base)}% of all days are that close to one. The trigger is the same at every alert setting.`;
  }
  window.addEventListener('resize', () => { clearTimeout(drawTimeline.t); drawTimeline.t = setTimeout(drawTimeline, 200); });
  function renderOther() {
    if (!timing) { const n = HN - 3, off = Math.round((new Date(R23.start + 'T12:00:00Z') - new Date(RL.start + 'T12:00:00Z')) / 864e5), p95 = Float32Array.from(hT.subarray(0, n)).sort()[Math.floor(n * 0.95)], days = events.map(e => e.day + off).concat(OTHER.map(e => e.day));
      timing = { p95, n: days.length, hit: days.filter(dd => { for (let d = dd - 3; d < dd; d++) if (d >= 0 && d < n && hT[d] >= p95) return true; return false; }).length }; stormStats(); }
    drawTimeline();
    const ol = $('#btOther'); if (!ol) return; ol.textContent = ''; let hits = 0;
    for (const e of OTHER) {
      let peak = 0, pd = e.day - 1; for (let d = e.day - 3; d < e.day; d++) { if (d < 0 || d >= HN - 3) continue; const v = Mo.maxNear(e.q[0], e.q[1], hsc(d), RAD); if (v > peak) { peak = v; pd = d; } }
      if (peak >= 50) hits++;
      const li = document.createElement('li'), b = document.createElement('button'), ed = addDays(RL.start, e.day), sc = hsc(pd);
      b.innerHTML = `<span class="d">${MONTHS[ed.getUTCMonth()]} ${String(ed.getUTCFullYear()).slice(2)}</span><span class="w"></span><span class="tier ${Mo.tier(peak)}">${Math.floor(peak)} ${Mo.tier(peak)}</span><span class="l">${fmt(sc.r72)} mm rain</span>`;
      b.querySelector('.w').textContent = e.where;
      b.setAttribute('aria-label', `${e.where}, reported ${dstr(ed)}. Highest score within 300 metres in the three days before: ${fmt(peak)}, ${Mo.tier(peak)}, with ${fmt(sc.r72)} millimetres of rain in 72 hours. Show on map.`);
      b.addEventListener('click', () => { Sc.highlight(e.q[0], e.q[1], true); U.uHiR.value = 0.021; pushScenario(sc); flyTo(e.q[0], e.q[1], 5.4); });
      li.appendChild(b); ol.appendChild(li);
    }
    $('#btOtherNote').textContent = `${hits} of ${OTHER.length} sat near Elevated or High ground at this setting. These were found in local news after the formula was fixed, so nothing was tuned to them, but four slides picked by a search are a spot check and not a test set. ${(e => { if (!e) return ''; const se = seasonStats(e.day); return `The April 2017 bridge slide moved with almost no rain that week, late in a season that had reached ${fmt(se.pct)}% of average rain. A three day rain trigger is not built to see that.`; })(OTHER.find(e => e.date === '2017-04-18'))} ${OTHER.filter(e => stormPicks.some(d => Math.abs(d - e.day) <= 5)).length} of the ${OTHER.length} were reported within five days of one of the eight wettest storms in the gauge record, so the rain trigger gets the timing even where the map score is too low. Sources are in the dataset notes.`;
  }
  let btCache = {};
  function renderBacktest() {
    const mo = Mo.opts.motion, bias = Mo.opts.bias, K = (m, b) => m + '|' + b;
    const get = (m, b) => { const k = K(m, b); if (!btCache[k]) { Mo.opts.motion = m; Mo.opts.bias = b; btCache[k] = backtest(); btCache[k].alerts = alertDays(); Mo.opts.motion = mo; Mo.opts.bias = bias; } return btCache[k]; };
    const key = mo;
    const bt = get(mo, bias), o = LSM ? bt : get(mo ? 0 : 1, bias), pc = v => fmt(v * 100, v < 0.1 ? 1 : 0) + '%';
    $('#btHit').textContent = bt.hits; $('#btTop').textContent = pc(bt.top); $('#btAuc').textContent = fmt(bt.auc * 10, 1);
    $('#btNull').textContent = pc(bt.nullTop);
    const roc = $('#btRoc'); roc.textContent = '';
    for (const b of Object.keys(SENS).map(Number).sort((x, y) => x - y)) { const r = get(mo, b), tr = document.createElement('tr'); if (b === bias) tr.className = 'on';
      tr.innerHTML = `<td>${SENS[b]}</td><td>${r.hits} of ${events.length}</td><td>${pc(r.area)}</td><td>${fmt(r.bld)}</td><td>${fmt(r.alerts.perYear, 1)}</td><td></td>`;
      if (b !== bias) { const u = document.createElement('button'); u.textContent = 'Use'; u.setAttribute('aria-label', 'Use the ' + SENS[b] + ' setting'); u.addEventListener('click', () => setBias(b)); tr.lastChild.appendChild(u); } else tr.lastChild.textContent = 'In use';
      roc.appendChild(tr); }
    const ol = $('#btList'); ol.textContent = '';
    for (const r of bt.rows.slice().sort((a, b) => a.e.day - b.e.day)) {
      const li = document.createElement('li'), b = document.createElement('button'), ed = addDays(R23.start, r.e.day);
      b.innerHTML = `<span class="d">${MONTHS[ed.getUTCMonth()]} ${ed.getUTCDate()}</span><span class="w"></span><span class="tier ${Mo.tier(r.peak)}">${Math.floor(r.peak)} ${Mo.tier(r.peak)}</span><span class="l">top ${pc(r.top)} of map</span>`;
      b.querySelector('.w').textContent = r.e.where;
      b.setAttribute('aria-label', `${r.e.where}, reported ${dstr(ed)}. Highest score within 300 metres in the three days before: ${fmt(r.peak)}, ${Mo.tier(r.peak)}, which ranks in the top ${pc(r.top)} of the map. Show on map.`);
      b.addEventListener('click', () => { Sc.highlight(r.e.lonlat[0], r.e.lonlat[1], true); U.uHiR.value = 0.021; pushScenario(replaySc(r.pd)); flyTo(r.e.lonlat[0], r.e.lonlat[1], 5.4); });
      li.appendChild(b); ol.appendChild(li);
    }
    renderOther();
    const SN = LSM ? 'The landslide model' : 'The placeholder';
    const verdict = bt.auc >= 0.6 && bt.hits < 5 ? SN + ' ranks these slopes better than chance but under-warns at this setting. Raising the sensitivity catches more slides and flags more of the map, which is the trade every warning system has to pick.' : bt.auc >= 0.6 ? SN + ' ranks these slopes better than chance.' : SN + ' does little better than chance here.';
    $('#btNote').innerHTML = `<b>${verdict}</b> ${LSM ? 'The landslide model uses real terrain and real gauge rain only. None of these slides were used to train it.' : !REG.motion ? 'This run uses real terrain and real gauge rain only.' : `${key ? 'This run includes the simulated ground motion. With it removed' : 'This run uses real terrain and real gauge rain only. With the simulated motion added'}: ${o.hits} of 10 flagged, median rank top ${pc(o.top)}, ${fmt(o.auc * 10, 1)} in 10 against random street spots.`} Across ${bt.alerts.n} winters of gauge rain this setting would have called an alert day, meaning ${ALERT_BLD} or more buildings on Elevated or High ground, ${fmt(bt.alerts.total)} times: ${fmt(bt.alerts.wy23)} in winter 2023 and none at all in ${bt.alerts.quiet} of the winters. Slides from other winters were not collected, so alert days outside 2023 cannot be checked either way. The rain is the gauge record, so it stands in for a perfect forecast. Report dates can lag the slide, slides get reported where there are roads, and ${events.length === 10 ? 'ten' : events.length} events cannot prove a model.`;
  }

  /* ------------------------------------------------ storm briefing + exports */
  async function saveFile(filename, text, mime) {

    try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: mime })); a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); return true; } catch (e) { return false; }
  }
  $('#csvBtn').addEventListener('click', () => {
    if (!lastRank) return; const sc = stormSc(), q = v => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = ['rank,street,town,score,tier,buildings_along_street,buildings_on_elevated_or_high_ground,rain_72h_mm,soil_wetness_mm,ground_motion,alert_sensitivity'];
    lastRank.all.forEach((s, n) => lines.push([n + 1, q(s.name), q(s.town), s.score.toFixed(1), Mo.tier(s.score), ...(b => [b.total, b.flagged])(Mo.streetBuildings(s.k, sc)), sc.r72, sc.api, Mo.opts.motion ? 'simulated' : 'excluded', q(SENS[Mo.opts.bias])].join(',')));
    saveFile(`scree_streets_${sc.r72}mm.csv`, lines.join('\n') + '\n', 'text/csv');
  });
  function briefingText() {
    const sc = stormSc(), rk = lastRank, a = lastArea, towns = TOWN_NAMES;
    const byTown = towns.map(t => { const xs = rk.all.filter(s => s.town === t); return `${t}: ${xs.filter(s => s.score >= 75).length} High, ${xs.filter(s => s.score >= 50 && s.score < 75).length} Elevated of ${xs.length} streets`; });
    const top = rk.all.slice(0, 8).map((s, n) => { const hi = Mo.tipStreet(s.k, sc, 75); return `${n + 1}. ${s.name}, ${s.town}: ${Math.round(s.score)} (${Mo.tier(s.score)})` + (s.score < 75 && hi != null ? `. High at ${hi} mm` : ''); });
    const similar = (() => { let best = null, bd = 1e9; for (let d = 61; d <= D1; d++) { const r = replaySc(d), dist = Math.hypot(r.r72 - sc.r72, (r.api - sc.api) * 0.7); if (dist < bd) { bd = dist; best = d; } } return bd < 45 ? best : null; })();
    const out = [`GROUNDTRUTH STORM BRIEFING, ${REG.short.toUpperCase()}`, `Scenario: ${sc.r72} mm of rain in the next 72 hours on soil at a wetness index of ${sc.api} mm. That is ${fmt(sc.r72 / 201 * 100)}% of the worldwide rainfall threshold for a 72 hour storm (Caine 1980, 201 mm). Alert sensitivity: ${SENS[Mo.opts.bias]}.`,
      `Exposure: ${fmt(a.highKm2, 1)} square km of hillside in the High tier (${fmt(a.high * 100, 1)}% of the map) and ${fmt(a.elevated * 100, 1)}% in Elevated. ${rk.elevated} of ${rk.total} named streets score Elevated or High, ${rk.high} of them High. ${fmt(lastBld.hi)} buildings stand on High ground and ${fmt(lastBld.el)} on Elevated, out of ${fmt(lastBld.total)} mapped.`,
      'By town:\n' + byTown.join('\n'), 'Streets to check first:\n' + top.join('\n')];
    if (similar != null) { const sd = addDays(R23.start, similar), near = events.filter(e => Math.abs(e.day - similar) <= 4); out.push(`Closest day in the winter 2023 record: ${dstr(sd)} (${fmt(replaySc(similar).r72)} mm in the following 72 hours, wetness ${fmt(R23.api[similar])} mm).` + (near.length ? ` Slides reported within four days of it: ${near.map(e => e.where).join('; ')}.` : ' No slides were reported within four days of it.')); }
    if (watch.length) out.push('Watched streets:\n' + rk.all.filter(s => watch.includes(s.name)).map(s => `${s.name}: ${Math.round(s.score)} (${Mo.tier(s.score)}). ${tipText(Mo.tipStreet(s.k, sc, 50), Mo.tipStreet(s.k, sc, 75))}`).join('\n'));
    { const se = seasonStats(HN - 1); if (se.pct != null) out.push(`Season so far (gauges, to ${dstr(addDays(RL.start, HN - 1))}): ${fmt(se.total)} mm since October 1, ${fmt(se.pct)}% of the average for this date.` + (se.pct >= 150 ? ' In a season this wet, slow deep slides can move between storms. This score keys on three day rain and does not capture that.' : '')); }
    out.push(`Limits: this run uses real terrain and real gauge rain only, and ${LSM ? 'the score is the trained landslide model, a ranking learned from 1,398 USGS mapped slides that is not yet calibrated or validated as a warning' : 'the score is a placeholder formula, not a trained or validated model. Use it to see how the tool works'}. For real decisions follow the National Weather Service and city engineering staff.`);
    return out.join('\n\n');
  }
  /* five day outlook: carry soil wetness forward day by day (API_d = 0.92 x API_d-1 + rain_d, as in the gauge record) */
  const ol = $('#outlook'), olIn = $('#olIn');
  for (let d = 0; d < 5; d++) { const l = document.createElement('label'); l.textContent = 'Day ' + (d + 1); const i = document.createElement('input'); i.type = 'number'; i.min = 0; i.max = 250; i.step = 1; i.inputMode = 'decimal'; i.value = [18, 62, 44, 8, 0][d]; i.addEventListener('input', renderOutlook); l.appendChild(i); olIn.appendChild(l); }
  const olVals = () => $$('#olIn input').map(i => Math.max(0, Math.min(250, parseFloat(i.value) || 0)));
  function renderOutlook() {
    const rain = olVals(), tb = $('#olBody'); tb.textContent = ''; let api = S.api; const days = [];
    for (let d = 0; d < 5; d++) { const sc = { r72: rain[d] + (rain[d + 1] || 0) + (rain[d + 2] || 0), api, era: 0, amt: 0 }; days.push({ sc, a: Mo.areaStats(sc), rk: Mo.rankStreets(sc, 1), b: Mo.buildingsAt(sc) }); api = 0.92 * api + rain[d]; }
    const pk = days.reduce((b, x, n) => Mo.Tof(x.sc) > Mo.Tof(days[b].sc) ? n : b, 0);
    days.forEach((x, n) => { const tr = document.createElement('tr'); if (n === pk && Mo.Tof(x.sc) > 0.3) tr.className = 'peak';
      tr.innerHTML = `<td>Day ${n + 1}</td><td>${fmt(x.sc.r72)} mm</td><td>${fmt(x.sc.api)} mm</td><td>${fmt(x.a.highKm2, 1)}</td><td>${fmt(x.b.el + x.b.hi)}</td><td>${fmt(x.rk.elevated)}</td><td></td>`;
      const b = document.createElement('button'); b.textContent = 'Show on map'; b.setAttribute('aria-label', `Show day ${n + 1} on the map`); b.addEventListener('click', () => { ol.close(); setStorm(Math.min(300, x.sc.r72), Math.min(280, x.sc.api), true); });
      tr.lastChild.appendChild(b); tb.appendChild(tr); });
    const w = watch.map(nm => { const k = G.streets.findIndex(s => s.n === nm); return `${nm}: ${days.map(x => Math.round(Mo.streetScore(k, x.sc).score)).join(', ')}`; });
    $('#olWatch').textContent = (w.length ? 'Your streets, day by day. ' + w.join('. ') + '. ' : '') + 'Days 4 and 5 see less than 72 hours of forecast, so they read low. Wetness is shown as each day begins.';
  }
  const OL = { nye: () => R23.mm.slice(91, 96), jan: () => R23.mm.slice(99, 104), light: () => [4, 9, 6, 2, 0], clear: () => [0, 0, 0, 0, 0] };
  $$('[data-ol]').forEach(b => b.addEventListener('click', () => { const v = OL[b.dataset.ol](); $$('#olIn input').forEach((i, n) => i.value = Math.round(v[n] || 0)); renderOutlook(); }));
  $('#outlookBtn').addEventListener('click', () => { renderOutlook(); ol.showModal ? ol.showModal() : ol.setAttribute('open', ''); });
  $('#olClose').addEventListener('click', () => ol.close()); ol.addEventListener('click', e => { if (e.target === ol) ol.close(); });

  const brief = $('#brief');
  function openBrief() { if (!lastRank) stormStats(); $('#briefText').textContent = briefingText(); $('#briefSrc').textContent = 'Built from the scores on this page for the storm you set. Every number comes from the model record.'; if (brief.showModal) brief.showModal(); else brief.setAttribute('open', ''); }
  $('#briefBtn').addEventListener('click', openBrief);
  $('#briefClose').addEventListener('click', () => brief.close ? brief.close() : brief.removeAttribute('open'));
  brief.addEventListener('click', e => { if (e.target === brief && brief.close) brief.close(); });
  $('#briefCopy').addEventListener('click', async e => { const b = e.currentTarget; try { await navigator.clipboard.writeText($('#briefText').textContent); b.textContent = 'Copied'; } catch (err) { const r = document.createRange(); r.selectNodeContents($('#briefText')); const g = getSelection(); g.removeAllRanges(); g.addRange(r); b.textContent = 'Selected, press copy'; } setTimeout(() => b.textContent = 'Copy text', 1800); });
  $('#briefSave').addEventListener('click', () => saveFile(`scree_briefing_${S.r72}mm.txt`, $('#briefText').textContent + '\n', 'text/plain'));

  /* ------------------------------------------------ explore mode */
  const exBtn = $('#exploreBtn');
  function setExplore(on) {
    exploring = on; document.body.classList.toggle('exploring', on); exBtn.setAttribute('aria-pressed', on); exBtn.textContent = on ? 'Back to view' : 'Free look'; requestAnimationFrame(refill);
    if (on) {
      const c = Sc.cam, dx = c.px - c.tx, dz = c.pz - c.tz; Object.assign(Sc.orbit, { tx: c.tx, tz: c.tz, dist: Math.hypot(dx, c.py, dz), az: Math.atan2(dx, dz), el: Math.atan2(c.py, Math.hypot(dx, dz)), on: true });
      pushScenario({ r72: S.r72, api: S.api, era: 0, amt: 0 }); syncExplore(); showEvents(false); samplePts.forEach(p => p.ring.show(true));
      $('#inspector').classList.toggle('on', !!sel);
    } else { Sc.orbit.on = false; $('#inspector').classList.remove('on'); samplePts.forEach(p => p.ring.show(false)); enter(active); }
  }
  function syncExplore() {
    const on = id => $(id).getAttribute('aria-pressed') === 'true';
    gsap.to(U.uRisk, { value: on('#exRisk') ? 1 : 0, duration: .4 }); U.uMotion.value = 0;
    gsap.to(U.uRoads, { value: on('#exRoads') ? 1 : 0, duration: .4 }); gsap.to(U.uBld, { value: on('#exBld') ? 1 : 0, duration: .4 }); Sc.setLayer('roads', on('#exRoads')); Sc.setLayer('buildings', on('#exBld')); Sc.setLayer('labels', on('#exLabels')); gsap.to(U.uSplitVis, { value: on('#exSat') ? 1 : 0, duration: .4 }); U.uSplit.value = 0; gsap.to(U.uDim, { value: 0, duration: .4 });
  }
  exBtn.addEventListener('click', () => setExplore(!exploring));
  ['#exRisk', '#exRoads', '#exBld', '#exLabels', '#exSat'].forEach(id => $(id).addEventListener('click', e => { const b = e.currentTarget; b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true'); if (!exploring) setExplore(true); else syncExplore(); }));
  window.addEventListener('keydown', e => { if (e.key === 'Escape' && exploring) setExplore(false); });

  /* ------------------------------------------------ street agent */
  const norm = s => s.toLowerCase().replace(/[.,?!']/g, '').replace(/\bst\b/g, 'street').replace(/\brd\b/g, 'road').replace(/\bdr\b/g, 'drive').replace(/\bblvd\b/g, 'boulevard').replace(/\bave\b/g, 'avenue').replace(/\bln\b/g, 'lane').replace(/\bct\b/g, 'court').replace(/\bsaint\b/g, 'st').replace(/\s+/g, ' ').trim();
  const sIndex = G.streets.map((s, k) => ({ k, key: norm(s.n).replace(/\bstreet\b/g, 'st') }));
  function findStreet(q) {
    const n = ' ' + norm(q).replace(/\bstreet\b/g, 'st') + ' '; let best = null;
    for (const s of sIndex) if (n.includes(' ' + s.key + ' ') && (!best || s.key.length > best.key.length)) best = s;
    if (best) return [best.k];
    const toks = n.trim().split(' ').filter(t => t.length > 3 && !['road', 'drive', 'lane', 'court', 'risk', 'this', 'weekend', 'what', 'about', 'street', 'does', 'look', 'safe', 'will', 'slide', 'landslide', 'right'].includes(t));
    return sIndex.filter(s => toks.some(t => s.key.split(' ').includes(t))).slice(0, 5).map(s => s.k);
  }
  function record(k, r72) {
    const st = G.streets[k], sc = { r72: r72 == null ? S.r72 : r72, api: S.api, era: 0, amt: 0 }, r = Mo.streetScore(k, sc); if (!r) return null;
    const lo = Mo.streetScore(k, { ...sc, r72: sc.r72 * 0.5 }).score, hi = Mo.streetScore(k, { ...sc, r72: sc.r72 * 1.5 }).score;
    const i = r.worst, L = Mo.L, t = Mo.terms(i, sc), [wl, wa] = Mo.lonlatOf(i);
    const near = G.events.filter(e => st.p.some(p => Math.hypot((p[0] - e.lonlat[0]) * 87800, (p[1] - e.lonlat[1]) * 110950) < 450)).map(e => `${e.date}: ${e.where}. ${e.what}`);
    return { street: st.n, town: st.t, score: Math.round(r.score), tier: Mo.tier(r.score), score_if_half_the_rain: Math.round(lo), score_if_one_and_a_half_times_the_rain: Math.round(hi),
      storm: { rain_next_72h_mm: sc.r72, soil_wetness_index_mm: sc.api, rain_amount_came_from: r72 == null ? 'the storm set on the page' : 'the amount named in the question' },
      buildings_along_street: (b => ({ total: b.total, on_ground_scored_elevated_or_high: b.flagged }))(Mo.streetBuildings(k, sc)),
      history_from_real_rain_since_oct_2015: (h => ({ days_scored_elevated: h.el, days_scored_high: h.hi, worst_day: h.worstDate, worst_day_score: Math.round(h.worst) }))(hindcast(s2 => Mo.streetScore(k, s2).score)),
      rain_in_72h_that_makes_it_elevated_mm: Mo.tipStreet(k, sc, 50), rain_in_72h_that_makes_it_high_mm: Mo.tipStreet(k, sc, 75), steepest_risky_spot: { slope_deg: +L.slope[i].toFixed(1), metres_to_stream: Math.round(L.dstream[i]) },
      top_reasons: t.parts.filter(p => p[1] > 0.15).sort((a, b) => b[1] - a[1]).slice(0, 3).map(p => p[0]), reported_slides_winter_2023_within_450m: near, _spot: [wl, wa] };
  }
  function templateAnswer(rec) {
    const why = rec.top_reasons.length ? rec.top_reasons.map(s => s.toLowerCase()).join(', ') : 'no strong drivers';
    const out = [`${rec.street}, ${rec.town}: ${rec.tier}, ${rec.score} out of 100.`,
      `That is for ${rec.storm.rain_amount_came_from === 'the storm set on the page' ? 'the storm set on this page' : 'the rain you named'}: ${rec.storm.rain_next_72h_mm} mm of rain in 72 hours on soil at a wetness index of ${rec.storm.soil_wetness_index_mm} mm. What drives it at the riskiest spot along the street: ${why}. The slope there is ${rec.steepest_risky_spot.slope_deg} degrees.`,
      `If the storm brings half the rain the score is ${rec.score_if_half_the_rain}. At one and a half times it is ${rec.score_if_one_and_a_half_times_the_rain}.`];
    out.push(`Tipping points at this soil wetness: ${tipText(rec.rain_in_72h_that_makes_it_elevated_mm, rec.rain_in_72h_that_makes_it_high_mm)} of rain in 72 hours.`);
    if (rec.buildings_along_street.total) out.push(`${rec.buildings_along_street.on_ground_scored_elevated_or_high} of the ${rec.buildings_along_street.total} buildings along it stand on ground scored Elevated or High in this storm.`);
    { const h = rec.history_from_real_rain_since_oct_2015; out.push(`Scored against every day of real rain since October 2015, it reaches Elevated on ${h.days_scored_elevated} ${h.days_scored_elevated === 1 ? 'day' : 'days'} and High on ${h.days_scored_high}. Its worst day is ${h.worst_day} at ${h.worst_day_score}.`); }
    if (rec.reported_slides_winter_2023_within_450m.length) out.push(`Reported nearby in winter 2023: ${rec.reported_slides_winter_2023_within_450m.join(' ')}`);
    out.push('This run uses real terrain and real gauge rain' + (LSM ? ', and the score is the trained landslide model, a ranking that is not yet calibrated. It is not an inspection of the real street.' : ' and the score is a placeholder, so this shows how the tool works. It is not a reading of the real street.') + ' For a real concern, call your city engineering staff or a licensed geotechnical engineer.');
    return out;
  }
  const msgs = $('#msgs');
  function bubble(cls, paras, src) {
    const d = document.createElement('div'); d.className = 'msg ' + cls;
    for (const p of [].concat(paras)) { const el = document.createElement('p'); el.textContent = p; d.appendChild(el); }
    if (src) { const s = document.createElement('span'); s.className = 'src'; s.textContent = src; d.appendChild(s); }
    msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight;
    if (!reduce) gsap.from(d, { y: 6, autoAlpha: 0, duration: 0.28, ease: 'power3.out' });
    return d;
  }
  let sampler = null; const getSampler = () => Promise.resolve(null);
  /* Agent path: when Claude is available, it answers open questions by calling these page functions. Every number it can say comes from one of them. */
  const exactStreet = name => { const ks = findStreet(String(name || '')); return ks.length === 1 ? ks[0] : -1; };
  const pubRecord = (k, r72) => { const rec = record(k, r72); if (!rec) throw new Error('That street has no cells to score.'); const p = { ...rec }; delete p._spot; return p; };
  let agentShown = null;                                           // street the agent last put on the map
  const TOOLS = [
    { name: 'find_streets', description: 'Search street names in ' + REG.places + '. Returns up to 8 matches with their town. Use it when a name is misspelled, partial or ambiguous.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: ({ query }) => { const v = norm(String(query || '')); const hits = G.streets.filter(s => norm(s.n).includes(v)).slice(0, 8); return hits.length ? hits.map(s => ({ street: s.n, town: s.t })) : findStreet(String(query || '')).map(k => ({ street: G.streets[k].n, town: G.streets[k].t })); } },
    { name: 'street_report', description: 'Full risk record for one street: score out of 100 and tier, drivers, tipping point rain, buildings on flagged ground, history against real rain since October 2015, reported 2023 slides nearby. Optional rain_mm overrides the 72 hour rain set on the page. Also shows the street on the map.',
      inputSchema: { type: 'object', properties: { street: { type: 'string' }, rain_mm: { type: 'number' } }, required: ['street'] },
      execute: ({ street, rain_mm }) => { const k = exactStreet(street); if (k < 0) throw new Error('No single street matches that name. Call find_streets first.'); const rec = pubRecord(k, rain_mm == null ? null : Math.max(0, Math.min(400, Math.round(rain_mm)))); flyToStreet(k); agentShown = G.streets[k].n; return rec; } },
    { name: 'top_streets', description: 'Streets with the highest scores under the storm set on the page. Optional town (' + TOWN_NAMES.join(', ') + ') and count (max 10).',
      inputSchema: { type: 'object', properties: { town: { type: 'string' }, count: { type: 'number' } } },
      execute: ({ town, count } = {}) => { const rk = lastRank || Mo.rankStreets(stormSc(), 6); const xs = rk.all.filter(s => !town || s.town.toLowerCase() === String(town).toLowerCase()).slice(0, Math.max(1, Math.min(10, count || 5))); return { storm: { rain_next_72h_mm: S.r72, soil_wetness_index_mm: S.api }, streets: xs.map(s => ({ street: s.name, town: s.town, score: Math.round(s.score), tier: Mo.tier(s.score) })), streets_elevated_or_high: rk.elevated, streets_scored: rk.total }; } },
    { name: 'storm_summary', description: 'Area-wide numbers for the storm set on the page: hillside area and buildings on High and Elevated ground, streets flagged, how often the gauge record since October 2015 was this wet, alert sensitivity, whether simulated ground motion is included.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => { const sc = stormSc(), a = Mo.areaStats(sc), b = Mo.buildingsAt(sc), rk = lastRank || Mo.rankStreets(sc, 6), T = Mo.Tof(sc); let n = 0; for (let d = 0; d < HN - 3; d++) if (hT[d] >= T) n++;
        return { rain_next_72h_mm: sc.r72, soil_wetness_index_mm: sc.api, season_rain_since_oct_1: (se => ({ mm: Math.round(se.total), percent_of_average_for_this_date: se.pct == null ? null : Math.round(se.pct), as_of: dstr(addDays(RL.start, HN - 1)) }))(seasonStats(HN - 1)), percent_of_worldwide_72h_rain_threshold: Math.round(sc.r72 / 201 * 100), high_tier_km2: +a.highKm2.toFixed(1), percent_of_map_high: +(a.high * 100).toFixed(1), percent_of_map_elevated: +(a.elevated * 100).toFixed(1), buildings_on_high_ground: b.hi, buildings_on_elevated_ground: b.el, buildings_mapped: b.total, streets_elevated_or_high: rk.elevated, streets_scored: rk.total, days_this_wet_or_wetter_since_oct_2015: n, days_in_record: HN - 3, alert_sensitivity: SENS[Mo.opts.bias], ground_motion_input: Mo.opts.motion ? 'simulated sample' : 'excluded, real terrain and rain only' }; } },
    { name: 'debris_path', description: 'Trace where debris would travel downhill from the riskiest spot on a street: path length, height drop, streets in the way, creek, buildings within 30 m. Draws the path on the map. A screening estimate, not a flow simulation.',
      inputSchema: { type: 'object', properties: { street: { type: 'string' } }, required: ['street'] },
      execute: ({ street }) => { const k = exactStreet(street); if (k < 0) throw new Error('No single street matches that name. Call find_streets first.'); const r = Mo.streetScore(k, stormSc()), ro = Mo.runout(r.worst); flyToStreet(k); Sc.showPath(ro.path.map(Mo.lonlatOf)); agentShown = G.streets[k].n;
        return { from: 'the highest scoring cell along ' + G.streets[k].n, path_length_m: ro.length, height_drop_m: ro.drop, ends: { reach: 'where debris would be expected to stop', flat: 'where the ground levels out', basin: 'in a closed low spot', edge: 'at the edge of the map', far: 'trace cut off at 3 km' }[ro.why], streets_in_the_way: ro.streets.filter(x => x.name !== G.streets[k].n).slice(0, 6).map(x => ({ street: x.name, metres_along_path: x.dist })), joins_creek_after_m: ro.creek >= 0 ? ro.creek : null, buildings_within_30m_of_path: Mo.buildingsNear(ro.path, 1), method: 'steepest descent on a 29 m elevation grid, screening estimate only' }; } },
    { name: 'backtest_summary', description: 'How the score did against the ' + events.length + ' slides reported in winter 2022 to 2023, at each alert sensitivity: slides caught, share of the map flagged, median rank, and how often a slide site outscores a random street spot.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => { const mo = Mo.opts.motion, bias = Mo.opts.bias, out = {}; for (const b of Object.keys(SENS).map(Number)) { const k = mo + '|' + b; if (!btCache[k]) { Mo.opts.bias = b; btCache[k] = backtest(); btCache[k].alerts = alertDays(); Mo.opts.bias = bias; } const r = btCache[k]; out[SENS[b]] = { slides_caught_of_10: r.hits, percent_of_map_flagged: +(r.area * 100).toFixed(1), median_slide_site_rank_top_percent: +(r.top * 100).toFixed(1), random_street_spot_rank_top_percent: +(r.nullTop * 100).toFixed(1), times_in_10_a_slide_site_outscores_a_random_street_spot: +(r.auc * 10).toFixed(1), alert_days_per_winter_over_the_gauge_record: r.alerts ? +r.alerts.perYear.toFixed(1) : undefined, alert_days_in_winter_2023: r.alerts ? r.alerts.wy23 : undefined }; }
        return { setting_in_use: SENS[bias], by_setting: out, spot_check_other_winters_at_setting_in_use: OTHER.map(e => { let peak = 0; for (let d = e.day - 3; d < e.day; d++) peak = Math.max(peak, Mo.maxNear(e.q[0], e.q[1], hsc(d), RAD)); return { slide: e.where, reported: e.date, score_beforehand: Math.round(peak), tier: Mo.tier(peak) }; }), caveats: events.length + ' events, street-level positions, gauge rain used as a perfect forecast, placeholder score' }; } }
  ];
  const AGENT_RULES = `You are the escape street risk assistant for ${REG.places}, California. Answer the resident's question by calling the tools. Every number, street name and fact in your answer must come from a tool result in this conversation. Do not add anything from memory. If a tool fails or returns nothing, say what you could not find.
Write plain sentences. No markdown, no lists, no dashes, no headings. Under 150 words. Lead with the direct answer. Give scores as a number out of 100 with the tier. Say which storm the numbers assume. Never say a street, home or slope is safe.
End with one sentence saying that the score is a ranking, not a calibrated probability, so this is a demonstration and real concerns go to city engineering staff or a licensed geotechnical engineer.`;
  async function agentAnswer(q, s) {
    const wait = bubble('wait', 'Working on it...'); agentShown = null;
    try {
      const res = await s(`${AGENT_RULES}\n\nStorm set on the page: ${S.r72} mm of rain in the next 72 hours, soil wetness index ${S.api} mm.\n\nResident's question: ${q}`,
        { modelTier: 'default', cache: false, tools: TOOLS, onText: ({ text }) => { if (text) { wait.classList.remove('wait'); wait.firstChild.textContent = text; msgs.scrollTop = msgs.scrollHeight; } } });
      if (!res || !res.text) throw new Error('empty');
      wait.classList.remove('wait'); wait.firstChild.textContent = res.text;
      const sp = document.createElement('span'); sp.className = 'src'; sp.textContent = 'Written by Claude from the model record on this page'; wait.appendChild(sp);
      if (agentShown) watchButton(wait, agentShown);
      msgs.scrollTop = msgs.scrollHeight; return true;
    } catch (e) { wait.remove(); if (e && e.code === 'not_granted') sampler = null; return false; }
  }
  const GUIDE = ['WARNING SIGNS TO WATCH FOR (U.S. Geological Survey landslide guidance)\n- New cracks or bulges in the ground, pavement or sidewalks\n- Soil pulling away from foundations; decks, patios or stairs tilting or separating from the house\n- Doors and windows that start to stick, new cracks in walls or floors\n- Leaning trees, fences, retaining walls or utility poles; offset fence lines\n- Springs, seeps or soggy ground where it is normally dry; broken water lines\n- A creek that rises fast and turns muddy, or drops suddenly while it is still raining\n- A faint rumble that grows louder, trees cracking, boulders knocking together',
    'WHAT TO DO\n- In immediate danger, leave if it is safe and call 911\n- During intense rain stay awake and alert; many debris flow deaths happen while people sleep\n- Listen for unusual sounds and watch the creek below you\n- Report new cracks or moving ground to your city public works or fire department, and tell the neighbors downhill\n- Before the wet season, keep drains, gutters and culverts clear and send roof water away from the slope\n- Follow National Weather Service flood and debris flow warnings and the Contra Costa County Community Warning System',
    'LIMITS\nescape is a student project. In Lamorinda the score is a trained landslide model that ranks ground; it is not a calibrated chance of a slide. San Francisco uses a placeholder formula from real terrain and rain. It cannot tell you a slope is safe.'];
  function reportButton(d, street, lines) { const b = document.createElement('button'); b.className = 'btn sm act'; b.style.marginLeft = '8px'; b.textContent = 'Download report'; b.addEventListener('click', () => saveFile('groundtruth_' + street.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.txt', 'GROUNDTRUTH STREET REPORT\n\n' + [].concat(lines, GUIDE).join('\n\n') + '\n', 'text/plain')); d.appendChild(b); const m = $('#msgs'); if (d.offsetHeight > m.clientHeight) m.scrollTop = d.offsetTop - m.offsetTop; else m.scrollTop = m.scrollHeight; }
  function watchButton(d, street) { const b = document.createElement('button'); b.className = 'btn sm act'; const lab = () => b.textContent = watch.includes(street) ? 'Watching. Remove' : 'Watch this street'; lab(); b.addEventListener('click', () => { toggleWatch(street); lab(); }); d.appendChild(b); }


  /* Area-wide forecast for open questions ("what's your prediction", "will there be landslides").
     Lamorinda: the trained landslide model scores every 29 m cell and every street. San Francisco has no landslide model, so it uses the placeholder score the map draws. */
  const GENERAL_Q = /\b(predict\w*|forecast\w*|outlook|landslides?|slides?|risk\w*|danger\w*|safe|overall|area|everywhere|anywhere|today|tonight|now|this week(end)?|storm|expect\w*|happen\w*|will there|how bad|should i (worry|be worried)|what do you think)\b/i;
  const LS = () => REG.landslideModel && window.GTLocalModel;
  const LS_SRC = 'Trained landslide model · 1,398 USGS mapped slides · scored in this browser';
  function lsValidation(long) {
    const rp = LS().report, cv = rp.best_cv, ho = rp.holdout_winter2023, t = ho.tuned, sl = ho.slope_alone;
    const short = `Model check: in 5-fold spatial cross-validation it ranked slide cells above others ${(cv.auc * 10).toFixed(1)} times in 10 (${(cv.where * 10).toFixed(1)} on where alone). On the ${t.events.length} winter 2023 slides it never saw, a slide site sat on average above ${Math.round(t.mean_land_percentile * 100)}% of the land (slope alone: ${Math.round(sl.mean_land_percentile * 100)}%) and above ${Math.round(t.mean_share_street_spots_beaten * 100)}% of random street spots (slope alone: ${Math.round(sl.mean_share_street_spots_beaten * 100)}%).`;
    if (!long) return short;
    const c = rp.best_cfg;
    return [`Landslide model for ${rp.area}: ${c.n_trees} gradient-boosted trees of depth ${c.max_depth}, trained on ${fmt(rp.data.slides)} slides the USGS mapped in the 2016 to 2017 storm season (${fmt(rp.data.positive_cells)} slide cells). Slide-free ground was sampled only inside the area the USGS mapped, at least 90 m from any slide. Inputs: terrain (slope, steepest slope within 90 m, relief within 150 m, aspect, curvature, wetness index, distance to a stream) and the storm (72 hour rain, soil wetness). Elevation, distance to a road and vegetation are left out on purpose. Settings were picked from ${fmt(rp.configs_tried)} tries by spatial cross-validation.`,
      short, 'Scores rank ground from 0 to 100. They are not calibrated chances of a slide, and 11 test slides are a small test: promising, not proven. Rain in the tests is the observed gauge rain, used as a perfect forecast.'];
  }
  const LS_LIMIT = 'Scores rank ground and are not calibrated chances of a slide, and they never mean a slope is safe. For a real concern call city engineering staff or a licensed geotechnical engineer.';
  const PH_LIMIT = REG.short + ' has no trained landslide model yet, so this is the placeholder score the map draws from real terrain and rain. It is relative risk, not a chance of a slide, and it never means a slope is safe. For a real concern call city engineering staff or a licensed geotechnical engineer.';
  const bandOf = v => Mo.tier(v);                                  // the same 25 / 50 / 75 bands the map uses, named Guarded, Elevated, High
  async function forecastAnswer(r72, api, rainFrom) {
    const sc = { r72, api, era: 0, amt: 0 }, ml = LS(), T = Mo.Tof(sc), pct = v => (v * 100).toFixed(1) + '%';
    let n = 0; for (let d = 0; d < HN - 3; d++) if (hT[d] >= T) n++;
    let top, hiS, elS, total, aHi, aEl, bHi = 0, bEl = 0, bTot = Mo.buildingsAt(sc).total, src;
    if (ml) {
      const wait = bubble('wait', 'Scoring every slope with the landslide model...'); await new Promise(r => setTimeout(r, 30));
      const cells = ml.area(r72, api), rk = ml.rank(r72, api, G.streets.length), L = Mo.L; let v = 0, h = 0, e = 0;
      for (let i = 0; i < cells.length; i++) { if (!ml.valid[i]) continue; v++; const x = cells[i]; if (x >= 75) { h++; if (L.bld) bHi += L.bld[i]; } else if (x >= 50) { e++; if (L.bld) bEl += L.bld[i]; } }
      wait.remove();
      top = rk.slice(0, 3).map(s => ({ k: s.k, name: G.streets[s.k].n, town: G.streets[s.k].t, score: s.score }));
      hiS = rk.filter(s => s.score >= 75).length; elS = rk.filter(s => s.score >= 50).length; total = rk.length; aHi = h / v; aEl = e / v; src = LS_SRC;
    } else {
      const a = Mo.areaStats(sc), rk = Mo.rankStreets(sc, 3), b = Mo.buildingsAt(sc);
      top = rk.top; hiS = rk.high; elS = rk.elevated; total = rk.total; aHi = a.high; aEl = a.elevated; bHi = b.hi; bEl = b.el; src = 'Dashboard placeholder score · same as the map';
    }
    const peak = top.length ? top[0].score : 0, level = hiS ? 'High' : elS ? 'Elevated' : bandOf(peak);
    const what = ml ? 'the landslide model' : 'the map score';
    const out = [`Prediction for ${REG.places} from ${what}: overall ${level}. ${hiS ? `${fmt(hiS)} of ${fmt(total)} scored streets reach High and ${fmt(elS)} reach Elevated or higher.` : elS ? `${fmt(elS)} of ${fmt(total)} scored streets reach Elevated, and none reach High.` : `None of the ${fmt(total)} scored streets reach Elevated. The highest street score is ${Math.round(peak)} out of 100.`}`,
      `${pct(aHi)} of the ground scores High (75 or more) and ${pct(aEl)} scores Elevated (50 to 75). ${fmt(bHi)} buildings stand on High ground and ${fmt(bEl)} on Elevated ground, out of ${fmt(bTot)} mapped.`];
    if (top.length) out.push('Most at risk: ' + top.map(s => `${s.name}, ${s.town} (${Math.round(s.score)}, ${bandOf(s.score)})`).join('; ') + '.');
    out.push(`What drives it: ${rainFrom}, ${Math.round(r72)} mm of rain in 72 hours on soil at a wetness index of ${Math.round(api)} mm. That rain is ${fmt(r72 / 201 * 100)}% of the worldwide 72 hour landslide threshold (Caine 1980, 201 mm). ${n ? `The real gauges saw rain and soil this wet or wetter on ${fmt(n)} of ${fmt(HN - 3)} days since October 2015.` : 'Nothing in the gauge record since October 2015 was this wet.'}`);
    if (ml) out.push('The High and Elevated bands are the map\'s 75 and 50 cut points applied to the model score, the same score the map draws. They are not validated alert levels. ' + lsValidation(false), LS_LIMIT);
    else out.push(PH_LIMIT);
    const d = bubble('', out, src);
    if (top.length) flyToStreet(top[0].k);
    return d;
  }
  /* San Francisco flood model: trees trained on SF 311 rain-linked flood reports (model/train_sf_flood.py). The page shows its saved street predictions for the
     November 18, 2026 storm (site/data_sf/flood_model.js); it does not change with the storm sliders, and the landslide map does not use it. */
  function floodAbout() {
    const m = window.GT_FLOOD.meta;
    return `Flood model (separate from the landslide score): ${m.trees} gradient-boosted trees of depth ${m.depth}, picked from ${fmt(m.configs_tried)} settings by spatial cross-validation on SF 311 flood reports filed before October 2022 (area under the curve ${m.cv_auc.toFixed(2)}). Scored once afterwards on data it never saw: winter 2023 ${m.test_winter2023.toFixed(2)}, the November 2026 storm ${m.test_nov2026.toFixed(2)} (${m.test_nov2026_where.toFixed(2)} on where alone). 0.5 is a coin flip. ${m.caveat}`;
  }
  /* Lamorinda flood score: FEMA flood zones, USGS creeks and height above them, storm rain. Hand set from real layers, not trained (js/floodl.js) */
  function floodAboutL() {
    const m = GTFloodL.meta, c = m.checks || [], hit = c.filter(x => x.score >= 45).length, rs = (m.rain_checks || []).map(r => r.r72).sort((a, b) => a - b);
    return `Lamorinda flood score (separate from the landslide model): FEMA's flood zones first, then how low the ground sits above the nearest USGS-mapped creek and how close it is, times a storm factor from 3 day rain and soil wetness. The weights are set by hand, not trained, because too few Lamorinda floods have a recorded place. Thin check: ${hit} of ${c.length} NOAA Storm Events flood reports with a location in the map fall on ground it calls Elevated or High, and a report spot outscored a random spot ${(m.beats_random * 10).toFixed(1)} times in 10. Every dated local flood since 2015 came after ${rs.length ? fmt(rs[0]) + ' to ' + fmt(rs[rs.length - 1]) + ' mm' : 'heavy'} of rain in 3 days, in the wettest 9% of days.`;
  }
  function floodAnswerL(q, r72, api, named) {
    const F = GTFloodL, ks = findStreet(q.replace(/\bflood\w*\b/gi, ' ')), all = F.streets(), stormTxt = named ? `${fmt(r72)} mm of rain in 3 days` : `the storm on the sliders (${fmt(r72)} mm in 3 days)`;
    const SRC = 'Lamorinda flood score · FEMA zones, USGS creeks and elevation · hand set, not trained';
    if (ks.length) {
      const paras = [];
      for (const k of ks.slice(0, 4)) { const o = F.streetByName(G.streets[k].n); if (!o) { paras.push(`${G.streets[k].n}: no flood score (too short or off the map).`); continue; }
        const lv = F.placeLevel(o.w); paras.push(`${o.n}: flood-prone ground ${lv} (${fmt(o.w / 2.55, 0)} / 100), ranked ${fmt(o.rank)} of ${fmt(all.length)} Lamorinda streets (1 is the most flood-prone). ${o.fema ? `${fmt(o.fema)} of its ${fmt(o.cells)} cells are in a FEMA 1% flood zone.` : 'None of it is in a FEMA 1% flood zone.'} With ${stormTxt}, its score is ${fmt(F.score(o.w, r72, api), 0)} / 100.`); }
      bubble('', paras.concat(floodAboutL()), SRC); return;
    }
    const top = all.slice(0, 10).map(o => `${o.n} (${fmt(F.score(o.w, r72, api), 0)})`).join(', ');
    bubble('', [`Lamorinda streets with the most flood-prone ground, with ${stormTxt}: ${top}. Scores are out of 100; ties are broken by how much of the street lies in FEMA flood zones.`,
      `About ${fmt(F.meta.share_high * 100, 1)}% of the map area scores High (FEMA 1% zone or right on a creek) and ${fmt(F.meta.share_elev * 100, 1)}% Elevated. Type your address on the Overview to see it on the map.`, floodAboutL()], SRC);
  }
  function floodAnswer() {
    const F = window.GT_FLOOD, m = F.meta, top = Object.entries(F.streets).sort((a, b) => a[1][1] - b[1][1]).slice(0, 8);
    const town = n => { const k = G.streets.findIndex(s => s.n === n); return k >= 0 ? G.streets[k].t : ''; };
    const d = bubble('', [`Flood model for San Francisco, the November 18, 2026 storm (${m.rain_72h_mm.toFixed(0)} mm in 72 hours from the morning of November 16, a record day downtown). Streets most likely to flood, by the model:`,
      ...top.map(([n, v]) => `${v[1]}. ${n}${town(n) ? ', ' + town(n) : ''}: ${v[0].toFixed(1)} / 100`),
      `Each street score is the mean of its top 10% of 29 m cells within 150 m. Across the city map, cells with a 311 flood report that day outscored the rest ${(m.map_auc * 10).toFixed(1)} times in 10.`, floodAbout()],
      'San Francisco flood model · trained on SF 311 reports · saved predictions');
    const k = G.streets.findIndex(s => s.n === top[0][0]); if (k >= 0) flyToStreet(k);
    return d;
  }
  async function ask(q) {
    q = q.trim(); if (!q) return;
    bubble('me', q); $('#askIn').value = ''; hideSugg();
    if (/^\s*\d+[a-z]?\s+[a-z]/i.test(q) && !/\b(mm|millimet\w*|inch\w*|in)\b/i.test(q) && window.GTAddress) { bubble('', 'That looks like an address. Your answers for it are on the Overview.'); GTAddress.check(q); return; }
    const ml = LS();
    if (REG.landslideModel && !ml) { bubble('', 'The landslide model did not load. Run model/export_landslide_site.py and reload this page.'); return; }
    const rainMatch = q.match(/(\d+(?:\.\d+)?)\s*(mm|millimet(?:ers|res)?|inches|inch|in\b|")/i);
    const followSim = REG.id === 'lamorinda' && $('#simFollow').checked && localSimulation;
    const r72 = rainMatch ? Math.max(0,Math.min(400,parseFloat(rainMatch[1]) * (/^(mm|millimet)/i.test(rainMatch[2]) ? 1 : 25.4))) : followSim ? localSimulation.rain_72h_mm : S.r72;
    const apiMatch = q.match(/(?:wetness|api)\s*(?:of|=|:)?\s*(\d+(?:\.\d+)?)/i);
    const api = apiMatch ? Math.max(0,Math.min(280,+apiMatch[1])) : followSim ? localSimulation.api_mm : S.api;
    const sc = { r72, api, era: 0, amt: 0 };
    let source = ml ? LS_SRC : 'Dashboard placeholder score · same as the map';
    const limit = ml ? LS_LIMIT : PH_LIMIT;
    const FL = REG.id === 'sf' && window.GT_FLOOD;          // San Francisco flood model (local_model_sf), saved predictions for the November 2026 storm
    if (FL && /\bflood\w*\b/i.test(q) && !findStreet(q.replace(/\bflood\w*\b/gi, ' ')).length) { floodAnswer(); return; }
    if (REG.id === 'lamorinda' && window.GTFloodL && /\bflood\w*\b/i.test(q)) { floodAnswerL(q, r72, api, !!rainMatch); return; }   // Lamorinda flood score (js/floodl.js)
    if (/\b(model|trained|training|accuracy|validation|validated|backtest|how good|how accurate)\b/i.test(q) && !findStreet(q).length) {
      if (ml) bubble('', [].concat(lsValidation(true), 'The map, the stat chips, the backtest view and Ask all use this model. Alert sensitivity on the map shifts its scores up for more alerts; Ask reports the model as trained.'), LS_SRC);
      else bubble('', [REG.short + ' has no trained landslide model yet. Ask and the map use the placeholder score from real terrain and rain. The trained landslide model covers Lamorinda only, where the USGS mapped the 2016 to 2017 slides.'].concat(FL ? [floodAbout()] : []), FL ? 'San Francisco flood model · trained on SF 311 reports' : source);
      return;
    }
    const nq = ' '+norm(q).replace(/\bstreet\b/g,'st')+' ';
    const named = sIndex.filter(x=>nq.includes(' '+x.key+' ')).filter((x,_,all)=>!all.some(y=>y!==x && y.key.length>x.key.length && y.key.includes(x.key)));
    let ks = [...new Set(named.map(x=>x.k))];
    const rainFrom = rainMatch ? 'the rain you named' : followSim ? 'the historical playback on ' + localSimulation.simulation_date : 'the storm set on the page';
    const TOP_Q = /\b(worst|highest|top streets|which streets|briefing|brief me)\b/i;
    if (!named.length && GENERAL_Q.test(q) && !findStreet(q.replace(new RegExp(GENERAL_Q.source, 'gi'), ' ')).length && !TOP_Q.test(q)) { await forecastAnswer(r72, api, rainFrom); return; }
    if (TOP_Q.test(q)) {
      const town = TOWN_NAMES.find(t=>new RegExp('\\b'+t+'\\b','i').test(q));
      let scores;
      if (ml) { const wait = bubble('wait','Scoring every street with the landslide model...'); await new Promise(resolve=>setTimeout(resolve,30)); scores = ml.rank(r72, api, G.streets.length); wait.remove(); }
      else scores = Mo.rankStreets(sc, 0).all;
      if (town) scores=scores.filter(v=>G.streets[v.k].t===town);
      bubble('', [`${ml ? 'Landslide model ranking' : 'Map score ranking'}${town?' for '+town:''}: ${r72.toFixed(0)} mm of rain in 72 hours on soil at a wetness index of ${Math.round(api)} mm (${rainFrom}).`,
        ...scores.slice(0,5).map((v,n)=>`${n+1}. ${G.streets[v.k].n}, ${G.streets[v.k].t}: ${v.score.toFixed(1)} out of 100, ${bandOf(v.score)}.`)].concat(ml ? [lsValidation(false)] : [], [limit]),source);
      if(scores.length) flyToStreet(scores[0].k); return;
    }
    if (!ks.length) ks=findStreet(q);
    if (ks.length!==1 && named.length<2) {
      if (!ks.length) { const d = await forecastAnswer(r72, api, rainFrom); const p = document.createElement('p'); p.textContent = 'For one street, name it in ' + REG.placesOr + '. Example: ' + (REG.example || 'Miner Road with 100 mm rain') + '.'; d.insertBefore(p, d.querySelector('.src')); return; }
      bubble('',['Please choose a street:',...ks.map(k=>G.streets[k].n+', '+G.streets[k].t)]); return;
    }
    const paras=[`${ml ? 'Landslide model' : 'Map score'}${followSim ? ', historical playback '+localSimulation.simulation_date : ''}: ${r72.toFixed(0)} mm of rain in 72 hours on soil at a wetness index of ${Math.round(api)} mm (${rainFrom}).`];
    let first=null; const scored=[];
    for (const k of ks.slice(0,4)) {
      const st=G.streets[k];
      if (!ml) {
        const r = Mo.streetScore(k, sc); if (!r) { paras.push(st.n+': no cells inside the study grid.'); continue; }
        if (!first) first = { k, v: r }; scored.push({ k, score: r.score });
        const lo = Mo.streetScore(k, { ...sc, r72: r72 * .5 }).score, hi = Mo.streetScore(k, { ...sc, r72: Math.min(400, r72 * 1.5) }).score, t = Mo.terms(r.worst, sc);
        const why = t.parts.filter(p => p[1] > 0.15).sort((a, b) => b[1] - a[1]).slice(0, 3).map(p => p[0].toLowerCase());
        paras.push(`${st.n}, ${st.t}: ${Math.round(r.score)} out of 100, ${Mo.tier(r.score)}. Half the rain: ${Math.round(lo)}; 1.5 times the rain: ${Math.round(hi)}.${why.length ? ' What drives it at the riskiest spot: ' + why.join(', ') + '.' : ''}`);
      } else {
        let serverPrediction = null;
        try { serverPrediction = await backendStreet(k,r72,api); } catch (_) { paras.push('The server could not score this request; using the same model in your browser. This result was not saved to history.'); }
        const v=serverPrediction || ml.street(k,r72,api); if(!v) {paras.push(st.n+': no cells inside the study grid.');continue;}
        if (serverPrediction) source = 'Trained landslide model · Python backend · prediction saved to history';
        if(!first) first={k,v}; scored.push({ k, score: v.score });
        const lo=serverPrediction ? {score:serverPrediction.half_rain_score} : ml.street(k,r72*.5,api), hi=serverPrediction ? {score:serverPrediction.more_rain_score} : ml.street(k,r72*1.5,api);
        paras.push(`${st.n}, ${st.t}: ${v.score.toFixed(1)} out of 100, ${bandOf(v.score)} band (a ranking score, not a chance of a slide). Half the rain: ${lo.score.toFixed(1)}; 1.5 times the rain: ${hi.score.toFixed(1)}.`);
        const changes=(serverPrediction ? serverPrediction.explanation : ml.explain(k,r72,api)).filter(x=>x.change>0.1).slice(0,3);
        if(changes.length) paras.push('What pushes the score up at its highest-scoring spot: '+changes.map(x=>`${x.name} (${x.change.toFixed(1)} points against a flat, dry reference)`).join(', ')+'. These are what-if comparisons, not causes.');
      }
      if (/\b(debris|runout|path|downhill)\b/i.test(q) && first && first.k === k) {
        const ro=Mo.runout(first.v.worst); Sc.showPath(ro.path.map(Mo.lonlatOf));
        paras.push(`Terrain-only screening path from that spot: ${ro.length} m long, ${ro.drop} m elevation drop. A steepest-descent trace, not a model runout prediction.`);
      }
    }
    if (scored.length > 1) { const w = scored.slice().sort((a, b) => b.score - a.score)[0]; paras.push(`Of these, ${G.streets[w.k].n} scores highest.`); }
    if (FL) for (const k of ks.slice(0, 4)) { const f = FL.streets[G.streets[k].n]; if (f) paras.push(`Flood model, a separate model for street flooding: on the ${FL.meta.rain_72h_mm.toFixed(0)} mm storm of November 18, 2026, ${G.streets[k].n} scored ${f[0].toFixed(1)} / 100 and ranked ${fmt(f[1])} of ${fmt(FL.meta.n_streets)} streets (1 is the most flood-prone). A ranking, not a chance of flooding.`); }
    if (ml && /\b(history|buildings|homes|houses|tipping|how often)\b/i.test(q)) paras.push('History, building counts and tipping points for a street are in the slope panel and the Storm view, which use the same model; tipping points are coarse because the model only tells a few rain levels apart.');
    if (ml) paras.push(lsValidation(false));
    paras.push(limit);
    const d=bubble('',paras,source);
    if(first) {flyToStreet(first.k); Sc.highlight(...Mo.lonlatOf(first.v.worst),true); watchButton(d,G.streets[first.k].n); reportButton(d,G.streets[first.k].n,paras);}
  }
  $('#askForm').addEventListener('submit', e => { e.preventDefault(); const a = $('#sugg .act'); if (a && !$('#sugg').hidden) { ask(a.dataset.n); return; } ask($('#askIn').value); });
  $$('#askChips [data-q]').forEach(b => b.addEventListener('click', () => ask(b.dataset.q)));
  const sugg = $('#sugg'); function hideSugg() { sugg.hidden = true; sugg.textContent = ''; }
  $('#askIn').addEventListener('input', e => {
    const v = norm(e.target.value); hideSugg(); if (v.length < 2 || v.includes(' at ') || v.split(' ').length > 3) return;
    const hits = G.streets.map((s, k) => ({ s, k })).filter(o => norm(o.s.n).startsWith(v) || norm(o.s.n).includes(' ' + v)).slice(0, 6); if (!hits.length) return;
    for (const h of hits) { const li = document.createElement('li'), b = document.createElement('button'); b.type = 'button'; b.dataset.n = h.s.n; b.innerHTML = '<span></span><small></small>'; b.firstChild.textContent = h.s.n; b.lastChild.textContent = h.s.t; b.addEventListener('click', () => ask(h.s.n)); li.appendChild(b); sugg.appendChild(li); }
    sugg.hidden = false;
  });
  $('#askIn').addEventListener('keydown', e => {
    if (sugg.hidden || !['ArrowDown', 'ArrowUp', 'Escape'].includes(e.key)) return; e.preventDefault(); if (e.key === 'Escape') return hideSugg();
    const bs = $$('#sugg button'), i = bs.findIndex(b => b.classList.contains('act')), n = (i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length; bs.forEach(b => b.classList.remove('act')); bs[n].classList.add('act');
  });
  bubble('', (LS() ? 'The landslide model is ready: 300 trees trained on 1,398 slides the USGS mapped in winter 2016 to 2017, running in your browser. ' : REG.short + ' has no trained landslide model yet, so answers use the map\'s placeholder score from real terrain and rain. ' + (window.GT_FLOOD ? 'Ask about flooding for the San Francisco flood model. ' : '')) + 'Ask for the prediction across the area, ask about a street, compare streets, or name a rain amount such as ' + (REG.example || 'Miner Road with 100 mm rain') + '. Ask how the model was checked to see its validation.');

  /* ------------------------------------------------ guided tour: drives the real controls so a viewer sees every tool in about a minute */
  let tour = null;
  const tourUI = (on, txt) => { $('#tour').hidden = !on; document.body.classList.toggle('touring', on); if (txt) $('#tourTxt').textContent = txt; };
  function stopTour() { if (!tour) return; tour.dead = true; if (tour.tw) tour.tw.kill(); tour = null; stopPlay(); tourUI(false); }
  async function runTour() {
    if (tour) return; if (exploring) setExplore(false);
    const me = tour = { dead: false, tw: null }, k = reduce ? 0.35 : 1;
    const wait = ms => new Promise(r => setTimeout(r, ms * k)), alive = () => !me.dead;
    const show = async (id, ms) => { go(id); await wait(ms == null ? 1300 : ms); };
    const steps = [
      ['1 of 7. Radar sees slopes creep', async () => { await show('motion'); const sp = $('#split'), o = { v: 50 }; await new Promise(r => { me.tw = gsap.to(o, { v: 18, duration: 1.6 * k, yoyo: true, repeat: 1, ease: 'sine.inOut', onUpdate: () => { sp.value = o.v; sp.dispatchEvent(new Event('input')); }, onComplete: r, onInterrupt: r }); }); await wait(600); }],
      ['2 of 7. Set a storm and watch exposure rise', async () => { await show('storm'); $('[data-preset=peak]').click(); await wait(2600); setBias(-4.9); await wait(2400); setBias(-6.5); await wait(900); }],
      ['3 of 7. Winter 2023, replayed from real rain', async () => { await show('replay', 900); setReplay(D0, true); await playReplay(9 * k); await wait(500); }],
      ['4 of 7. Scored against the slides that were reported', async () => { await show('backtest'); await wait(3600); }],
      ['5 of 7. Open a slope: tipping point, history, debris path', async () => { await show('inspect'); $('#jumpFast').click(); await wait(3200); $('#runBtn').click(); await wait(4200); }],
      ['6 of 7. Ask about a street', async () => { await show('ask'); ask(REG.tourQ || 'Where would debris from Miner Road go, and how many buildings are near the path?'); await wait(6500); }],
      ['7 of 7. What is real and what comes next', async () => { await show('method'); await wait(3000); }]
    ];
    if (!REG.motion) { steps.shift(); steps.forEach((st, n) => st[0] = st[0].replace(/^\d of 7/, `${n + 1} of 6`)); }
    for (const [label, fn] of steps) { if (!alive()) return; tourUI(true, label); await fn(); }
    if (alive()) { tour = null; tourUI(false); go('top'); }
  }
  $('#tourBtn').addEventListener('click', runTour); $('#tourStop').addEventListener('click', stopTour);
  window.addEventListener('keydown', e => { if (tour && e.key === 'Escape') stopTour(); });

  /* ------------------------------------------------ first paint + entrances */
  setReal(true); setStorm(92, 156); setReplay(D0, true); enter(ORDER.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'top'); drawSeries(null);
  setTimeout(renderBacktest, 900);
  { const p = PRESETS.today(), sc = { r72: p.r72, api: p.api, era: 0, amt: 0 }, rk = Mo.rankStreets(sc, 1), ld = addDays(RNOW.start, lastNow);
    $('#nowLine').textContent = `Latest gauge reading, ${dstr(ld)}: ${fmt(p.r72)} mm in three days, soil wetness ${fmt(p.api)} mm, ${rk.elevated} streets at Elevated or High. ${(se => se.pct == null ? '' : `Season rain since October 1: ${fmt(se.total)} mm, ${fmt(se.pct)}% of the average for this date over ${se.years} other years. `)(seasonStats(HN - 1))}The map in this view shows a 140 mm storm on wet soil.`; }
  const redraw = () => { if (active === 'replay') drawRain(); if (active === 'backtest') drawTimeline(); if (sel) renderInspector(); };
  window.addEventListener('resize', () => { redraw(); refill(); updShift(true); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(redraw);

  /* segmented tracks: one thumb glides to the pressed tab */
  $$('.seg-track:not(.multi)').forEach(tr => {
    const th = document.createElement('i'); th.className = 'thumb'; th.setAttribute('aria-hidden', 'true'); tr.prepend(th);
    const place = () => { const b = tr.querySelector('button[aria-pressed="true"]'); if (!b || !b.offsetWidth) { th.style.width = '0'; return; } th.style.width = b.offsetWidth + 'px'; th.style.transform = `translateX(${b.offsetLeft}px)`; };
    new MutationObserver(place).observe(tr, { attributes: true, attributeFilter: ['aria-pressed'], subtree: true, childList: true, characterData: true });
    if (window.ResizeObserver) new ResizeObserver(place).observe(tr); place();
  });
  /* theme */
  function setTheme(t, save) {
    document.documentElement.dataset.theme = t; $$('[data-theme-set]').forEach(b => b.setAttribute('aria-pressed', b.dataset.themeSet === t));
    if (save) { try { localStorage.setItem('gt-theme', t); } catch (err) {} }
    requestAnimationFrame(redraw);
  }
  $$('[data-theme-set]').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.themeSet, true)));
  { let t = null; try { t = localStorage.getItem('gt-theme'); } catch (err) {} setTheme(t === 'light' || t === 'dark' ? t : 'dark'); }

  $('#loading').classList.add('off');
  function renderSimulation(v) {
    localSimulation = v;
    $('#simStatus').textContent = `${v.running ? 'Running' : 'Paused'}: ${v.simulation_date} · step ${v.step} · ${v.rain_72h_mm.toFixed(1)} mm rain / 72 h · wetness ${v.api_mm.toFixed(1)} mm`;
    $('#simScores').textContent = v.streets.map(s=>`${s.street}: ${s.score.toFixed(1)}/100`).join(' · ');
    $('#simToggle').textContent = v.running ? 'Pause simulation' : 'Resume simulation';
    $('#simToggle').disabled = false;
  }
  async function pollSimulation() {
    try {
      const res = await fetch('/api/simulation', {cache:'no-store'});
      if(!res.ok) throw new Error('Simulation unavailable');
      renderSimulation(await res.json());
    } catch (_) {
      localSimulation = null;
      $('#simStatus').textContent = 'Simulation is offline. Run START_LOCAL.cmd to start it. Browser-local Ask is still available.';
      $('#simScores').textContent = '';
      $('#simToggle').disabled = true;
    }
  }
  async function pollBackend() {
    try {
      const response=await fetch('/api/backend', {cache:'no-store'});
      if(!response.ok) throw new Error('Backend unavailable');
      backendState=await response.json();
      $('#backendStatus').textContent = backendState.persistence === 'supabase'
        ? `Python backend connected · Supabase history · ${backendState.pending_sync} queued writes${backendState.last_error ? ' · sync needs attention' : ''}`
        : `Python backend connected · local history · ${backendState.supabase_configured ? 'Supabase sync pending' : 'Supabase not connected'}`;
      const history=await fetch('/api/predictions?limit=3', {cache:'no-store'});
      if(history.ok) {
        const runs=await history.json();
        $('#predictionHistory').textContent = runs.length ? 'Recent predictions: '+runs.map(v=>`${v.run.source}, ${v.predictions[0]?.street || 'street'}: ${v.predictions[0]?.score.toFixed(1)}/100`).join(' · ') : 'No predictions saved yet.';
      }
    } catch (_) { backendState=null; $('#backendStatus').textContent='Backend offline · browser-local inference available'; }
  }
  $('#simToggle').addEventListener('click', async () => {
    if(!localSimulation) return;
    $('#simToggle').disabled = true;
    try {
      const action=localSimulation.running ? 'pause':'resume';
      const res=await fetch('/api/simulation/'+action, {method:'POST'});
      if(!res.ok) throw new Error('Simulation control failed');
      renderSimulation(await res.json());
    } catch (_) { await pollSimulation(); }
  });
  pollSimulation(); setInterval(pollSimulation, 2000);
  pollBackend(); setInterval(pollBackend, 5000);
  if (!reduce) {
    gsap.from(Sc.cam, { py: '+=4', pz: '+=6', duration: 2.2, ease: 'power3.out' });
    gsap.from('.rail, .topbar, .head, .stage, .view', { y: 6, autoAlpha: 0, duration: 0.28, ease: 'power3.out', stagger: 0.04, clearProps: 'all' });
  }
})();
