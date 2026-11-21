/* Which area the dashboard shows. Loaded first: it picks the area, then loads that area's data files in order.
   Lamorinda text is the page default. Elements marked data-only="<area>" show for that area only, and elements marked data-t="<key>" take the text below. */
(function () {
  var REGIONS = {
    lamorinda: { id: 'lamorinda', dir: 'data', label: 'Lamorinda, Contra Costa County', sub: 'Lafayette, Orinda, Moraga', short: 'Lamorinda', places: 'Lafayette, Orinda and Moraga', placesOr: 'Lafayette, Orinda or Moraga', motion: true,
      towns: [['Lafayette', -122.118, 37.886], ['Orinda', -122.183, 37.877], ['Moraga', -122.130, 37.835]], tourQ: 'Where would debris from Miner Road go, and how many buildings are near the path?', example: 'Miner Road with 100 mm rain' },
    sf: { id: 'sf', dir: 'data_sf', files: ['flood_model', 'storm_response'], label: 'San Francisco, San Francisco County', sub: 'City of San Francisco', short: 'San Francisco', places: 'San Francisco', placesOr: 'San Francisco', motion: false,
      tourQ: 'Where would debris from Twin Peaks Boulevard go, and how many buildings are near the path?', example: 'Twin Peaks Boulevard with 100 mm rain',
      title: 'escape · San Francisco',
      text: {
        h1: 'escape, a landslide risk dashboard for San Francisco',
        topH: 'Steep streets, record rain.', topBadge: 'Real data',
        lede: 'escape pairs real terrain with storm rain to rank San Francisco\'s slopes by landslide risk.',
        topNotice: '<b>The score uses real data only</b>: terrain and gauge rain. It is a placeholder formula until the model is trained. San Francisco has no ground motion layer yet, and nothing is simulated in its place. Street flooding reports are in the dataset for model training and are not drawn on this map.',
        topFoot: 'A hackathon prototype. It shows relative risk from a placeholder formula. For safety decisions, follow the National Weather Service and your city.',
        rpBody: 'Real gauge rain from San Francisco drives the map. Beacons mark slides the USGS mapped that winter.', rpGauges: 'San Francisco gauges, area mean',
        btBody: 'Six slides were mapped in the city that winter by the USGS, four of them on one hillside at Bernal Heights. Each one is checked against the ground within 300 m during the three days before.',
        btOf: 'of 6 sat near Elevated or High ground beforehand', btListH: 'The six mapped slides',
        inBody: 'Click the terrain to read one 30 m cell: its slope, its drainage, and what is pushing its score up.', jump: 'Show the most exposed slope',
        askLabel: 'Name a street in San Francisco',
        askHelp: 'Ask runs in your browser for San Francisco. The trees were trained on four older Lamorinda reports and are read here against San Francisco terrain without retraining, so treat the scores as a demonstration. Ask about flooding for the separate San Francisco flood model, trained on the city\'s 311 flood reports. The dashboard map uses the original placeholder.',
        methodH: 'Real terrain, real rain. The model comes next.',
        methodBody: 'Everything on this map was pulled from public data for this exact box of the city. The risk score is a hand-set placeholder that marks where the trained model will plug in.',
        srcRain: 'NOAA GHCN-Daily and CoCoRaHS gauges with the downtown gauge, 2008 to 2026-11-20',
        srcStreets: 'Overture Maps, 1,817 named streets', srcBld: 'Overture Maps, 166,518 footprints',
        evNote: 'Bright lines on the map are blocked road segments. Markers labelled USGS mapped are the six slides the U.S. Geological Survey recorded in the city in winter 2023.',
        srcSlides: '6 mapped by the USGS in winter 2023. The dataset also holds 31,478 city flood reports and 382 NWS storm reports'
      },
      attrs: { '[data-t=topBadge]': ['class', 'badge quiet'], '#gl': ['aria-label', '3D terrain of San Francisco with landslide risk drawn as light'], '#askIn': ['placeholder', 'Ulloa Street, Twin Peaks Boulevard, Folsom Street'] },
      chips: [['Which streets flood worst?', 'Streets that flood worst'], ['Is Twin Peaks Boulevard at risk this weekend?', 'Twin Peaks Boulevard this weekend?'], ['What would 150 mm of rain do to Ulloa Street?', 'Ulloa Street with 150 mm'], ['Which streets are worst right now?', 'Worst streets right now'], ['Where would debris from Twin Peaks Boulevard go, and how many buildings are near the path?', 'Debris path from Twin Peaks Boulevard']]
    }
  };
  var KEY = 'gt-region', id = null;
  try { id = new URLSearchParams(location.search).get('region'); } catch (e) {}
  if (!REGIONS[id]) { try { id = localStorage.getItem(KEY); } catch (e) {} }
  if (!REGIONS[id]) id = 'lamorinda';
  var R = REGIONS[id];
  window.GT_REGIONS = REGIONS; window.GT_REGION = R;
  document.documentElement.setAttribute('data-region', id);
  if (R.title) document.title = R.title;
  ['assets', 'buildings', 'data', 'rainlong', 'local-model', 'roads_graph', 'usgs_inventory', 'census_bg'].concat(R.files || []).forEach(function (f) { document.write('<script src="' + R.dir + '/' + f + '.js"><\/script>'); });

  /* switch area: remember the choice and reload with that area's data */
  window.GT_setRegion = function (next) {
    if (!REGIONS[next] || next === id) return;
    var stored = false; try { localStorage.setItem(KEY, next); stored = localStorage.getItem(KEY) === next; } catch (e) {}
    var q = ''; try { var p = new URLSearchParams(location.search); if (stored) p.delete('region'); else p.set('region', next); q = p.toString(); } catch (e) { q = stored ? '' : 'region=' + next; }
    location.replace(location.pathname + (q ? '?' + q : ''));
  };

  /* called once the markup is parsed, before the app starts */
  window.GT_applyRegion = function () {
    var d = document, each = function (sel, fn) { Array.prototype.forEach.call(d.querySelectorAll(sel), fn); };
    each('[data-only]', function (el) { if (el.getAttribute('data-only') !== id) el.hidden = true; });
    if (R.text) each('[data-t]', function (el) { var v = R.text[el.getAttribute('data-t')]; if (v != null) el.innerHTML = v; });
    if (R.attrs) Object.keys(R.attrs).forEach(function (sel) { var el = d.querySelector(sel); if (el) el.setAttribute(R.attrs[sel][0], R.attrs[sel][1]); });
    if (R.chips) { var c = d.getElementById('askChips'); if (c) { c.textContent = ''; R.chips.forEach(function (q) { var b = d.createElement('button'); b.className = 'btn sm'; b.setAttribute('data-q', q[0]); b.textContent = q[1]; c.appendChild(b); }); } }
    if (!R.motion) { var m = d.getElementById('exMotion'); if (m) m.setAttribute('aria-pressed', 'false'); var s = d.getElementById('simFollow'); if (s) s.checked = false; }
    var pick = d.getElementById('regionPick');
    if (pick) { pick.textContent = ''; Object.keys(REGIONS).forEach(function (k) { var o = d.createElement('option'); o.value = k; o.textContent = REGIONS[k].label; o.selected = k === id; pick.appendChild(o); }); pick.addEventListener('change', function () { window.GT_setRegion(pick.value); }); }
    var sub = d.getElementById('regionSub'); if (sub) sub.textContent = R.sub;
  };
})();
