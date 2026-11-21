/* escape "Storm response": how fast fire and EMS units reached San Francisco calls during the November 18, 2026 storm, hour by hour,
   next to gauge rain and 311 flood reports, and against dry days matched on weekday, local hour and call type.
   Every number comes from real public records packed by scripts/sf/09_storm_response_sf.py into site/data_sf/storm_response.js (window.GT_STORM).
   The top half is plain arithmetic with no page access, so tests/stormresp_test.cjs can run it in node. The page wiring starts at "page". */
(function () {
  /* Nearest-rank quantile, the same rule as the Python script: the smallest value whose cumulative weight reaches q of the total. */
  function wq(xs, ws, q) {
    const n = xs.length; if (!n) return NaN;
    const o = Array.from(xs.keys()).sort((a, b) => xs[a] - xs[b] || a - b);
    let tot = 0; for (let i = 0; i < n; i++) tot += ws ? ws[i] : 1;
    let c = 0; const goal = q * tot - 1e-9 * tot;
    for (const i of o) { c += ws ? ws[i] : 1; if (c >= goal) return xs[i]; }
    return xs[o[n - 1]];
  }
  /* Calls received in [end - span, end) minutes, for one neighborhood (k >= 0) or the whole city (k < 0). */
  function windowStats(D, end, span, k) {
    const I = D.inc, F = D.flood, times = []; let calls = 0, noScene = 0, floods = 0;
    for (let i = 0; i < I.t.length; i++) {
      const t = I.t[i]; if (t < end - span || t >= end) continue; if (k >= 0 && I.nb[i] !== k) continue;
      calls++; if (I.s[i] === 0) times.push(I.r[i]); else if (I.s[i] === 1) noScene++;
    }
    for (let i = 0; i < F.t.length; i++) { const t = F.t[i]; if (t >= end - span && t < end && (k < 0 || F.nb[i] === k)) floods++; }
    return { calls, timed: times.length, noScene, floods, med: wq(times, null, 0.5), p90: wq(times, null, 0.9) };
  }
  /* Hour by hour across the timeline: calls, flood reports, median response of calls received that hour. */
  function hourly(D, k) {
    const H = D.meta.hours, calls = new Array(H).fill(0), floods = new Array(H).fill(0), med = [], byH = Array.from({ length: H }, () => []);
    for (let i = 0; i < D.inc.t.length; i++) { const h = Math.floor(D.inc.t[i] / 60); if (h < 0 || h >= H || (k >= 0 && D.inc.nb[i] !== k)) continue; calls[h]++; if (D.inc.s[i] === 0) byH[h].push(D.inc.r[i]); }
    for (let i = 0; i < D.flood.t.length; i++) { const h = Math.floor(D.flood.t[i] / 60); if (h >= 0 && h < H && (k < 0 || D.flood.nb[i] === k)) floods[h]++; }
    for (let h = 0; h < H; h++) med.push(wq(byH[h], null, 0.5));
    return { calls, floods, med };
  }
  function inRing(x, y, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const a = r[i], b = r[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1] + 1e-15) + a[0]) c = !c; } return c; }
  function nbAt(D, lon, lat) { for (let k = 0; k < D.nb.length; k++) for (const r of D.nb[k].rings) if (inRing(lon, lat, r)) return k; return -1; }
  /* Clock label for a minute offset from the start of the timeline (local time, no zone math needed: the timeline has no clock change). */
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function clock(D, m) {
    const s = D.meta.start, d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), 0, m));
    const h = d.getUTCHours(), hh = h % 12 || 12, ap = h < 12 ? 'a.m.' : 'p.m.', mm = d.getUTCMinutes();
    return { day: `${WD[d.getUTCDay()]} ${MO[d.getUTCMonth()]} ${d.getUTCDate()}`, time: mm ? `${hh}:${String(mm).padStart(2, '0')} ${ap}` : h === 0 ? 'midnight' : h === 12 ? 'noon' : `${hh} ${ap}`, h24: `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
  }

  const api = { wq, windowStats, hourly, nbAt, inRing, clock };
  if (typeof window !== 'undefined') window.GTStormResp = api;
  if (typeof document === 'undefined') return;

  /* ------------------------------------------------ page */
  api.register = a => {
    if (!window.GT_STORM || !window.GT_REGION || window.GT_REGION.id !== 'sf') return;
    a.POSES.response = { px: -0.6, py: 12.6, pz: 9.6, tx: 0.2, ty: 0, tz: 0 };
    a.LOOKS.response = { risk: 0, motion: 0, roads: 0.7, splitVis: 0, dim: 0.18, bld: 0.25 };
    a.ORDER.splice(Math.max(0, a.ORDER.indexOf('method')), 0, 'response');
    a.NAMES.response = 'Storm response'; a.SUBS.response = 'Fire and EMS arrival times in the November 18, 2026 storm · real dispatch records'; a.SPLIT.response = 1;
    start();
  };

  function start() {
    const D = window.GT_STORM, $ = s => document.querySelector(s), sec = $('#response'), Sc = window.GTScene; if (!sec || !D) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const C = D.cmp, H = D.meta.hours, [S0, S1] = D.meta.storm_min;
    const f1 = v => (v == null || Number.isNaN(v)) ? 'n/a' : Number(v).toFixed(1), fi = v => Number(v).toLocaleString('en-US');
    const sgn = v => { if (v == null || Number.isNaN(v)) return 'n/a'; const r = Math.round(v * 10) / 10; return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r).toFixed(1); };
    const css = n => getComputedStyle(sec).getPropertyValue(n).trim();
    const name = k => k < 0 ? 'All of San Francisco' : D.nb[k].name;
    const cmpOf = k => k < 0 ? C.city : C.nb[k];
    const WET = D.rain.reduce((b, v, i) => (v || 0) > (D.rain[b] || 0) ? i : b, 0);   // the wettest hour at the gauge
    let hour = WET, span = 360, sel = -1, timer = 0, curve = null;

    /* ---- the scrubber */
    const rng = $('#srHour'); rng.max = H - 1; rng.value = hour;
    const fill = el => { const f = (el.value - el.min) / (el.max - el.min); el.style.setProperty('--fill', (f * 100) + '%'); el.style.setProperty('--tw', Math.round(8 + f * Math.max(0, el.clientWidth - 16)) + 'px'); };
    rng.addEventListener('input', () => { stop(); setHour(+rng.value); });
    $('#srPlay').addEventListener('click', () => timer ? stop() : play());
    function play() { if (hour >= H - 1) setHour(0); $('#srPlay').textContent = 'Pause'; $('#srPlay').setAttribute('aria-pressed', 'true'); timer = setInterval(() => { if (hour >= H - 1) return stop(); setHour(hour + 1); }, reduce ? 1200 : 450); }
    function stop() { clearInterval(timer); timer = 0; $('#srPlay').textContent = 'Play the storm'; $('#srPlay').setAttribute('aria-pressed', 'false'); }
    sec.querySelectorAll('[data-span]').forEach(b => b.addEventListener('click', () => { span = +b.dataset.span; sec.querySelectorAll('[data-span]').forEach(x => x.setAttribute('aria-pressed', x === b)); paint(); }));
    $('#srJump').addEventListener('click', () => { stop(); setHour(WET); });
    function setHour(h) { hour = Math.max(0, Math.min(H - 1, h)); rng.value = hour; fill(rng); paint(); }

    /* ---- neighborhood picker */
    const pick = $('#srPick');
    D.nb.map((n, k) => [n.name, k]).sort((a, b) => a[0] < b[0] ? -1 : 1).forEach(([n, k]) => { const o = document.createElement('option'); o.value = k; o.textContent = n; pick.appendChild(o); });
    pick.addEventListener('change', () => choose(+pick.value));
    function choose(k) { sel = k; pick.value = k; curve = hourly(D, k); paint(); table(); compare(); if (k >= 0 && Sc && Sc.highlight) Sc.highlight(D.nb[k].c[0], D.nb[k].c[1], false); }

    /* ---- the hour readout, the stats for the selected place, the chart */
    function paint() {
      const end = (hour + 1) * 60, a = clock(D, end - span), b = clock(D, end), st = windowStats(D, end, span, sel);
      $('#srDay').textContent = b.day; $('#srTime').textContent = b.time;
      $('#srSpan').textContent = `Calls received ${a.day === b.day ? a.time : a.day + ', ' + a.time} to ${b.time}` + (end > S0 && end - span < S1 ? ' · inside the storm window' : ' · outside the storm window');
      const rain = D.rain[hour]; $('#srRain').textContent = rain == null ? 'no reading' : `${f1(rain)} mm`;
      $('#srWhere').textContent = name(sel);
      $('#srCalls').textContent = fi(st.calls); $('#srMed').textContent = st.timed ? f1(st.med) : 'n/a'; $('#srP90').textContent = st.timed ? f1(st.p90) : 'n/a'; $('#srFlood').textContent = fi(st.floods);
      $('#srStatNote').textContent = `${fi(st.timed)} of ${fi(st.calls)} calls have a valid time from receipt to the first unit on scene` + (st.noScene ? `; ${fi(st.noScene)} had no unit recorded on scene` : '') + '. Each incident counts once, however many units went.'
        + (st.timed && st.timed < 10 ? ' Fewer than 10 timed calls in this window: read the median and 90th percentile loosely.' : '');
      chart(); marks();
    }
    function chart() {
      const cv = $('#srChart'); if (!cv.offsetParent) return;
      const box = cv.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1); cv.width = Math.max(10, box.width * dpr); cv.height = Math.max(10, box.height * dpr);
      const x = cv.getContext('2d'), w = box.width, h = box.height, L = 96, R = 8, rows = 3, gap = 8, top = 4, bot = 18, rh = (h - top - bot - gap * (rows - 1)) / rows, pw = w - L - R, bw = pw / H;
      x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
      x.fillStyle = css('--hover'); x.fillRect(L + S0 / 60 * bw, top, (S1 - S0) / 60 * bw, h - top - bot);
      const cu = curve || hourly(D, sel), series = [['Rain, SFO', D.rain.map(v => v || 0), css('--rain'), 'mm'], ['Flood reports', cu.floods, css('--warning'), ''], ['Calls', cu.calls, css('--sr-bar'), '']];
      x.font = '11px ' + css('--f-data'); x.textBaseline = 'middle';
      series.forEach(([lab, vals, col], r) => {
        const y0 = top + r * (rh + gap), mx = Math.max(1, ...vals);
        x.fillStyle = css('--text-3'); x.textAlign = 'right'; x.fillText(lab, L - 8, y0 + rh / 2 - 2);
        x.strokeStyle = css('--border-1'); x.lineWidth = 1; x.beginPath(); x.moveTo(L, y0 + rh + 0.5); x.lineTo(w - R, y0 + rh + 0.5); x.stroke();
        x.fillStyle = col; for (let i = 0; i < H; i++) { const bh = vals[i] / mx * rh; if (bh > 0) x.fillRect(L + i * bw + 0.5, y0 + rh - bh, Math.max(1, bw - 1), bh); }
        x.fillStyle = css('--text-3'); x.textAlign = 'right'; x.fillText('max ' + (Math.round(mx * 10) / 10) + (r === 0 ? ' mm' : ''), L - 8, y0 + rh / 2 + 13);
      });
      x.textAlign = 'center'; x.fillStyle = css('--text-3');
      for (let d = 0; d * 24 < H; d++) { const c = clock(D, d * 1440); x.fillText(c.day.slice(4), L + (d * 24 + 12) * bw, h - 6); x.fillStyle = css('--border-2'); x.fillRect(L + d * 24 * bw, top, 1, h - top - bot); x.fillStyle = css('--text-3'); }
      x.fillStyle = css('--text-1'); x.fillRect(L + (hour + 1) * bw - 1, top, 2, h - top - bot);
      x.fillStyle = css('--text-1'); x.globalAlpha = 0.08; x.fillRect(L + Math.max(0, hour + 1 - span / 60) * bw, top, Math.min(hour + 1, span / 60) * bw, h - top - bot); x.globalAlpha = 1;
    }
    $('#srChart').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(), L = 96, pw = r.width - L - 8; const h = Math.floor((e.clientX - r.left - L) / pw * H); if (h >= 0 && h < H) { stop(); setHour(h); } });

    /* ---- storm window against matched dry days */
    function compare() {
      const c = cmpOf(sel), out = $('#srCmp'); out.textContent = '';
      $('#srCmpWhere').textContent = name(sel);
      const row = (lab, s, d, dd, ci) => { const tr = document.createElement('tr'); [lab, s, d, dd, ci].forEach((v, i) => { const td = document.createElement(i ? 'td' : 'th'); if (!i) td.scope = 'row'; td.textContent = v; tr.appendChild(td); }); out.appendChild(tr); };
      if (c.storm_med == null) { row('Median', 'n/a', 'n/a', 'n/a', ''); }
      else {
        row('Median', f1(c.storm_med), f1(c.dry_med), sgn(c.d_med), c.d_med_ci ? `${sgn(c.d_med_ci[0])} to ${sgn(c.d_med_ci[1])}` : '');
        row('90th percentile', f1(c.storm_p90), f1(c.dry_p90), sgn(c.d_p90), c.d_p90_ci ? `${sgn(c.d_p90_ci[0])} to ${sgn(c.d_p90_ci[1])}` : '');
      }
      row('Calls', fi(c.storm_matched), fi(c.dry_matched), '', '');
      const fl = $('#srFew'); fl.hidden = !c.few;
      fl.querySelector('span').textContent = c.storm_matched === 0 ? 'No storm call here could be matched to a dry-day call of the same weekday, hour and type, so there is no comparison.' : `Too few calls to compare: ${fi(c.storm_matched)} matched storm calls and ${fi(c.dry_matched)} matched dry-day calls. A comparison needs at least 20 and 60. The numbers are shown, but treat any difference as noise.`;
      $('#srCmpNote').textContent = `Storm window: ${clock(D, S0).day}, ${clock(D, S0).time} to ${clock(D, S1).day}, ${clock(D, S1).time}. ${fi(c.storm_matched)} storm calls with a valid time are matched` + (c.storm_unmatched ? `; ${fi(c.storm_unmatched)} more had no dry-day call of the same weekday, hour and type and are left out` : '')
        + `. Dry side: ${fi(c.dry_matched)} calls on ${fi(c.dry_days)} dry days, weighted so their weekday, hour and type mix equals the storm's. Change is storm minus dry, in minutes, with a 90% bootstrap interval. ${fi(c.flood_storm)} flood reports were filed here during the window.`;
    }

    /* ---- every neighborhood */
    function table() {
      const tb = $('#srNbRows'); tb.textContent = '';
      const order = D.nb.map((n, k) => k).sort((a, b) => (C.nb[b].storm_matched - C.nb[a].storm_matched) || (D.nb[a].name < D.nb[b].name ? -1 : 1));
      for (const k of order) {
        const c = C.nb[k], tr = document.createElement('tr'); if (k === sel) tr.setAttribute('aria-selected', 'true');
        const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = D.nb[k].name; btn.addEventListener('click', () => choose(k));
        const th = document.createElement('th'); th.scope = 'row'; th.appendChild(btn); tr.appendChild(th);
        const cells = [fi(c.storm_matched), c.storm_med == null ? 'n/a' : `${f1(c.storm_med)} / ${f1(c.dry_med)}`, c.few ? 'too few' : sgn(c.d_med), fi(c.flood_storm)];
        cells.forEach((v, i) => { const td = document.createElement('td'); td.textContent = v; if (i === 2 && c.few) td.className = 'few'; tr.appendChild(td); });
        tb.appendChild(tr);
      }
    }
    function types() {
      const tb = $('#srTyRows'); tb.textContent = '';
      for (const c of C.types) { const tr = document.createElement('tr'); [c.label, fi(c.storm_matched), `${f1(c.storm_med)} / ${f1(c.dry_med)}`, c.few ? 'too few' : sgn(c.d_med), c.few ? 'too few' : sgn(c.d_p90)].forEach((v, i) => { const td = document.createElement(i ? 'td' : 'th'); if (!i) td.scope = 'row'; td.textContent = v; if (v === 'too few') td.className = 'few'; tr.appendChild(td); }); tb.appendChild(tr); }
    }
    function observation() {
      const o = C.obs, top = o.top_flood || [];
      const rho = o.spearman_flood_vs_d_med, dir = rho == null ? 'could not be measured' : rho >= 0.3 ? 'tended to go with longer waits' : rho <= -0.3 ? 'did not go with longer waits; if anything the waits were shorter' : 'showed no clear pattern with waits';
      $('#srObs').textContent = `Observation, not a finding of cause. Among the ${o.n_neighborhoods} neighborhoods with enough calls to compare, more flood reports during the window ${dir}: the rank correlation between flood reports and the change in median time is ${rho == null ? 'n/a' : rho.toFixed(2)}, and ${o.spearman_flood_vs_d_p90 == null ? 'n/a' : o.spearman_flood_vs_d_p90.toFixed(2)} for the 90th percentile. `
        + (top.length ? `The ${top.length} with the most flood reports (${top.map(t => `${t[0]} ${t[1]}`).join(', ')}) changed by ${top.map(t => sgn(t[2])).join(', ')} minutes at the median. ` : '')
        + `${o.n_neighborhoods} neighborhoods is a small sample, and flood reports follow where people are and choose to report, so this cannot show whether flooding slowed units down.`;
      const ci = C.city.d_med_ci || [NaN, NaN], verdict = ci[0] > 0 ? 'On this record, the median wait was longer during the storm.' : ci[1] < 0 ? 'On this record, the median wait was shorter during the storm.' : 'On this record, the median wait did not measurably change during the storm: the interval includes zero.';
      $('#srCityLine').textContent = `Across the city, ${fi(C.city.storm_matched)} storm calls had a median of ${f1(C.city.storm_med)} minutes from receipt to the first unit on scene, against ${f1(C.city.dry_med)} on matched dry days (change ${sgn(C.city.d_med)}, 90% interval ${sgn(ci[0])} to ${sgn(ci[1])}). The 90th percentile was ${f1(C.city.storm_p90)} against ${f1(C.city.dry_p90)} (change ${sgn(C.city.d_p90)}, interval ${sgn(C.city.d_p90_ci[0])} to ${sgn(C.city.d_p90_ci[1])}). ${verdict}`;
    }

    /* ---- map layer: neighborhood shapes, calls and flood reports, drawn on a flat canvas over the 3D map from GTScene.project */
    const cv = document.createElement('canvas'); cv.id = 'srMap'; cv.setAttribute('aria-hidden', 'true');
    let pts = null, flp = null, label = null, labelFor = -2, curSt = null;
    function marks() {
      const end = (hour + 1) * 60, I = D.inc; pts = []; flp = [];
      for (let i = 0; i < I.t.length; i++) if (I.t[i] >= end - span && I.t[i] < end && I.x[i] != null) pts.push([I.x[i], I.y[i], I.s[i] === 0 ? I.r[i] : -1]);
      for (let i = 0; i < D.flood.t.length; i++) if (D.flood.t[i] >= end - span && D.flood.t[i] < end) flp.push([D.flood.x[i], D.flood.y[i]]);
      if (labelFor !== sel && Sc.addLabel) { if (label) label.show(false); label = null; labelFor = sel;
        if (sel >= 0) { const el = document.createElement('div'); el.className = 'pin-label sr-lb'; el.textContent = D.nb[sel].name; el.hidden = true; $('#labels').appendChild(el); label = Sc.addLabel(D.nb[sel].c[0], D.nb[sel].c[1], el, 0.12); label.show(true); } }
    }
    const visible = () => sec.classList.contains('on');
    function frame() {
      if (!visible()) { cv.remove(); if (label) label.show(false); labelFor = -2; label = null; if (stLabel) stLabel.show(false); stop(); return; }
      requestAnimationFrame(frame);
      if (Sc.rain) Sc.rain.value = Math.min(1, (D.rain[hour] || 0) / 12);       // rain on the map follows the gauge at the scrubber's hour
      const gl = $('#gl'); if (!Sc.project || !gl) return; if (!cv.parentNode) gl.parentNode.insertBefore(cv, $('#labels'));
      const w = gl.clientWidth, h = gl.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1); if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const x = cv.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h);
      const P = (lon, lat) => Sc.project(lon, lat, 0.04), slow = css('--sr-slow'), fast = css('--sr-fast'), line = css('--sr-line'), selc = css('--sr-sel');
      D.nb.forEach((n, k) => {                                   // fill is faint where the 90% interval of the change includes zero
        const c = C.nb[k]; x.beginPath(); let any = false;
        for (const r of n.rings) { r.forEach((q, j) => { const p = P(q[0], q[1]); if (!p) return; any = true; j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1]); }); x.closePath(); }
        if (!any) return;
        if (!c.few && c.d_med != null) { x.globalAlpha = c.d_med_ci && (c.d_med_ci[0] > 0 || c.d_med_ci[1] < 0) ? 0.45 : 0.14; x.fillStyle = c.d_med > 0 ? slow : fast; x.fill('evenodd'); x.globalAlpha = 1; }
        x.setLineDash(c.few ? [3, 3] : []); x.strokeStyle = k === sel ? selc : line; x.lineWidth = k === sel ? 2.5 : 1.2; x.stroke(); x.setLineDash([]);
      });
      if (flp) { x.fillStyle = css('--rain'); x.globalAlpha = 0.7; for (const q of flp) { const p = P(q[0], q[1]); if (p) x.fillRect(p[0] - 2, p[1] - 2, 4, 4); } x.globalAlpha = 1; }
      if (curSt) { const p = P(curSt.lon, curSt.lat); if (p) { x.strokeStyle = selc; x.lineWidth = 2.5; x.beginPath(); x.arc(p[0], p[1], 9, 0, 6.2832); x.stroke(); x.beginPath(); x.arc(p[0], p[1], 3, 0, 6.2832); x.fillStyle = selc; x.fill(); } }
      if (pts) for (const q of pts) { const p = P(q[0], q[1]); if (!p) continue; x.beginPath(); x.arc(p[0], p[1], 3.2, 0, 6.2832);
        if (q[2] < 0) { x.strokeStyle = css('--sr-none'); x.lineWidth = 1.5; x.stroke(); } else { x.fillStyle = q[2] <= 10 ? css('--sr-call') : q[2] <= 20 ? css('--warning') : css('--danger'); x.fill(); } }
    }
    { const gl = $('#gl'); let down = null; if (gl && Sc) { gl.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
      gl.addEventListener('pointerup', e => { if (!visible() || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; const ll = Sc.pick(e.clientX, e.clientY); if (!ll) return; const k = nbAt(D, ll[0], ll[1]); choose(k); }); } }
    $('#srCity').addEventListener('click', () => choose(-1));


    /* ---- planning scenario: one extra ambulance at one station. Shown only if the drive-time model passed its held-out check. */
    const SC = D.scn; let stLabel = null;
    function scenario() {
      const ck = $('#srScnCheck'), body = $('#srScnBody'), v = SC && SC.val, vs = SC && SC.val_storm;
      const rl = $('#srScnRules'); rl.textContent = ''; if (SC) for (const k of ['stations', 'travel', 'check', 'sim', 'limits']) { const li = document.createElement('li'); li.textContent = SC.rules[k]; rl.appendChild(li); }
      if (!SC || !SC.passed || !SC.runs) { body.hidden = true; ck.textContent = SC ? `Not shown: the drive-time model missed its check on real October 2026 arrivals (median error ${f1(v.mae)} min, bias ${sgn(v.bias)} min).` : 'No scenario data.'; return; }
      ck.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg><span></span>';
      ck.querySelector('span').textContent = `Drive-time model checked against ${fi(v.n)} real engine arrivals in October 2026, a month it was not fitted on: median error ${f1(v.mae)} min, median bias ${sgn(v.bias)} min, 90% of errors within ${f1(v.p90_abs)} min. In the storm window itself (${fi(vs.n)} arrivals): median error ${f1(vs.mae)} min, bias ${sgn(vs.bias)} min.`;
      const sel_ = $('#srStation'); if (sel_.options.length < 2) {
        SC.stations.filter(st => SC.runs[st.id]).forEach(st => { const o = document.createElement('option'); o.value = st.id; const c = SC.runs[st.id].city; o.textContent = `Station ${+st.id} · reaches ${c.reached} call${c.reached === 1 ? '' : 's'} first`; sel_.appendChild(o); });
        sel_.addEventListener('change', () => runScn(sel_.value));
      }
      runScn(sel_.value);
    }
    function runScn(id) {
      const tb = $('#srScnRows'); tb.textContent = ''; if (stLabel) { stLabel.show(false); stLabel = null; }
      if (!id) { curSt = null; $('#srScnCity').textContent = 'Pick a station to see the estimate.'; return; }
      const r = SC.runs[id], c = r.city, st = SC.stations.find(x => x.id === id); curSt = st || null;
      $('#srScnCity').textContent = `With one extra ambulance at Station ${+id}, it would have reached ${fi(c.reached)} of the ${fi(c.n)} medical calls in the storm window before any unit that really arrived. Citywide, the median for medical calls would go from ${f1(c.base_med)} to ${f1(c.new_med)} minutes and the 90th percentile from ${f1(c.base_p90)} to ${f1(c.new_p90)}. An estimate from a simple model, not a measurement.`;
      Object.keys(r.nb).map(Number).filter(k => r.nb[k].reached > 0).sort((a, b) => r.nb[b].reached - r.nb[a].reached).forEach(k => {
        const n = r.nb[k], tr = document.createElement('tr');
        [D.nb[k].name, fi(n.n), fi(n.reached), `${f1(n.base_med)} / ${f1(n.new_med)}`, `${f1(n.base_p90)} / ${f1(n.new_p90)}`].forEach((v, i) => { const td = document.createElement(i ? 'td' : 'th'); if (!i) td.scope = 'row'; td.textContent = v; tr.appendChild(td); }); tb.appendChild(tr); });
      if (Sc.addLabel && st) { const el = document.createElement('div'); el.className = 'pin-label sr-lb'; el.textContent = `Extra ambulance · Station ${+id}`; el.hidden = true; $('#labels').appendChild(el); stLabel = Sc.addLabel(st.lon, st.lat, el, 0.1); stLabel.show(visible()); }
    }
    /* ---- sources */
    const m = D.meta, dl = m.daily || {};
    $('#srDayRain').textContent = Object.keys(dl).map(d => `${clock(D, Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(+m.start.slice(0, 4), +m.start.slice(5, 7) - 1, +m.start.slice(8, 10))) / 60000)).day}: downtown ${f1(dl[d].downtown)} mm, ${fi(dl[d].floods)} flood reports`).join(' · ');
    $('#srSrc').textContent = `Dispatch: ${m.source.dispatch}, pulled ${m.source.pulled}, ${fi(m.unit_rows)} unit rows grouped into ${fi(m.incidents)} incidents received ${m.source.span[0].slice(0, 10)} to ${m.source.span[1].slice(0, 10)}. Neighborhoods: ${m.source.neighborhoods}. Rain: ${m.source.rain}; the hourly bars are the SFO airport gauge, just south of the city. Flood reports: ${m.source.floods}. Times are local clock time, ${m.time_zone}. Built by scripts/sf/09_storm_response_sf.py.`;
    const rl = $('#srRules'); rl.textContent = ''; for (const k of ['incident', 'response', 'dropped', 'dry_day', 'matching', 'few', 'percentile', 'interval', 'priority']) { const li = document.createElement('li'); li.textContent = m.rules[k]; rl.appendChild(li); }
    const ss = m.status_storm || {}; $('#srMissing').textContent = `In the storm window: ${fi(Object.values(ss).reduce((a, b) => a + b, 0))} incidents, ${fi(ss.ok || 0)} with a valid time, ${fi(ss.no_unit_on_scene || 0)} with no unit recorded on scene` + (ss.over_120_min ? `, ${fi(ss.over_120_min)} over two hours` : '') + `. Dry days: ${fi(m.dry_days)} between September 2025 and October 2026, ${fi(m.dry_days_used)} of them on the storm's weekdays and used.`;

    types(); observation(); scenario();
    function open() { if (stLabel) stLabel.show(true); fill(rng); curve = hourly(D, sel); paint(); table(); compare(); requestAnimationFrame(frame); }
    new MutationObserver(() => { if (visible()) requestAnimationFrame(open); }).observe(sec, { attributes: true, attributeFilter: ['class'] });
    window.addEventListener('resize', () => { if (visible()) chart(); });
    api.state = () => ({ hour, span, sel, D });
    api.set = (h, k, s) => { if (s) span = s; if (k != null) choose(k); setHour(h); };
  }
})();
