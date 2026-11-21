"""GroundTruth data pull, part 10: the two USGS landslide inventories of the San Francisco Bay Area (public domain).

  1. Brien, Collins, Corbett and Perkins, 2023, San Francisco Bay Area Reconnaissance Landslide Inventory, January 2023,
     doi 10.5066/P9NJ3KMG (ScienceBase item 64c2df9cd34e70357a32fd0f). A point CSV, plus a shapefile of the routes the
     USGS crews TRAVELLED (survey coverage, not landslide travel paths). The ~104 MB photo archive is skipped.
  2. Corbett and Collins, 2023, Mapped polygons of landslides triggered by the 2016-2017 storm season, eastern San
     Francisco Bay region, doi 10.5066/P98MVEGI (ScienceBase item 607e0f8ad34e8564d67e3b5a), the data behind SIM 3503.

Usage:  python3 scripts/10_usgs_inventory.py [raw_dir]        (raw_dir defaults to work/usgs_raw, which is git-ignored)
Files already in raw_dir are reused, so the script also runs where ScienceBase is blocked: put the six files named in
FILES there by hand. Every file is checked against the MD5 that ScienceBase publishes before it is read.

Writes dataset/usgs_landslides_2023.csv, dataset/usgs_landslides_2016_17.csv and site/data/usgs_inventory.js.
With --region sf it clips to the San Francisco box and writes the same files under dataset_sf/ and site/data_sf/.
Standard library + numpy only. Shapefiles are read with a small struct reader; the .prj decides the coordinates:
lon/lat on WGS84 or NAD83 is used as is, Transverse Mercator is inverted with its own parameters, anything else stops.
"""
import sys, os, io, re, csv, json, math, struct, zipfile, hashlib, urllib.request
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# "--region sf" clips to the San Francisco box and writes dataset_sf/ and site/data_sf/; the default is Lamorinda.
REGION = sys.argv[sys.argv.index('--region') + 1] if '--region' in sys.argv else 'lamorinda'
ARGS = [a for i, a in enumerate(sys.argv[1:], 1) if a != '--region' and sys.argv[i - 1] != '--region']
RAW = ARGS[0] if ARGS else os.path.join(ROOT, 'work', 'usgs_raw')
if REGION == 'sf':
    W, S, E, N = -122.520, 37.705, -122.360, 37.825            # same box as scripts/sf/region.py
    KX, KY = 88000.0, 110950.0
    DS, SITE = 'dataset_sf', 'data_sf'
else:
    W, S, E, N = -122.215, 37.805, -122.055, 37.925           # same box as scripts/03_build.py
    KX, KY = 87800.0, 110950.0                                 # metres per degree here, as in site/js/model.js
    DS, SITE = 'dataset', 'data'
SB = 'https://www.sciencebase.gov/catalog/file/get/'
FILES = {                                                      # name: (url, md5 published by ScienceBase)
    'San_Francisco_Bay_Area_Reconnaissance_Landslide_Inventory_January_2023.csv': (SB + '64c2df9cd34e70357a32fd0f?f=__disk__96%2F40%2F59%2F9640596d47fa71472c638717426c5366eddb680d', 'd621ab37f06bf4982a9ce9cbe87b866e'),
    'San_Francisco_Bay_Area_Reconnaissance_Travel_Lines_January_2023.zip': (SB + '64c2df9cd34e70357a32fd0f?f=__disk__2b%2F0d%2F3d%2F2b0d3dfa346fa76756a9c9e942accd1ccd90255d', '5a221519d0804165ffd324eb21cba7dc'),
    'Slide_Source_Runout_Area_2017.zip': (SB + '607e0f8ad34e8564d67e3b5a?f=__disk__46%2F2d%2F27%2F462d27546b4284f71b5a65c46e8ea063b6baa504', '581c8a2c230d66754d5f0a410805c8e2'),
    'Slide_Source_Area_2017.zip': (SB + '607e0f8ad34e8564d67e3b5a?f=__disk__be%2Fef%2F2b%2Fbeef2b571d8eae4e822f393eb629a1bf59d8e2e9', 'd2b326d0f613eac426308f894aaf7c97'),
    'EastBayBound-UTM.zip': (SB + '607e0f8ad34e8564d67e3b5a?f=__disk__05%2Fed%2Fad%2F05edad40000cb9797a5f3b977919f1ab192a7e04', '27c5229e2a2ae868f3f54ed67080af4c'),
}


def fetch():
    os.makedirs(RAW, exist_ok=True)
    for name, (url, md5) in FILES.items():
        p = os.path.join(RAW, name)
        if not os.path.exists(p):
            print('downloading', name, flush=True)
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'groundtruth-fetch'}), timeout=120) as r:
                    open(p, 'wb').write(r.read())
            except Exception as err:
                sys.exit(f'Could not download {name} ({err}).\nFetch it in a browser from\n  {url}\nand save it as {p}, then run this script again.')
        got = hashlib.md5(open(p, 'rb').read()).hexdigest()
        if got != md5:
            sys.exit(f'{name}: MD5 {got} does not match the published {md5}. Delete it and fetch again.')
    print('raw files ok:', RAW)


# ---------------------------------------------------------------- projection, read from the .prj, never assumed
def prj_inverse(wkt):
    """Returns f(x, y) -> (lon, lat) for the coordinate system in a .prj, or stops if it is one this script cannot convert."""
    datum = re.search(r'DATUM\["([^"]+)"', wkt).group(1)
    if datum not in ('D_WGS_1984', 'D_North_American_1983'):
        sys.exit(f'Unknown datum {datum}: not converting. Check the .prj by hand.')
    a, rf = map(float, re.search(r'SPHEROID\["[^"]+",([\d.]+),([\d.]+)\]', wkt).groups())
    if not wkt.startswith('PROJCS'):
        if not wkt.startswith('GEOGCS') or 'Degree' not in wkt: sys.exit('Unrecognised .prj: ' + wkt[:80])
        return (lambda x, y: (x, y)), datum + ' lon/lat'
    proj = re.search(r'PROJECTION\["([^"]+)"', wkt).group(1)
    if proj != 'Transverse_Mercator' or 'UNIT["Meter",1.0]' not in wkt:
        sys.exit(f'Projection {proj} is not handled: not converting.')
    par = {k: float(v) for k, v in re.findall(r'PARAMETER\["([^"]+)",([-\d.]+)\]', wkt)}
    if par.get('Latitude_Of_Origin', 0) != 0: sys.exit('Transverse Mercator with a non-zero latitude of origin is not handled.')
    fe, fn, lon0, k0 = par['False_Easting'], par['False_Northing'], math.radians(par['Central_Meridian']), par['Scale_Factor']
    # Krueger series (Karney 2011, to n^3; error under a millimetre inside a UTM zone)
    n = (1 / rf) / (2 - 1 / rf); A = a / (1 + n) * (1 + n * n / 4 + n ** 4 / 64)
    be = (n / 2 - 2 * n * n / 3 + 37 * n ** 3 / 96, n * n / 48 + n ** 3 / 15, 17 * n ** 3 / 480)
    de = (2 * n - 2 * n * n / 3 - 2 * n ** 3, 7 * n * n / 3 - 8 * n ** 3 / 5, 56 * n ** 3 / 15)
    al = (n / 2 - 2 * n * n / 3 + 5 * n ** 3 / 16, 13 * n * n / 48 - 3 * n ** 3 / 5, 61 * n ** 3 / 240)

    def inv(x, y):
        xi, eta = (y - fn) / (k0 * A), (x - fe) / (k0 * A); xp, ep = xi, eta
        for j, b in enumerate(be, 1):
            xp -= b * math.sin(2 * j * xi) * math.cosh(2 * j * eta); ep -= b * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
        chi = math.asin(math.sin(xp) / math.cosh(ep)); lat = chi
        for j, d in enumerate(de, 1): lat += d * math.sin(2 * j * chi)
        return math.degrees(lon0 + math.atan2(math.sinh(ep), math.cos(xp))), math.degrees(lat)

    def fwd(lon, lat):                                         # only used to self-check the inverse
        ph, e2 = math.radians(lat), 2 * math.sqrt(n) / (1 + n)   # e2 is the eccentricity
        t = math.sinh(math.atanh(math.sin(ph)) - e2 * math.atanh(e2 * math.sin(ph))); dl = math.radians(lon) - lon0
        xi, eta = math.atan2(t, math.cos(dl)), math.atanh(math.sin(dl) / math.sqrt(1 + t * t)); x, y = eta, xi
        for j, c in enumerate(al, 1):
            y += c * math.sin(2 * j * xi) * math.cosh(2 * j * eta); x += c * math.cos(2 * j * xi) * math.sinh(2 * j * eta)
        return fe + k0 * A * x, fn + k0 * A * y
    for lo, la in ((-122.2, 37.8), (-122.06, 37.92), (-121.9, 38.05)):
        x, y = fwd(lo, la); lo2, la2 = inv(x, y)
        assert abs(lo - lo2) < 1e-8 and abs(la - la2) < 1e-8, 'projection round trip failed'
    # independent check: on the central meridian the northing must be k0 times the meridian arc, integrated here numerically
    e2sq = (2 - 1 / rf) / rf; ph = np.linspace(0, math.radians(38.0), 200001); m = a * (1 - e2sq) / (1 - e2sq * np.sin(ph) ** 2) ** 1.5
    arc = float(((m[:-1] + m[1:]) / 2 * np.diff(ph)).sum())
    assert abs(fwd(par['Central_Meridian'], 38.0)[1] - fn - k0 * arc) < 0.01, 'meridian arc check failed'
    return inv, f'{datum} Transverse Mercator, central meridian {par["Central_Meridian"]:g}'


# ---------------------------------------------------------------- shapefile + dbf, just the parts these files use
def read_shp(buf):
    """Yields (shape_type, parts) per record. parts is a list of rings or lines as [(x, y), ...]; a point is one part of one vertex."""
    pos = 100
    while pos < len(buf):
        clen = struct.unpack('>i', buf[pos + 4:pos + 8])[0] * 2; rec = buf[pos + 8:pos + 8 + clen]; pos += 8 + clen
        st = struct.unpack('<i', rec[:4])[0]
        if st == 0: yield 0, []
        elif st in (1, 11, 21): yield st, [[struct.unpack('<2d', rec[4:20])]]
        elif st in (3, 5, 13, 15, 23, 25):
            npart, npt = struct.unpack('<2i', rec[36:44]); idx = list(struct.unpack(f'<{npart}i', rec[44:44 + 4 * npart])) + [npt]
            xy = np.frombuffer(rec, '<f8', npt * 2, 44 + 4 * npart).reshape(npt, 2)      # Z and M arrays follow and are not needed
            yield st, [xy[idx[k]:idx[k + 1]] for k in range(npart)]
        else: sys.exit(f'shape type {st} is not handled')


def read_dbf(buf):
    nrec, hlen, rlen = struct.unpack('<IHH', buf[4:12]); flds, o = [], 32
    while buf[o] != 0x0D:
        flds.append((buf[o:o + 11].split(b'\0')[0].decode(), buf[o + 16])); o += 32
    out = []
    for k in range(nrec):
        rec, p, row = buf[hlen + k * rlen:hlen + (k + 1) * rlen], 1, {}
        for name, ln in flds: row[name] = rec[p:p + ln].decode('latin-1').strip(); p += ln
        out.append(row)
    return out


def layer(zipname):
    z = zipfile.ZipFile(os.path.join(RAW, zipname)); names = {n.lower().rsplit('.', 1)[-1]: n for n in z.namelist() if n.count('.') == 1}
    inv, crs = prj_inverse(z.read(names['prj']).decode().strip())
    shapes, rows = list(read_shp(z.read(names['shp']))), read_dbf(z.read(names['dbf']))
    assert len(shapes) == len(rows), zipname
    print(f'{zipname}: {len(shapes)} features, {crs}; fields {list(rows[0])}')
    return shapes, rows, inv, crs


inbox = lambda lo, la: W <= lo <= E and S <= la <= N
r5 = lambda v: round(v, 5)


def ring_area_centroid(xy):                                   # shoelace, metres
    x, y = xy[:, 0] - xy[0, 0], xy[:, 1] - xy[0, 1]; c = x[:-1] * y[1:] - x[1:] * y[:-1]; a = c.sum() / 2
    if abs(a) < 1e-9: return 0.0, xy[:, 0].mean(), xy[:, 1].mean()
    return a, xy[0, 0] + ((x[:-1] + x[1:]) * c).sum() / (6 * a), xy[0, 1] + ((y[:-1] + y[1:]) * c).sum() / (6 * a)


def long_axis(xy):                                            # the two vertices farthest apart: the slide's length and line of travel
    p = xy[::max(1, len(xy) // 240)]; d = ((p[:, None, :] - p[None, :, :]) ** 2).sum(2); i, j = np.unravel_index(d.argmax(), d.shape)
    return p[i], p[j], math.sqrt(d[i, j])


def clip_ring(ring, pad=0.0):                                 # Sutherland-Hodgman against the box, in lon/lat
    def cut(pts, inside, cross):
        out = []
        for a, b in zip(pts, pts[1:] + pts[:1]):
            ia, ib = inside(a), inside(b)
            if ia: out.append(a)
            if ia != ib: out.append(cross(a, b))
        return out
    w, s, e, n = W - pad, S - pad, E + pad, N + pad; pts = [tuple(p) for p in ring]
    atx = lambda x: (lambda a, b: (x, a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0])))
    aty = lambda y: (lambda a, b: (a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]), y))
    for inside, cross in ((lambda p: p[0] >= w, atx(w)), (lambda p: p[0] <= e, atx(e)), (lambda p: p[1] >= s, aty(s)), (lambda p: p[1] <= n, aty(n))):
        if pts: pts = cut(pts, inside, cross)
    return pts


def thin(pts, tol_m):                                         # drop vertices closer than tol_m to the last one kept
    out = [pts[0]]
    for p in pts[1:-1]:
        if math.hypot((p[0] - out[-1][0]) * KX, (p[1] - out[-1][1]) * KY) >= tol_m: out.append(p)
    return out + [pts[-1]] if len(pts) > 1 else out


def main():
    fetch()
    meta = dict(bbox=[W, S, E, N], built=__import__('datetime').date.today().isoformat())

    # ---------------- January 2023 reconnaissance inventory: points
    rows = list(csv.DictReader(open(os.path.join(RAW, list(FILES)[0]), encoding='utf-8-sig')))
    print('2023 inventory columns:', list(rows[0]))
    p23 = []
    for r in rows:
        lo, la = float(r['POINT_X']), float(r['POINT_Y'])      # the FGDC metadata gives these as decimal degrees on WGS84
        if not inbox(lo, la): continue
        date = r['Reported_LS_Date_Time_PST'].strip()
        p23.append(dict(id=int(r['ID']), lon=r5(lo), lat=r5(la), type=r['RoadCut_or_HillSlope'].strip(), impact=r['Impact'].strip(), reported_pst=date,
                        info_source=r['Info_Source'].strip(), description=r['Observer_Description'].strip()))
    print(f'2023 inventory: {len(rows)} points in the whole Bay Area, {len(p23)} inside the box')
    if len(p23) < 20: print('  -> under 20 inside the box: a spot check, not a validation')
    with open(os.path.join(ROOT, DS, 'usgs_landslides_2023.csv'), 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['id', 'lon', 'lat', 'type', 'impact', 'reported_pst', 'info_source', 'description']); w.writeheader(); w.writerows(p23)

    # ---------------- January 2023: routes the USGS crews travelled (where they could have seen a slide)
    shapes, _, inv, crs_t = layer(list(FILES)[1]); travel, km_all, km_in = [], 0.0, 0.0
    for st, parts in shapes:
        for part in parts:
            ll = [inv(x, y) for x, y in part]; run = []
            for a, b in zip(ll, ll[1:]):
                d = math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY) / 1000; km_all += d
                if inbox(*a) and inbox(*b): km_in += d
            for p in ll + [None]:                              # keep the runs of vertices that lie inside the box
                if p is not None and inbox(*p): run.append((r5(p[0]), r5(p[1])))
                else:
                    if len(run) > 1: travel.append(thin(run, 12))
                    run = []
    print(f'2023 travel lines: {km_all:.0f} km in the whole Bay Area, {km_in:.1f} km inside the box in {len(travel)} pieces')

    # ---------------- 2016-17 storm season: mapped polygons (source + runout), with the separate source areas where mapped
    shapes, rows, inv, crs17 = layer(list(FILES)[2]); s_shapes, s_rows, _, _ = layer(list(FILES)[3])
    src_area = {r['LS_ID']: float(r['Area_m2']) for r in s_rows}
    flags = {k: sorted({r[k] for r in rows}) for k in ('SA', 'Affects_In')}; print('  flag values', flags)
    s17 = []
    for (st, parts), r in zip(shapes, rows):
        if not parts: continue
        ring = max(parts, key=len); a, cx, cy = ring_area_centroid(ring); lo, la = inv(cx, cy)
        if not inbox(lo, la): continue
        p0, p1, ln = long_axis(ring); a0, a1 = inv(*p0), inv(*p1)
        s17.append(dict(ls_id=r['LS_ID'], lon=r5(lo), lat=r5(la), area_m2=round(float(r['Area_m2']), 1), perimeter_m=round(float(r['Perim_m']), 1), length_m=round(ln, 1),
                        axis_lon0=r5(a0[0]), axis_lat0=r5(a0[1]), axis_lon1=r5(a1[0]), axis_lat1=r5(a1[1]),
                        source_area_m2=round(src_area[r['LS_ID']], 1) if r['LS_ID'] in src_area else '', has_source_polygon=int(bool(r['SA'])), affects_infrastructure=int(bool(r['Affects_In']))))
        assert abs(abs(a) - float(r['Area_m2'])) < max(2.0, 0.02 * abs(a)) or len(parts) > 1, ('area mismatch', r['LS_ID'], a, r['Area_m2'])   # the projected coordinates give the published areas, so the units are metres
    print(f'2016-17 inventory: {len(rows)} polygons in the whole map area, {len(s17)} with their centroid inside the box')
    if len(s17) < 20: print('  -> under 20 inside the box: a spot check, not a validation')
    with open(os.path.join(ROOT, DS, 'usgs_landslides_2016_17.csv'), 'w', newline='') as fh:
        w = csv.DictWriter(fh, fieldnames=['ls_id', 'lon', 'lat', 'area_m2', 'perimeter_m', 'length_m', 'axis_lon0', 'axis_lat0', 'axis_lon1', 'axis_lat1',
                                           'source_area_m2', 'has_source_polygon', 'affects_infrastructure']); w.writeheader(); w.writerows(s17)   # San Francisco lies outside the 2016-17 map: header only

    # ---------------- 2016-17: the boundary of what was mapped, so roads outside it are never counted as "no slide"
    shapes, brows, inv, _ = layer(list(FILES)[4]); bound = []
    for (st, parts), r in zip(shapes, brows):
        for part in parts:
            ring = clip_ring([inv(x, y) for x, y in part], 0.002)
            if len(ring) >= 3: bound.append(dict(name=r['Name'], ring=[[r5(x), r5(y)] for x, y in thin(ring, 25)]))
    print('2016-17 mapped-area pieces touching the box:', [(b['name'], len(b['ring'])) for b in bound])

    meta.update(
        y2023=dict(title='San Francisco Bay Area Reconnaissance Landslide Inventory, January 2023', doi='10.5066/P9NJ3KMG', total=len(rows) and len(list(csv.DictReader(open(os.path.join(RAW, list(FILES)[0]), encoding='utf-8-sig')))), inside=len(p23),
                   window='slides triggered Dec 31, 2022 to Jan 18, 2023', travel_km_inside=round(km_in, 1), travel_km_total=round(km_all),
                   caveat='Not a complete inventory: USGS says it reports observations made with limited staff and time while roads were closed.'),
        y2017=dict(title='Mapped polygons of landslides triggered by the 2016-2017 storm season, eastern San Francisco Bay region', doi='10.5066/P98MVEGI', map='USGS SIM 3503', total=len(rows), inside=len(s17), crs=crs17,
                   caveat='Mapped by hand from 0.25 m satellite imagery of March 11, 2017. No date per slide. Slides under tree cover or already repaired can be missing.'))
    js = dict(meta=meta,
              p23=[[p['lon'], p['lat'], p['id'], p['type'], p['impact'], p['reported_pst'], p['info_source'], p['description']] for p in p23],
              travel23=travel,
              # per 2016-17 slide: centroid lon, lat, area m2, length m, the two ends of its long axis, affects infrastructure 0/1
              s17=[[s['lon'], s['lat'], round(s['area_m2']), round(s['length_m']), s['axis_lon0'], s['axis_lat0'], s['axis_lon1'], s['axis_lat1'], s['affects_infrastructure']] for s in s17],
              bound17=bound)
    out = os.path.join(ROOT, 'site', SITE, 'usgs_inventory.js')
    open(out, 'w').write('/* Generated by scripts/10_usgs_inventory.py from USGS data releases 10.5066/P9NJ3KMG and 10.5066/P98MVEGI (public domain). Do not edit. */\nwindow.GT_USGS=' + json.dumps(js, separators=(',', ':')) + ';\n')
    print('wrote', out, os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    main()
