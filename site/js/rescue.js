/* escape "help on the way": fire engines leave the nearest stations and drive real street routes to an address on the 3D map.
   Stations: fire_stations.js in site/data and site/data_sf (scripts/14_build_fire_stations.cjs: Overture Maps places plus published station addresses).
   Drive time: the San Francisco drive-time model (scripts/sf/09_storm_response_sf.py), fitted on real engine trips in DataSF dispatch records
   and checked on October 2026. It maps the street-grid distance from a station to minutes. Past the distances it was fitted on, the curve is
   extended in a straight line and the answer says so. Lamorinda has no 911 records, so there the same curve is a labelled estimate.
   Routes: shortest path on the Getting out street network (GTEvac). The route only draws the way; the minutes come from the model.
   The top half is plain arithmetic with no page access, so tests/rescue_test.cjs can run it in node. */
(function (root) {
  'use strict';
  const API = root.GTRescue = {};
  const MX = 88000, MY = 111000;                                   // metres per degree here, the same numbers the model was fitted with
  /* drive minutes for a street-grid distance in metres: the model's 250 m bands (nearest band, as in the Python), a straight line past them */
  function curve(meta) {
    const ks = Object.keys(meta.curve).map(Number).sort((a, b) => a - b), fitK = ks.filter(k => k <= 2750), last = fitK[fitK.length - 1];
    let sx = 0, sy = 0, sxx = 0, sxy = 0; for (const k of fitK) { const y = meta.curve[k]; sx += k; sy += y; sxx += k * k; sxy += k * y; }
    const n = fitK.length, slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const f = d => { if (d <= last + 125) { const b = Math.floor(d / 250) * 250; let best = fitK[0]; for (const k of fitK) if (Math.abs(k - b) < Math.abs(best - b)) best = k; return { min: meta.curve[best], extrapolated: false }; }
      return { min: meta.curve[last] + slope * (d - last), extrapolated: true }; };
    f.slopePerKm = slope * 1000; f.fitTo = last; return f;
  }
  const gridM = (a, b) => Math.abs(a[0] - b[0]) * MX + Math.abs(a[1] - b[1]) * MY;
  /* the k stations with the shortest modelled drive to a point */
  function nearest(F, lonlat, k) {
    const cv = curve(F.meta);
    return F.stations.map(s => { const d = gridM([s.lon, s.lat], lonlat), t = cv(d); return { ...s, gridM: d, drive: t.min, extrapolated: t.extrapolated }; })
      .sort((a, b) => a.drive - b.drive || a.gridM - b.gridM).slice(0, k || 3);
  }
  API.curve = curve; API.nearest = nearest; API.gridM = gridM;

  /* shortest street path from one node to every node (Dijkstra, edge length as cost) */
  function tree(g, src) {
    const nn = g.nn, dist = new Float64Array(nn).fill(Infinity), via = new Int32Array(nn).fill(-1), H = [], push = (n, d) => { H.push([d, n]); let i = H.length - 1; while (i) { const p = (i - 1) >> 1; if (H[p][0] <= H[i][0]) break; [H[p], H[i]] = [H[i], H[p]]; i = p; } };
    const pop = () => { const top = H[0], e = H.pop(); if (H.length) { H[0] = e; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < H.length && H[l][0] < H[m][0]) m = l; if (r < H.length && H[r][0] < H[m][0]) m = r; if (m === i) break; [H[m], H[i]] = [H[i], H[m]]; i = m; } } return top; };
    dist[src] = 0; push(src, 0);
    while (H.length) { const [d, n] = pop(); if (d > dist[n]) continue;
      for (let j = g.adjOff[n]; j < g.adjOff[n + 1]; j++) { const e = g.adjE[j], m = g.eu[e] === n ? g.ev[e] : g.eu[e], nd = d + g.elen[e]; if (nd < dist[m]) { dist[m] = nd; via[m] = e; push(m, nd); } } }
    return { dist, via };
  }
  /* street route from a node back to the tree's source, as [lon, lat] points */
  function route(g, T, from) {
    const pts = []; let n = from, guard = 0; if (!isFinite(T.dist[from])) return null;
    pts.push(g.lonlat(n));
    while (T.via[n] >= 0 && guard++ < 20000) { const e = T.via[n], o = g.eu[e] === n ? g.ev[e] : g.eu[e], p0 = g.lonlat(n); let q = g.geom(e);
      if (Math.hypot(q[0][0] - p0[0], q[0][1] - p0[1]) > Math.hypot(q[q.length - 1][0] - p0[0], q[q.length - 1][1] - p0[1])) q = q.slice().reverse();
      for (const p of q) pts.push(p); n = o; }
    return { pts, metres: T.dist[from] };
  }
  API.tree = tree; API.route = route;
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------ page */
  const reduce = () => root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);
  const clockTxt = m => { const s = Math.max(0, Math.round(m * 60)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  let play = null, raf = 0;
  /* plan for an address: the nearest 3 stations, their modelled drive and a street route each */
  API.plan = function (lon, lat) {
    const F = root.GT_FIRE, E = root.GTEvac; if (!F || !F.stations.length) return null;
    const near = nearest(F, [lon, lat], 3); let g = null, T = null, goal = -1;
    if (E && E.ensure && E.ensure()) { g = E.graph(); goal = E.nodeAt(lon, lat); if (goal >= 0) T = tree(g, goal); }
    for (const s of near) {
      let r = null; if (T) { const n = E.nodeAt(s.lon, s.lat); if (n >= 0) r = route(g, T, n); }
      s.pts = r ? [[s.lon, s.lat]].concat(r.pts, [[lon, lat]]) : [[s.lon, s.lat], [lon, lat]]; s.routeM = r ? r.metres : null; s.routed = !!r;
    }
    return { stations: near, turnout: F.meta.turnout_min, meta: F.meta, at: [lon, lat] };
  };
  /* the small "help on the way" block: one row per engine, with a bar that fills as it drives, and the clock in model minutes */
  API.block = function (p) {
    const E2 = root.GTCards.el, w = E2('div', 'hw'); w.appendChild(E2('p', 'mc-sh', 'Help on the way'));
    const clk = E2('span', 'hw-clk num', '0:00'); w.firstChild.appendChild(clk);
    const ol = E2('ol', 'hw-list'), max = Math.max(...p.stations.map(s => s.drive)) + p.turnout;
    p.stations.forEach((s, i) => { const li = E2('li'); li.dataset.i = i; li.innerHTML = '<span class="dot"></span>';
      const n = E2('span', 'n'); n.appendChild(E2('b', '', s.name)); n.appendChild(E2('small', '', s.agency)); li.appendChild(n);
      const bar = E2('span', 'bar'); bar.appendChild(E2('i')); li.appendChild(bar); li.appendChild(E2('span', 'v num', fmt1(p.turnout + s.drive) + ' min')); ol.appendChild(li); });
    w.appendChild(ol);
    const b = E2('button', 'btn sm', 'Watch it again'); b.type = 'button'; b.addEventListener('click', () => API.play(p, w)); w.appendChild(b);
    w._max = max; return w;
  };
  /* drive the engines on the map and keep the block in step. 1 model minute plays as about 1.2 seconds, so the slowest run lasts at most 12 s. */
  API.play = function (p, w) {
    const Sc = root.GTScene; if (!Sc || !Sc.showFleet) return;
    const max = Math.max(...p.stations.map(s => s.drive)) + p.turnout, k = Math.min(1.2, 12 / max);
    const order = p.stations.map((s, i) => [s.drive, i]).sort((a, b) => a[0] - b[0]);
    const list = p.stations.map((s, i) => { const lb = document.createElement('div'); lb.className = 'pin-label veh-lb' + (i === order[0][1] ? ' first' : ''); lb.textContent = s.name; document.getElementById('labels').appendChild(lb);
      return { pts: s.pts, t0: p.turnout * k, t1: (p.turnout + s.drive) * k, label: lb, first: i === order[0][1] }; });
    document.querySelectorAll('#labels .veh-lb').forEach(e => { if (!list.some(x => x.label === e)) e.remove(); });
    play = Sc.showFleet(list); cancelAnimationFrame(raf); if (!play || !w) return;
    const rows = w.querySelectorAll('.hw-list li'), clk = w.querySelector('.hw-clk');
    const tick = () => { if (!play || !w.isConnected) return; const t = play.time() / k; clk.textContent = clockTxt(Math.min(t, max));
      p.stations.forEach((s, i) => { const f = Math.max(0, Math.min(1, t / (p.turnout + s.drive))), li = rows[i]; li.querySelector('.bar i').style.width = (f * 100).toFixed(1) + '%';
        const done = f >= 1; if (done !== li.classList.contains('in')) { li.classList.toggle('in', done); li.querySelector('.dot').innerHTML = done ? root.GTCards.icon('check') : ''; if (done) list[i].label.textContent = s.name + ' · on scene'; } });
      if (t < max + 0.2) raf = requestAnimationFrame(tick); };
    tick();
  };
  API.stop = () => { cancelAnimationFrame(raf); if (root.GTScene && root.GTScene.clearFleet) root.GTScene.clearFleet(); play = null; document.querySelectorAll('#labels .veh-lb').forEach(e => e.remove()); };
  API.reduced = reduce;
})(typeof window === 'undefined' ? globalThis : window);
