"""Lamorinda flood score from real public data (no training labels, so no fitted model).

Inputs (dataset/flood_raw/):
  gt_lamorinda_fema_nfhl.geojson     FEMA National Flood Hazard Layer, layer 28 Flood Hazard Zones (hazards.fema.gov)
  gt_lamorinda_nhd_flowlines.geojson USGS NHD flowlines, large scale (hydro.nationalmap.gov)
  noaa_storm_events_lamorinda.csv    NOAA NCEI Storm Events, Contra Costa / Alameda flood rows (optional, for checks)
  plus dataset/grid_480x456_all_layers.npz (USGS 3DEP elevation) and dataset/rainfall_daily_lamorinda.csv (NOAA GHCN gauges)

Where score (0..100, per 29 m cell): FEMA zone first (1% annual chance = A, AE, AO, AH; 0.2% = shaded X),
then height above the nearest NHD creek and distance to it, plus a small bump for low wet hollows (wetness index).
Storm factor: 3 day rain and soil wetness, scaled so the creek-flood storms in the NOAA record land near the top.
Output: site/data/flood_lamorinda.js (window.GT_FLOOD_L) and dataset/flood/*.
Run: python3 scripts/13_flood_lamorinda.py
"""
import csv, json, os, sys, math
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, 'dataset', 'flood_raw')
OUT = os.path.join(ROOT, 'dataset', 'flood'); os.makedirs(OUT, exist_ok=True)
G = np.load(os.path.join(ROOT, 'dataset', 'grid_480x456_all_layers.npz'))
W, S, E, N = -122.215, 37.805, -122.055, 37.925
NY, NX = G['dem'].shape
SS = 4  # supersampling for rasterizing

def px(lon, lat):
    return ((lon - W) / (E - W) * NX * SS, (N - lat) / (N - S) * NY * SS)

def raster_polys(feats, keep):
    im = Image.new('L', (NX * SS, NY * SS), 0); d = ImageDraw.Draw(im)
    for f in feats:
        v = keep(f['properties'])
        if not v: continue
        g = f['geometry']; polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
        for poly in polys:
            for k, ring in enumerate(poly):
                pts = [px(x, y) for x, y in ring]
                if len(pts) > 2: d.polygon(pts, fill=v if k == 0 else 0)
    a = np.asarray(im, dtype=np.float32).reshape(NY, SS, NX, SS).mean(axis=(1, 3))
    return a

fema = json.load(open(os.path.join(RAW, 'gt_lamorinda_fema_nfhl.geojson')))['features']
z100 = raster_polys(fema, lambda p: 255 if p['FLD_ZONE'] in ('A', 'AE', 'AO', 'AH') else 0) / 255
zway = raster_polys(fema, lambda p: 255 if (p.get('ZONE_SUBTY') or '') == 'FLOODWAY' else 0) / 255
z500 = raster_polys(fema, lambda p: 255 if '0.2 PCT' in (p.get('ZONE_SUBTY') or '') else 0) / 255
mapped = raster_polys(fema, lambda p: 255 if p['FLD_ZONE'] != 'D' else 0) / 255

nhd = json.load(open(os.path.join(RAW, 'gt_lamorinda_nhd_flowlines.geojson')))['features']
im = Image.new('L', (NX * SS, NY * SS), 0); d = ImageDraw.Draw(im)
names = Image.new('I', (NX, NY), 0); dn = ImageDraw.Draw(names); name_list = ['']
for f in nhd:
    p = f['properties']
    if p.get('ftype') in (428, 336) and not p.get('gnis_name'): pass
    nm = p.get('gnis_name') or ''
    if 'Aqueduct' in nm or 'Canal' in nm or p.get('ftype') in (428,): continue   # pipes and canals do not overflow onto streets
    if nm and nm not in name_list: name_list.append(nm)
    g = f['geometry']; lines = g['coordinates'] if g['type'] == 'MultiLineString' else [g['coordinates']]
    for ln in lines:
        pts = [px(x, y) for x, y in ln]
        if len(pts) > 1:
            d.line(pts, fill=255, width=SS)
            if nm: dn.line([(x / SS, y / SS) for x, y in pts], fill=name_list.index(nm), width=1)
stream = np.asarray(im).reshape(NY, SS, NX, SS).max(axis=(1, 3)) > 0
names = np.asarray(names, dtype=np.int32)
cell = (29.29 + 29.2) / 2
dist, (ir, ic) = ndi.distance_transform_edt(~stream, return_indices=True)
dist = dist * cell
dem = G['dem'].astype(np.float32)
# height above the nearest creek: elevation minus the lowest creek elevation within 3 cells of the nearest creek point
creek_dem = np.where(stream, ndi.minimum_filter(np.where(stream, dem, 1e4), size=3), 1e4)
hand = np.maximum(0, dem - creek_dem[ir, ic])
# nearest named creek (for wording)
named = names > 0
_, (nr, nc) = ndi.distance_transform_edt(~named, return_indices=True)
near_name = names[nr, nc]
twi = G['twi']

# where score, 0..1
sig = lambda x: 1 / (1 + np.exp(-x))
terrain = sig(2.2 - 0.9 * hand) * sig(2.5 - dist / 60) # low and close to a creek
hollow = np.clip((twi - 10) / 5, 0, 1) * sig(1.5 - 0.5 * hand) * 0.35
where = np.maximum.reduce([0.95 * np.maximum(z100, zway), 0.6 * z500, terrain * 0.85, hollow])
where = np.clip(where, 0, 1)

# rain record and storm factor
rain = list(csv.DictReader(open(os.path.join(ROOT, 'dataset', 'rainfall_daily_lamorinda.csv'))))
r3 = {r['date']: float(r['rain_3d_mm'] or 0) for r in rain}; api = {r['date']: float(r['api_mm_k0.92'] or 0) for r in rain}
def storm(r72, a):
    return float(np.clip(0.75 * min(1.4, r72 / 120) + 0.25 * min(1.2, a / 120), 0, 1.2))

# NOAA Storm Events checks
events = []
evp = os.path.join(RAW, 'noaa_storm_events_lamorinda.csv')
if os.path.exists(evp):
    for r in csv.DictReader(open(evp)):
        if 'Flood' not in r['EVENT_TYPE']: continue
        try: lat, lon = float(r['BEGIN_LAT']), float(r['BEGIN_LON'])
        except ValueError: lat = lon = None
        ym = r['BEGIN_YEARMONTH']; dd = r['BEGIN_DAY'].zfill(2); date = f'{ym[:4]}-{ym[4:]}-{dd}'
        txt = (r.get('EVENT_NARRATIVE') or '') + ' ' + (r.get('EPISODE_NARRATIVE') or '')
        place = r.get('BEGIN_LOCATION') or ''
        inbox = lat is not None and W <= lon <= E and S <= lat <= N
        local = inbox or any(k in (txt + ' ' + place).upper() for k in ('LAFAYETTE', 'ORINDA', 'MORAGA'))
        if local: events.append(dict(date=date, type=r['EVENT_TYPE'], lat=lat, lon=lon, inbox=inbox, place=place, county=r['CZ_NAME'], text=txt.strip()[:400], src=r['EVENT_ID']))
json.dump(events, open(os.path.join(OUT, 'noaa_flood_events_lamorinda.json'), 'w'), indent=1)

def rc(lon, lat): return int((N - lat) / (N - S) * NY), int((lon - W) / (E - W) * NX)
land = where[mapped > 0.5] if (mapped > 0.5).any() else where.ravel()
pts = [e for e in events if e['inbox']]
chk = []
for e in pts:
    r, c = rc(e['lon'], e['lat'])
    r0, r1, c0, c1 = max(0, r - 3), r + 4, max(0, c - 3), c + 4   # NOAA points are approximate: best cell within about 100 m
    v = float(where[r0:r1, c0:c1].max()); pct = float((where.ravel() < v).mean())
    chk.append(dict(date=e['date'], score=round(v * 100, 1), land_pct=round(pct, 3), fema100=bool(z100[r0:r1, c0:c1].max() > 0.5), dist_creek_m=round(float(dist[r0:r1, c0:c1].min()))))
# random spots within 100 m for comparison
rng = np.random.default_rng(7); rnd = []
for _ in range(4000):
    r, c = rng.integers(3, NY - 4), rng.integers(3, NX - 4); rnd.append(float(where[r - 3:r + 4, c - 3:c + 4].max()))
rnd = np.array(rnd)
# rain before dated local flood days vs all days
dates = sorted({e['date'] for e in events})
allr = np.array([v for v in r3.values()])
rain_chk = []
for dte in dates:
    import datetime as dt
    d0 = dt.date.fromisoformat(dte); best = max((r3.get(str(d0 + dt.timedelta(k)), 0), str(d0 + dt.timedelta(k))) for k in (-1, 0, 1))
    if dte < '2015-10-02': continue
    rain_chk.append(dict(date=dte, r72=round(best[0], 1), rank_pct=round(float((allr < best[0]).mean()), 4), api=round(api.get(best[1], 0), 1)))

# level cuts in where score: High = FEMA 1% zone class, Elevated = 0.2% zone or low by a creek
pct_hi = float((where >= 0.75).mean()); pct_el = float(((where >= 0.45) & (where < 0.75)).mean())
q = np.round(np.clip(where, 0, 1) * 255).astype(np.uint8)
meta = dict(built='2026-11-21', bbox=[W, S, E, N], nx=NX, ny=NY,
    sources=['FEMA National Flood Hazard Layer, Flood Hazard Zones (layer 28), fetched 2026-11-21', 'USGS National Hydrography Dataset flowlines, large scale, fetched 2026-11-21',
             'USGS 3DEP elevation (the map grid)', 'NOAA GHCN daily rain, 6 gauges', 'NOAA NCEI Storm Events database 1996 to 2026 (checks only)'],
    share_high=round(pct_hi, 4), share_elev=round(pct_el, 4),
    fema100_cells=int((z100 > 0.5).sum()), fema500_cells=int((z500 > 0.5).sum()), creek_cells=int(stream.sum()),
    events=len(events), events_located=len(pts), checks=chk, random_mean=round(float(rnd.mean() * 100), 1),
    rain_checks=rain_chk, names=name_list,
    storm_note='Storm factor = 0.75 x min(1.4, 3-day rain / 120 mm) + 0.25 x min(1.2, soil wetness / 120 mm), capped at 1.2. Hand set, not fitted.')
if chk:
    beat = [float((rnd < c['score'] / 100).mean() + 0.5 * (rnd == c['score'] / 100).mean()) for c in chk]
    meta['beats_random'] = round(float(np.mean(beat)), 3)
hand_q = np.clip(np.round(hand * 4), 0, 255).astype(np.uint8)       # 0.25 m steps
dist_q = np.clip(np.round(dist / 5), 0, 255).astype(np.uint8)        # 5 m steps
zone = (np.where(z100 > 0.5, 2, np.where(z500 > 0.5, 1, 0)) + np.where(zway > 0.5, 4, 0)).astype(np.uint8)
import base64
b = lambda a: base64.b64encode(a.astype(np.uint8).tobytes()).decode()
js = {'meta': meta, 'where': b(q), 'hand': b(hand_q), 'dist': b(dist_q), 'zone': b(zone), 'creek': b(np.clip(near_name, 0, 255))}
open(os.path.join(ROOT, 'site', 'data', 'flood_lamorinda.js'), 'w').write('/* Generated by scripts/13_flood_lamorinda.py (Lamorinda flood score from FEMA zones, NHD creeks, 3DEP elevation). Do not edit. */\nwindow.GT_FLOOD_L=' + json.dumps(js, separators=(',', ':')) + ';\n')
np.savez_compressed(os.path.join(OUT, 'flood_layers.npz'), where=where.astype(np.float32), hand=hand, dist_creek=dist, fema100=z100, fema500=z500, floodway=zway)
print(json.dumps({k: v for k, v in meta.items() if k not in ('names',)}, indent=1)[:3000])
