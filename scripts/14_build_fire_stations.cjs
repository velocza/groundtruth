/* Fire stations for the "help on the way" map, both areas. Usage: node scripts/14_build_fire_stations.cjs <workdir with fire_stations_raw.json>
   Sources, in order: Overture Maps places tagged fire_station (scripts/13_fetch_fire_stations.py), then, for stations Overture misses, the street
   address the fire district publishes, placed with the same Overture address points the address check uses (addresses.js in site/data and site/data_sf).
   Writes site/data/fire_stations.js and site/data_sf/fire_stations.js (window.GT_FIRE). Only stations inside each map box are kept, because
   routes run on that box's street network. The San Francisco drive-time curve is copied into the Lamorinda file as a labelled estimate. */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..'), RAW = JSON.parse(fs.readFileSync(path.join(process.argv[2], 'fire_stations_raw.json'), 'utf8'));
global.window = global; require(path.join(ROOT, 'site/js/address.js'));
const load = f => { const c = { window: {} }; vm.runInNewContext(fs.readFileSync(f, 'utf8'), c); return c.window; };
const BOX = { lamorinda: [-122.215, 37.805, -122.055, 37.925], sf: [-122.520, 37.705, -122.360, 37.825] };
const inBox = (a, p) => p.lon > BOX[a][0] && p.lon < BOX[a][2] && p.lat > BOX[a][1] && p.lat < BOX[a][3];
/* SF: numbered SFFD stations only (49 is the ambulance base and 70 is not a firehouse). Overture place name -> station id and agency; anything not listed is left out (offices, training sites, duplicates, other cities) */
const PICK = {
  lamorinda: [[/Contra Costa County Fire Station No\. 3$/, 'CC3', 'Contra Costa County Fire', 'Station 3'], [/Contra Costa Fire Station 15$/, 'CC15', 'Contra Costa County Fire', 'Station 15'],
    [/Contra Costa Fire Station 17$/, 'CC17', 'Contra Costa County Fire', 'Station 17'], [/Moraga-orinda Fire District Station 45$/, 'MO45', 'Moraga-Orinda Fire', 'Station 45'],
    [/^Moraga-orinda Fire Station$/, 'MO43', 'Moraga-Orinda Fire', 'Station 43'], [/Oakland Fire Station No\. 24$/, 'OK24', 'Oakland Fire', 'Station 24']],
  sf: null };
/* published addresses for stations Overture does not have (mofd.org Stations and Facilities; Contra Costa County Fire; SFFD) */
const ADDR = { lamorinda: [['CC16', 'Contra Costa County Fire', 'Station 16', '4007 Los Arabis Dr, Lafayette'], ['MO41', 'Moraga-Orinda Fire', 'Station 41', '1284 Moraga Way, Moraga'],
    ['MO42', 'Moraga-Orinda Fire', 'Station 42', '555 Moraga Rd, Moraga'], ['MO44', 'Moraga-Orinda Fire', 'Station 44', '295 Orchard Rd, Orinda']],
  sf: [['24', 'San Francisco Fire', 'Station 24', '100 Hoffman Ave'], ['37', 'San Francisco Fire', 'Station 37', '798 Wisconsin St']] };
const storm = load(path.join(ROOT, 'site/data_sf/storm_response.js')).GT_STORM.scn;
for (const area of ['lamorinda', 'sf']) {
  const dir = area === 'sf' ? 'data_sf' : 'data', A = load(path.join(ROOT, 'site', dir, 'addresses.js')).GT_ADDR, idx = GTAddress.Index(A), out = new Map();
  for (const r of RAW.rows.filter(r => r.area === area && inBox(area, r))) {
    let id, agency, name;
    if (area === 'sf') { const m = /(?:Station(?: No\.)?|Sta\.|Engine Co|Firehouse Number)\s*(\d+)$/i.exec(r.name || ''); if (!m || /Daly City|North County/i.test(r.name) || +m[1] === 49 || +m[1] === 70) continue; id = String(+m[1]).padStart(2, '0'); agency = 'San Francisco Fire'; name = 'Station ' + +m[1]; }
    else { const p = PICK[area].find(p => p[0].test(r.name || '')); if (!p) continue; [, id, agency, name] = p; }
    const prev = out.get(id); if (prev && prev.conf >= (r.confidence || 0)) continue;
    out.set(id, { id, name, agency, lon: r.lon, lat: r.lat, address: [r.address, r.locality].filter(Boolean).join(', '), src: 'Overture Maps places (' + RAW.release.replace(/\/$/, '').replace('release/', '') + ')', conf: r.confidence || 0 });
  }
  for (const [id, agency, name, q] of ADDR[area]) {
    if (out.has(id)) continue; const h = idx.find(q); if (!h.ok || Math.abs(h.number - h.asked) > 6) { console.log(area, 'could not place', q, h.ok ? 'nearest ' + h.number : h.why); continue; }
    out.set(id, { id, name, agency, lon: +h.lon.toFixed(6), lat: +h.lat.toFixed(6), address: h.label, src: 'published station address, placed with Overture address points' });
  }
  const st = [...out.values()].filter(s => inBox(area, s)).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true })).map(({ conf, ...s }) => s);
  const meta = { area, stations: st.length, curve: storm.curve, turnout_min: storm.turn, curve_rule: storm.rules.travel, curve_check: storm.val,
    estimate: area !== 'sf', note: area === 'sf' ? 'Drive times use the San Francisco drive-time model fitted on real engine trips (DataSF dispatch records), checked on October 2026.'
      : 'Contra Costa County does not publish 911 response records like San Francisco does, so Lamorinda drive times are an estimate: the San Francisco engine drive-time curve applied to the distance from each station. Hills and winding roads likely make real trips slower.' };
  fs.writeFileSync(path.join(ROOT, 'site', dir, 'fire_stations.js'), '/* Generated by scripts/14_build_fire_stations.cjs. Do not edit. */\nwindow.GT_FIRE=' + JSON.stringify({ meta, stations: st }) + ';\n');
  console.log(area, st.length, st.map(s => s.id).join(' '));
}
