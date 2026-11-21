/* escape "Request a ride": a DEMO of how a neighbor ride could be booked, like a rideshare app.
   Every driver here is SIMULATED: made-up names and cars, placed on real buildings near the pickup. Nothing is sent anywhere,
   nobody is contacted, and nothing typed in the form leaves this page. The route is a real shortest path on the Getting out
   street network (GTEvac + GTRescue.tree/route); the ETA assumes about 25 km/h on neighborhood streets plus a minute to set off. */
(function (root) {
  'use strict';
  if (typeof document === 'undefined') return;
  const $ = s => document.querySelector(s), sec = $('#rides'), host = $('#rqBox');
  if (!sec || !host) return;
  const Sc = root.GTScene, Mo = root.GTModel, SF = !!(root.GT_REGION && root.GT_REGION.id === 'sf');

  /* ---- simulated volunteer drivers: fixed lists, so the demo looks the same every time */
  const FIRST = ['Maya', 'Daniel', 'Priya', 'Tom', 'Lena', 'Marcus', 'Grace', 'Omar', 'Sofia', 'Ben', 'Aiko', 'Luis', 'Hannah', 'Jamal', 'Elena', 'Chris'];
  const LASTI = ['R.', 'K.', 'S.', 'M.', 'T.', 'L.', 'W.', 'P.', 'H.', 'G.', 'N.', 'D.'];
  const CARS = [
    { car: 'Toyota Sienna', color: 'Silver', seats: 6, wheelchair: true, pets: true },
    { car: 'Honda Odyssey', color: 'Blue', seats: 6, wheelchair: false, pets: true },
    { car: 'Subaru Outback', color: 'Green', seats: 4, wheelchair: false, pets: true },
    { car: 'Toyota Prius', color: 'White', seats: 4, wheelchair: false, pets: false },
    { car: 'Ford Transit van (ramp)', color: 'White', seats: 7, wheelchair: true, pets: true },
    { car: 'Tesla Model Y', color: 'Gray', seats: 4, wheelchair: false, pets: true },
    { car: 'Chrysler Pacifica', color: 'Black', seats: 6, wheelchair: true, pets: false },
    { car: 'Honda CR-V', color: 'Red', seats: 4, wheelchair: false, pets: true },
  ];
  let seed = 1;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const plate = () => { const L = 'ABCDEFGHJKLMNPRSTUVWXYZ'; return (1 + Math.floor(rnd() * 9)) + L[Math.floor(rnd() * L.length)] + L[Math.floor(rnd() * L.length)] + L[Math.floor(rnd() * L.length)] + String(Math.floor(rnd() * 900) + 100); };
  const MX = 88000, MY = 111000, KMH = 25;
  const fmt1 = v => (Math.round(v * 10) / 10).toFixed(1);

  /* ---- pickup: the address the person checked on the Overview, else the middle of the map */
  function pickup() {
    const A = root.GTAddress, h = A && A.last ? A.last() : null;
    if (h && isFinite(h.lon) && isFinite(h.lat)) return { label: h.label, lon: h.lon, lat: h.lat, fromAddr: true };
    const b = Mo.bbox; return { label: SF ? 'Near Twin Peaks, San Francisco' : 'Lafayette town centre', lon: SF ? -122.4475 : -122.1180, lat: SF ? 37.7544 : 37.8858, fromAddr: false, bbox: b };
  }

  /* ---- nearby drivers: real residential buildings 400 m to 2.5 km from the pickup, with a simulated volunteer in each */
  function nearbyDrivers(p, need) {
    const R = root.GTRides, st = R && R.state ? R.state() : null, D = st && st.D;
    const E = root.GTEvac, ok = E && E.ensure && E.ensure(); if (!ok) return { list: [], why: 'roads' };
    const g = E.graph(), goal = E.nodeAt(p.lon, p.lat); if (goal < 0) return { list: [], why: 'pickup' };
    const T = root.GTRescue.tree(g, goal), cand = [];
    seed = (Math.round(p.lon * 1e5) ^ Math.round(p.lat * 1e5)) >>> 0 || 7;
    const tryAt = (lon, lat) => { const d = Math.hypot((lon - p.lon) * MX, (lat - p.lat) * MY); if (d < 900 || d > 3000) return; const n = E.nodeAt(lon, lat); if (n < 0 || !isFinite(T.dist[n]) || T.dist[n] > 5500) return; cand.push({ lon, lat, n, m: T.dist[n] }); };
    if (D) { for (let k = 0; k < 4000 && cand.length < 60; k++) { const b = Math.floor(rnd() * D.n); tryAt(D.lon[b], D.lat[b]); } }
    for (let k = 0; k < 400 && cand.length < 12; k++) { const a = rnd() * 6.283, r = 500 + rnd() * 1800; tryAt(p.lon + Math.cos(a) * r / MX, p.lat + Math.sin(a) * r / MY); }
    const seen = new Set(), list = [];
    cand.sort((a, b) => a.m - b.m);
    for (const c of cand) { const key = Math.round(c.m / 120); if (seen.has(key)) continue; seen.add(key);
      const v = CARS[Math.floor(rnd() * CARS.length)];
      list.push({ ...c, name: FIRST[Math.floor(rnd() * FIRST.length)] + ' ' + LASTI[Math.floor(rnd() * LASTI.length)], ...v, plate: plate(), trips: 3 + Math.floor(rnd() * 40), eta: 1 + c.m / 1000 / KMH * 60 });
      if (list.length >= 8) break; }
    const fits = list.filter(d => d.seats >= need.riders && (!need.wheelchair || d.wheelchair) && (!need.pet || d.pets));
    if (need.wheelchair && !fits.length) { const v = list[0]; if (v) Object.assign(v, CARS[4], { wheelchair: true }), fits.push(v); }   // always keep one ramp van in the pool
    return { list, fits, g, T };
  }

  /* ---- UI */
  const ic = n => root.GTCards ? root.GTCards.icon(n) : '';
  let state = null, raf = 0;
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function form() {
    stopMap(); const p = pickup(); host.textContent = '';
    const f = el('form', 'rq-form'); f.noValidate = true;
    f.innerHTML = `
      <label class="rq-f"><span>Your name</span><input class="field" id="rqName" autocomplete="off" placeholder="First name" maxlength="40"></label>
      <label class="rq-f"><span>Pickup</span><input class="field" id="rqPick" autocomplete="off" maxlength="120"></label>
      <div class="rq-row">
        <label class="rq-f"><span>Riders</span><select class="pick" id="rqRiders">${[1, 2, 3, 4, 5, 6].map(n => `<option value="${n}">${n}</option>`).join('')}</select></label>
        <fieldset class="rq-needs"><legend>Needs</legend>
          <label><input type="checkbox" id="rqWheel"> Wheelchair</label>
          <label><input type="checkbox" id="rqPet"> Pet</label>
          <label><input type="checkbox" id="rqHelp"> Help with bags</label>
        </fieldset>
      </div>
      <button class="btn accent" type="submit" id="rqGo">Find a driver</button>`;
    host.appendChild(f);
    $('#rqPick').value = p.label;
    if (!p.fromAddr) host.appendChild(el('p', 'note', 'Tip: check your address on the Overview first and the pickup fills in for you.'));
    f.addEventListener('submit', e => { e.preventDefault(); find(); });
  }
  function find() {
    const p = pickup(), need = { name: ($('#rqName').value || '').trim() || 'You', riders: +$('#rqRiders').value, wheelchair: $('#rqWheel').checked, pet: $('#rqPet').checked, bags: $('#rqHelp').checked };
    const typed = ($('#rqPick').value || '').trim(); p.shown = typed || p.label;
    host.textContent = '';
    const s = el('div', 'rq-search'); s.appendChild(el('span', 'rq-spin')); const t = el('p', 'body', 'Looking for volunteer drivers near ' + p.shown + '...'); s.appendChild(t); host.appendChild(s);
    flyTo(p.lon, p.lat, 4.2);
    setTimeout(() => {
      let r; try { r = nearbyDrivers(p, need); } catch (e) { console.error(e); r = { list: [], why: 'error' }; }
      if (!r.list.length || !r.fits || !r.fits.length) { host.textContent = ''; host.appendChild(el('p', 'body', r.why === 'roads' ? 'The street network did not load, so no driver can be routed. Reload the page and try again.' : 'No simulated driver could reach this pickup by road. Try another address.')); back(); return; }
      t.textContent = `${r.list.length} simulated volunteer drivers nearby. Matching...`;
      state = { p, need, r, d: r.fits[0] };
      drawNearby(r.list, p);
      setTimeout(matched, 1100);
    }, 900);
  }
  function card(d, need) {
    const c = el('div', 'rq-drv');
    const av = el('span', 'rq-av', d.name[0]); c.appendChild(av);
    const who = el('div', 'rq-who'); who.appendChild(el('b', '', d.name)); who.appendChild(el('small', '', `${d.color} ${d.car} · ${d.plate}`));
    who.appendChild(el('small', '', `Volunteer · ${d.trips} neighbor rides · ${d.seats} seats`)); c.appendChild(who);
    const eta = el('div', 'rq-eta'); eta.appendChild(el('b', 'num', Math.round(d.eta) + ' min')); eta.appendChild(el('small', '', fmt1(d.m / 1000) + ' km away')); c.appendChild(eta);
    const tags = el('ul', 'rq-tags'); const tag = x => { const li = el('li'); li.innerHTML = ic('check'); li.appendChild(el('span', '', x)); tags.appendChild(li); };
    tag(`Room for ${need.riders} ${need.riders === 1 ? 'rider' : 'riders'}`); if (need.wheelchair) tag('Wheelchair ramp'); if (need.pet) tag('Pets welcome'); if (need.bags) tag('Will help with bags');
    const w = el('div'); w.append(c, tags); return w;
  }
  function matched() {
    const { p, need, d } = state; host.textContent = '';
    const h = el('p', 'rq-h'); h.innerHTML = ic('check'); h.appendChild(el('span', '', `Driver found for ${need.name}`)); host.appendChild(h);
    host.appendChild(card(d, need));
    host.appendChild(el('p', 'note', `Pickup: ${p.shown}. ${d.name.split(' ')[0]} drives the real street route shown on the map.`));
    const row = el('div', 'rq-row');
    const ok = el('button', 'btn accent', 'Confirm ride'); ok.type = 'button'; ok.addEventListener('click', ride);
    const no = el('button', 'btn ghost', 'Cancel'); no.type = 'button'; no.addEventListener('click', form);
    row.append(ok, no); host.appendChild(row);
    showRoute(false);
  }
  function ride() {
    const { p, need, d } = state; host.textContent = '';
    const h = el('p', 'rq-h'); h.innerHTML = ic('check'); h.appendChild(el('span', '', 'Ride confirmed')); host.appendChild(h);
    host.appendChild(card(d, need));
    const bar = el('div', 'rq-bar'); bar.appendChild(el('i')); host.appendChild(bar);
    const live = el('p', 'body rq-live', `${d.name.split(' ')[0]} is on the way · ${Math.round(d.eta)} min`); live.setAttribute('role', 'status'); host.appendChild(live);
    const no = el('button', 'btn ghost sm', 'Cancel ride'); no.type = 'button'; no.addEventListener('click', form); host.appendChild(no);
    showRoute(true, f => {
      bar.firstChild.style.width = (f * 100).toFixed(1) + '%';
      const left = Math.max(0, Math.ceil(d.eta * (1 - f)));
      if (f < 1) live.textContent = `${d.name.split(' ')[0]} is on the way · ${left} min`;
      else arrived();
    });
  }
  function arrived() {
    const { p, need, d } = state; host.textContent = '';
    const h = el('p', 'rq-h done'); h.innerHTML = ic('check'); h.appendChild(el('span', '', `${d.name.split(' ')[0]} has arrived`)); host.appendChild(h);
    host.appendChild(card(d, need));
    host.appendChild(el('p', 'body', `Look for a ${d.color.toLowerCase()} ${d.car}, plate ${d.plate}, at ${p.shown}. In a real storm, follow your city's evacuation orders and call 911 in danger.`));
    back('Request another ride');
  }
  function back(txt) { const b = el('button', 'btn sm', txt || 'Start over'); b.type = 'button'; b.addEventListener('click', form); host.appendChild(b); }
  function flyTo(lon, lat, dist) {
    if (!Sc || !Sc.focusPose || !root.gsap) return; const pz = Sc.focusPose(lon, lat, dist * 0.5, 0);
    root.gsap.to(Sc.cam, { ...pz, duration: 1.4, ease: 'power3.inOut', overwrite: 'auto' });
  }

  /* ---- map: a flat canvas over the 3D map, like the Neighbor rides dots. Nearby drivers as small car marks, the matched route, the car moving along it. */
  const cv = document.createElement('canvas'); cv.id = 'rqMap'; cv.setAttribute('aria-hidden', 'true');
  let mk = null;
  function drawNearby(list, p) { mk = { p, cars: list.map(d => [d.lon, d.lat]), route: null, prog: 0, t0: 0, dur: 0, on: null }; loop(); }
  function showRoute(go, onTick) {
    const { p, d, r } = state, R = root.GTRescue.route(r.g, r.T, d.n);
    const pts = (R ? [[d.lon, d.lat]].concat(R.pts, [[p.lon, p.lat]]) : [[d.lon, d.lat], [p.lon, p.lat]]);
    const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot((pts[i][0] - pts[i - 1][0]) * MX, (pts[i][1] - pts[i - 1][1]) * MY));
    mk = mk || { p, cars: [] }; mk.cars = go ? [] : mk.cars; mk.route = { pts, L }; mk.prog = 0; mk.on = onTick || null;
    const reduced = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    mk.dur = go ? (reduced ? 1 : Math.min(14000, Math.max(7000, d.eta * 1200))) : 0; mk.t0 = performance.now();
    const lon = (d.lon + p.lon) / 2, lat = (d.lat + p.lat) / 2, km = Math.hypot((d.lon - p.lon) * MX, (d.lat - p.lat) * MY) / 1000;
    flyTo(lon, lat, Math.max(4, km * 4.2));
    loop();
  }
  function stopMap() { mk = null; cancelAnimationFrame(raf); raf = 0; cv.remove(); }
  const css = n => getComputedStyle(sec).getPropertyValue(n).trim();
  function at(R, dist) { let i = 1; while (i < R.L.length - 1 && R.L[i] < dist) i++; const a = R.pts[i - 1], b = R.pts[i], s = R.L[i] - R.L[i - 1], k = s > 0 ? Math.max(0, Math.min(1, (dist - R.L[i - 1]) / s)) : 1; return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], i, a, b }; }
  function carMark(x, pos, ang, fill, stroke, big) {
    const w = big ? 9 : 6, l = big ? 16 : 11; x.save(); x.translate(pos[0], pos[1]); x.rotate(ang);
    x.fillStyle = fill; x.strokeStyle = stroke; x.lineWidth = 1.5; x.beginPath(); if (x.roundRect) x.roundRect(-l / 2, -w / 2, l, w, 2.5); else x.rect(-l / 2, -w / 2, l, w); x.fill(); x.stroke();
    x.fillStyle = stroke; x.fillRect(l / 2 - (big ? 5 : 3.5), -w / 2 + 1.5, big ? 2.5 : 1.8, w - 3); x.restore();
  }
  function loop() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0; if (!mk || !sec.classList.contains('on')) { cv.remove(); return; }
    raf = requestAnimationFrame(frame);
    const gl = $('#gl'); if (!gl || !Sc || !Sc.project) return; if (!cv.parentNode) gl.parentNode.insertBefore(cv, $('#labels'));
    const w = gl.clientWidth, h = gl.clientHeight, dpr = Math.min(2, root.devicePixelRatio || 1); if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
    const P = q => Sc.project(q[0], q[1], 0.05), acc = css('--accent') || '#f5a524', ink = css('--text-1') || '#fff', bg = css('--surface-1') || '#111';
    for (const c of mk.cars) { const q = P(c); if (q) carMark(x, q, 0, bg, ink, false); }
    const R = mk.route; let prog = 0, car = null;
    if (R) {
      prog = mk.dur ? Math.min(1, (performance.now() - mk.t0) / mk.dur) : 0;
      const pts = R.pts.map(P), here = at(R, prog * R.L[R.L.length - 1]);
      x.lineCap = x.lineJoin = 'round';
      x.strokeStyle = acc; x.globalAlpha = 0.4; x.lineWidth = 7; x.beginPath(); let st = false; for (const q of pts) { if (!q) { st = false; continue; } st ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1]); st = true; } x.stroke(); x.globalAlpha = 1;
      x.strokeStyle = acc; x.lineWidth = 3.5; x.beginPath(); st = false; const hp = P(here.p);
      for (let i = here.i; i < pts.length; i++) { const q = i === here.i && hp ? hp : pts[i]; if (!q) { st = false; continue; } st ? x.lineTo(q[0], q[1]) : x.moveTo(q[0], q[1]); st = true; } x.stroke();
      const a = P(here.a), b = P(here.b); car = hp ? [hp, a && b ? Math.atan2(b[1] - a[1], b[0] - a[0]) : 0] : null;
    }
    const pp = P([mk.p.lon, mk.p.lat]);
    if (pp) { x.fillStyle = ink; x.strokeStyle = bg; x.lineWidth = 3; x.beginPath(); x.arc(pp[0], pp[1], 7, 0, 6.283); x.fill(); x.stroke(); x.fillStyle = bg; x.beginPath(); x.arc(pp[0], pp[1], 2.5, 0, 6.283); x.fill();
      x.font = '600 12px ' + (css('--f-ui') || 'sans-serif'); x.fillStyle = ink; x.strokeStyle = bg; x.lineWidth = 3; x.strokeText('Pickup', pp[0] + 11, pp[1] + 4); x.fillText('Pickup', pp[0] + 11, pp[1] + 4); }
    if (car) carMark(x, car[0], car[1], acc, bg, true);
    if (mk.on && mk.dur) { const f = prog; const cb = mk.on; if (f >= 1) mk.on = null; cb(f); }
  }

  form();
  new MutationObserver(() => { if (sec.classList.contains('on')) { if (mk) loop(); else if (!state || !host.querySelector('.rq-drv')) form(); } }).observe(sec, { attributes: true, attributeFilter: ['class'] });
  root.GTRideRequest = { form, state: () => state, map: () => mk };
})(typeof window === 'undefined' ? globalThis : window);
