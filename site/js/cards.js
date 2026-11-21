/* escape answer cards: one bold, minimal card per measurement (landslide, flood, help in a storm, way out, and whatever comes next).
   A card shows the structured numbers a model already computed: a big level or value, one plain line, up to three small stats,
   a short "what to do", and the technical detail folded under "How we know". Nothing here parses text or calls a service.

   Adding a measurement (for example a Lamorinda flood model or a San Francisco landslide model):
     GTAddress.addMeasure({ id: 'flood', order: 20, run(ctx) { return { title: 'Flooding', icon: 'flood', level: 'Elevated', ... } } });
   A script that may load before address.js can queue one instead: (window.GT_MEASURES = window.GT_MEASURES || []).push({ ... }).
   A measure with an id that already exists replaces it, so a new model can take over a card without touching address.js.
   ctx holds { hit (the address), fc (rain forecast or null), storms, region, app, scene, cards (this module), prior (earlier results by id) }.
   run() returns a card spec (see card() below) or null to skip the card. The summary strip at the top of the answer picks up every card. */
(function (root) {
  'use strict';
  const API = root.GTCards = {};
  const LEVELS = ['Low', 'Guarded', 'Elevated', 'High'];
  const ICONS = {
    slide: '<path d="M3 19h18"/><path d="M4 19l6-9 3.5 4.5L16 11l4 8"/><path d="M14.5 6.5l1.2 1.2M17.5 5l.6 1.6"/>',
    flood: '<path d="M12 3.5c3 4 5 6.6 5 9.2a5 5 0 0 1-10 0c0-2.6 2-5.2 5-9.2z"/><path d="M3 20c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1"/>',
    help: '<path d="M5 17V11a7 7 0 0 1 14 0v6"/><path d="M3.5 17h17v2.5h-17z"/><path d="M12 4V2.5M4.6 6.2l-1-1M19.4 6.2l1-1"/>',
    route: '<circle cx="6" cy="18" r="2"/><circle cx="18" cy="6" r="2"/><path d="M8 18h6.5a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7H16"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.2"/>'
  };
  API.icon = (name, cls) => `<svg class="ic ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ICONS.info}</svg>`;
  API.LEVELS = LEVELS;
  API.levelOf = v => v >= 75 ? 'High' : v >= 50 ? 'Elevated' : v >= 25 ? 'Guarded' : 'Low';
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  API.el = el;

  /* spec: { id, title, icon, level ('Low'|'Guarded'|'Elevated'|'High'|'' for none), tone ('ok' for a good outcome, 'none' when there is no prediction),
             big (the main value; defaults to level), unit (small text after big), kicker (small text above big, such as "In a storm like January 2023"),
             score (0..100: draws the four-band meter with a marker), line (one plain sentence), stats ([[value, label], ...] up to 3),
             todo ([strings]: first 3 shown, the rest under "More"), how ([strings] under "How we know"), actions ([[label, fn, solid?], ...]),
             extra (fn(cardEl) for a custom block, such as the help-on-the-way list), chip (short text for the summary strip) } */
  API.card = function (s) {
    const t = el('article', 'mc'); t.dataset.measure = s.id || ''; if (s.level) t.dataset.level = s.level; if (s.tone) t.dataset.tone = s.tone;
    const h = el('header', 'mc-h'); h.innerHTML = API.icon(s.icon); h.appendChild(el('h3', '', s.title)); if (s.badge) h.appendChild(el('span', 'mc-badge', s.badge)); t.appendChild(h);
    const hero = el('div', 'mc-hero');
    if (s.kicker) hero.appendChild(el('p', 'mc-k', s.kicker));
    const big = el('p', 'mc-big'); if (s.tone === 'ok') big.innerHTML = API.icon('check', 'mc-ok'); big.appendChild(el('span', 'mc-v', s.big != null ? s.big : s.level || '–'));
    if (s.unit) big.appendChild(el('span', 'mc-u', s.unit)); hero.appendChild(big);
    if (s.score != null && isFinite(s.score)) {
      const m = el('div', 'mc-meter'); m.setAttribute('role', 'img'); m.setAttribute('aria-label', `Score ${Math.round(s.score)} out of 100`);
      for (const L of LEVELS) m.appendChild(el('i', 'b ' + L)); const k = el('b', 'mk'); k.style.left = Math.max(0, Math.min(100, s.score)) + '%'; m.appendChild(k); hero.appendChild(m);
    }
    t.appendChild(hero);
    if (s.line) t.appendChild(el('p', 'mc-line', s.line));
    if (s.stats && s.stats.length) { const dl = el('dl', 'mc-stats'); dl.style.gridTemplateColumns = `repeat(${Math.min(3, s.stats.length)},minmax(0,1fr))`; for (const [v, k] of s.stats.slice(0, 3)) { const d = el('div'); d.appendChild(el('dt', '', k)); d.appendChild(el('dd', '', v)); dl.appendChild(d); } t.appendChild(dl); }
    if (s.extra) s.extra(t);
    if (s.todo && s.todo.length) {
      const w = el('div', 'mc-do'); w.appendChild(el('p', 'mc-sh', 'What to do'));
      const ul = el('ul'); const add = (ul2, x) => { const li = el('li'); li.innerHTML = API.icon('check', 'ck'); li.appendChild(el('span', '', x)); ul2.appendChild(li); };
      s.todo.slice(0, 3).forEach(x => add(ul, x)); w.appendChild(ul);
      if (s.todo.length > 3) { const d = el('details', 'mc-more'); d.appendChild(el('summary', '', `${s.todo.length - 3} more`)); const u2 = el('ul'); s.todo.slice(3).forEach(x => add(u2, x)); d.appendChild(u2); w.appendChild(d); }
      t.appendChild(w);
    }
    const foot = el('div', 'mc-f');
    for (const a of s.actions || []) { const b = el('button', 'btn sm' + (a[2] ? ' solid' : ''), a[0]); b.type = 'button'; b.addEventListener('click', a[1]); foot.appendChild(b); }
    if (s.how && s.how.length) { const d = el('details', 'mc-how'); d.appendChild(el('summary', '', 'How we know')); for (const x of s.how.filter(Boolean)) d.appendChild(el('p', 'note', x)); foot.appendChild(d); }
    if (foot.childNodes.length) t.appendChild(foot);
    return t;
  };
  /* the strip of small chips that sums up every card, each one jumps to its card */
  API.summary = function (cards) {
    const r = el('nav', 'mc-sum'); r.setAttribute('aria-label', 'Your answers');
    for (const { spec, node } of cards) {
      const b = el('button', 'mc-chip'); b.type = 'button'; if (spec.level) b.dataset.level = spec.level; if (spec.tone) b.dataset.tone = spec.tone;
      b.innerHTML = API.icon(spec.icon); b.appendChild(el('span', 'k', spec.title)); b.appendChild(el('b', '', spec.chip || spec.big || spec.level || '–'));
      b.addEventListener('click', () => { node.scrollIntoView({ behavior: 'smooth', block: 'start' }); node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash'); });
      r.appendChild(b);
    }
    return r;
  };
  /* Ask answers use the same parts: a compact card inside the chat. spec as above plus rows ([{ name, sub, score }]) drawn as ranked bars. */
  API.answer = function (s) {
    const c = API.card(s); c.classList.add('mc-ask');
    if (s.rows && s.rows.length) {
      const ol = el('ol', 'mc-rows'); const hero = c.querySelector('.mc-line') || c.querySelector('.mc-hero');
      for (const r of s.rows) { const li = el('li'); if (r.level || r.score != null) li.dataset.level = r.level || API.levelOf(r.score);
        const n = el('span', 'n'); n.appendChild(el('b', '', r.name)); if (r.sub) n.appendChild(el('small', '', r.sub)); li.appendChild(n);
        const bar = el('span', 'bar'); const f = el('i'); f.style.width = Math.max(2, Math.min(100, r.score)) + '%'; bar.appendChild(f); li.appendChild(bar);
        li.appendChild(el('span', 'v', r.value != null ? r.value : Math.round(r.score))); if (r.onClick) { li.tabIndex = 0; li.addEventListener('click', r.onClick); li.addEventListener('keydown', e => { if (e.key === 'Enter') r.onClick(); }); } ol.appendChild(li); }
      hero.after(ol);
    }
    return c;
  };
})(typeof window === 'undefined' ? globalThis : window);
