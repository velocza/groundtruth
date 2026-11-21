"""GroundTruth data pull, part 4: REAL Census data for the "Neighbors helping neighbors" view.

American Community Survey 5-year estimates (with margins of error) for the Contra Costa County block groups that touch the
study box, the TIGERweb block group shapes of the same vintage, and the block group of every building in
dataset/buildings_lamorinda.csv. Standard library and numpy only. The site never calls the Census: everything it needs is
written to site/data/census_bg.js.

  python3 scripts/09_census.py            build from the raw files kept in dataset/census_raw (no network needed)
  python3 scripts/09_census.py --refresh  download everything again, then build

Estimates come from one of two places, and both hold the same published numbers:
  1. api.census.gov, when the environment variable CENSUS_API_KEY is set. The API refuses data requests without a key.
     The key is read from the environment only and is never written anywhere.
  2. otherwise the ACS table-based Summary File on www2.census.gov, which needs no key. Each table is one large file sorted by
     GEO_ID, so the rows wanted are found by bisection with HTTP range requests (about 35 small requests per table).
Variable IDs are checked against the labels the API publishes (groups/<table>.json, no key needed) before anything is used.
"""
import base64, csv, json, math, os, sys, time, urllib.parse, urllib.request
import numpy as np

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = f"{root}/dataset/census_raw"
VINTAGE = 2024                                            # ACS 5-year release covering 2020 to 2024, the latest on api.census.gov
STATE, COUNTY = "06", "013"                               # California, Contra Costa County
W, S, E, N, NX, NY = -122.215, 37.805, -122.055, 37.925, 480, 456
MX, MY = 87800.0, 110950.0                                # metres per degree of longitude and latitude at this latitude, as in 06_fetch_buildings.py
RES_MIN, RES_MAX = 60, 1500                               # footprint m2 counted as residential-sized: smaller is a shed or garage, larger a school, store or church
SNAP_M = 25                                               # a building in no shape (simplified shared edges leave slivers) joins the nearest one within this distance
API = f"https://api.census.gov/data/{VINTAGE}/acs/acs5"
SF = f"https://www2.census.gov/programs-surveys/acs/summary_file/{VINTAGE}/table-based-SF/data/5YRData/acsdt5y{VINTAGE}-%s.dat"
TIGER = f"https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_ACS{VINTAGE}/MapServer/10/query"   # layer 10: Census Block Groups

# table -> {variable number: the label the API must show for it, after "Estimate!!Total:"}. A mismatch stops the build.
TABLES = {
    "B25044": {1: "", 3: "Owner occupied:!!No vehicle available", 10: "Renter occupied:!!No vehicle available"},
    "B01001": {1: "", 20: "Male:!!65 and 66 years", 21: "Male:!!67 to 69 years", 22: "Male:!!70 to 74 years", 23: "Male:!!75 to 79 years", 24: "Male:!!80 to 84 years", 25: "Male:!!85 years and over",
               44: "Female:!!65 and 66 years", 45: "Female:!!67 to 69 years", 46: "Female:!!70 to 74 years", 47: "Female:!!75 to 79 years", 48: "Female:!!80 to 84 years", 49: "Female:!!85 years and over"},
    "B11007": {1: "", 2: "Households with one or more people 65 years and over:", 3: "Households with one or more people 65 years and over:!!1-person household"},
    "B25009": {1: "", 3: "Owner occupied:!!1-person household", 4: "Owner occupied:!!2-person household", 5: "Owner occupied:!!3-person household", 6: "Owner occupied:!!4-person household",
               7: "Owner occupied:!!5-person household", 8: "Owner occupied:!!6-person household", 9: "Owner occupied:!!7-or-more person household",
               11: "Renter occupied:!!1-person household", 12: "Renter occupied:!!2-person household", 13: "Renter occupied:!!3-person household", 14: "Renter occupied:!!4-person household",
               15: "Renter occupied:!!5-person household", 16: "Renter occupied:!!6-person household", 17: "Renter occupied:!!7-or-more person household"},
    "C21007": {1: "", **{n: None for n in (5, 8, 12, 15, 20, 23, 27, 30)}},     # None: the label must end in "!!With a disability"
}
CONCEPTS = {"B25044": "Tenure by Vehicles Available", "B01001": "Sex by Age", "B11007": "Households by Presence of People 65 Years and Over, Household Size and Household Type",
            "B25009": "Tenure by Household Size", "C21007": "Age by Veteran Status by Poverty Status in the Past 12 Months by Disability Status for the Civilian Population 18 Years and Over"}
var = lambda t, n: f"{t}_{n:03d}E"


def get(url, headers=None, tries=4):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "groundtruth-build", **(headers or {})}), timeout=60) as r:
                return r.status, dict(r.headers), r.read()
        except Exception as e:
            err = e; time.sleep(2 ** k)
    raise SystemExit(f"could not fetch {url.split('?')[0]}: {err}")


def fetch_labels():
    out = {}
    for t in TABLES:
        v = json.loads(get(f"{API}/groups/{t}.json")[2])["variables"]
        out[t] = {"concept": v[var(t, 1)]["concept"], "vars": {var(t, n): v[var(t, n)]["label"].replace("Estimate!!Total:", "", 1).lstrip("!") for n in TABLES[t]}}
    return out


def check_labels(lab):
    for t, want in TABLES.items():
        if lab[t]["concept"] != CONCEPTS[t]: raise SystemExit(f"{t}: the API calls this table '{lab[t]['concept']}', expected '{CONCEPTS[t]}'")
        for n, w in want.items():
            got = lab[t]["vars"][var(t, n)]
            if (got != w) if w is not None else (not got.endswith("!!With a disability")): raise SystemExit(f"{var(t, n)}: the API label is '{got}', expected '{w or '...With a disability'}'")
    print("variable IDs match the API labels:", ", ".join(f"{t} ({len(v)})" for t, v in TABLES.items()))


def num(s):                                               # Census jam values are large negatives: -555555555 means the estimate is controlled and has no sampling error
    try: v = float(s)
    except (TypeError, ValueError): return 0.0
    return 0.0 if v < 0 else v


def fetch_acs_api(key, geos):
    """geos: GEO_IDs such as 1500000US060133540022. Returns {table: {geo: [[estimate, moe], ...]}} in TABLES order."""
    out = {}
    for t, want in TABLES.items():
        cols = [c for n in want for c in (f"{t}_{n:03d}E", f"{t}_{n:03d}M")]
        out[t] = {}
        for where in (f"for=block%20group:*&in=state:{STATE}%20county:{COUNTY}%20tract:*", f"for=county:{COUNTY}&in=state:{STATE}"):
            rows = json.loads(get(f"{API}?get=GEO_ID,{','.join(cols)}&{where}&key={urllib.parse.quote(key)}")[2])
            head = rows[0]
            for r in rows[1:]:
                d = dict(zip(head, r))
                if d["GEO_ID"] in geos: out[t][d["GEO_ID"]] = [[num(d[f"{t}_{n:03d}E"]), num(d[f"{t}_{n:03d}M"])] for n in want]
    return out


def sf_rows(url, prefix, read=None):
    """All lines of a GEO_ID-sorted Summary File whose GEO_ID starts with prefix, plus the header, using range requests only."""
    if read is None:
        size = int(urllib.request.urlopen(urllib.request.Request(url, method="HEAD", headers={"User-Agent": "groundtruth-build"}), timeout=60).headers["Content-Length"])
        def read(a, b):
            st, _, body = get(url, {"Range": f"bytes={a}-{min(b, size - 1)}"})
            if st != 206: raise SystemExit(f"{url}: the server ignored the range request (status {st})")
            return body.decode("utf-8", "replace")
    else:
        size = read.size                                  # tests pass their own reader
    header = read(0, 8191).split("\n")[0].rstrip("\r").split("|")
    def key_after(off):                                   # GEO_ID of the first whole line that starts after byte off
        t = read(off, off + 8191); rest = t[t.index("\n") + 1:] if "\n" in t else ""
        return rest[:rest.index("|")] if "|" in rest else "\uffff"
    lo, hi = 0, size
    while hi - lo > 4096:
        mid = (lo + hi) // 2
        if key_after(mid) < prefix: lo = mid
        else: hi = mid
    rows, buf, off, first, done = [], "", lo, True, False
    while not done and off < size:
        buf += read(off, off + 262143); off += 262144
        lines = buf.split("\n"); buf = lines.pop()
        if first: lines.pop(0)                            # the header, or the tail of a line the bisection landed inside
        first = False
        for ln in lines:
            k = ln[:ln.index("|")] if "|" in ln else ""
            if k < prefix: continue
            if not k.startswith(prefix): done = True; break
            rows.append(ln.rstrip("\r").split("|"))
    if not done and buf.startswith(prefix): rows.append(buf.rstrip("\r").split("|"))
    return header, rows


def fetch_acs_sf(geos):
    out = {}
    for t, want in TABLES.items():
        out[t] = {}
        for prefix in (f"0500000US{STATE}{COUNTY}", f"1500000US{STATE}{COUNTY}"):
            head, rows = sf_rows(SF % t.lower(), prefix)
            ix = {n: (head.index(f"{t}_E{n:03d}"), head.index(f"{t}_M{n:03d}")) for n in want}
            for r in rows:
                if r[0] in geos: out[t][r[0]] = [[num(r[ix[n][0]]), num(r[ix[n][1]])] for n in want]
        print(t, len(out[t]), "rows from the Summary File", flush=True)
    return out


def fetch_tiger():
    q = urllib.parse.urlencode({"where": f"STATE='{STATE}' AND COUNTY='{COUNTY}'", "geometry": f"{W},{S},{E},{N}", "geometryType": "esriGeometryEnvelope", "inSR": "4326",
                                "spatialRel": "esriSpatialRelIntersects", "outFields": "GEOID,AREALAND,AREAWATER,INTPTLAT,INTPTLON", "outSR": "4326", "geometryPrecision": "5",
                                "maxAllowableOffset": "0.00002", "returnGeometry": "true", "f": "geojson"})      # shapes simplified to about 2 m by the server
    out = {}
    for f in json.loads(get(f"{TIGER}?{q}")[2])["features"]:
        p, g = f["properties"], f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        out[p["GEOID"]] = {"aland": int(p["AREALAND"]), "awater": int(p["AREAWATER"]), "intpt": [float(p["INTPTLON"]), float(p["INTPTLAT"])], "rings": [[[round(x, 5), round(y, 5)] for x, y in ring] for poly in polys for ring in poly]}
    return out


def load_raw(refresh):
    os.makedirs(RAW, exist_ok=True)
    paths = {k: f"{RAW}/{k}" for k in ("labels.json", f"tiger{VINTAGE}_bg.json", f"acs5_{VINTAGE}.json")}
    if refresh or not all(os.path.exists(p) for p in paths.values()):
        lab = fetch_labels(); check_labels(lab)
        shapes = fetch_tiger(); geos = {f"1500000US{g}" for g in shapes} | {f"0500000US{STATE}{COUNTY}"}
        key = os.environ.get("CENSUS_API_KEY")
        acs = {"vintage": VINTAGE, "source": "api.census.gov" if key else "ACS table-based Summary File, www2.census.gov", "fetched": time.strftime("%Y-%m-%d"),
               "columns": {t: [var(t, n) for n in w] for t, w in TABLES.items()}, "tables": fetch_acs_api(key, geos) if key else fetch_acs_sf(geos)}
        for k, v in zip(paths, (lab, shapes, acs)): json.dump(v, open(paths[k], "w"), separators=(",", ":"))
    lab, shapes, acs = (json.load(open(p)) for p in paths.values())
    check_labels(lab)
    if acs["vintage"] != VINTAGE: raise SystemExit("dataset/census_raw holds another vintage; run with --refresh")
    return lab, shapes, acs


# ------------------------------------------------------------------ geometry
def inside(rings, x, y):
    """Even-odd test of points (arrays, degrees) against a list of rings, so holes need no special case."""
    hit = np.zeros(x.shape, bool)
    for ring in rings:
        r = np.asarray(ring)
        for (x0, y0), (x1, y1) in zip(r[:-1], r[1:]):
            if y0 == y1: continue
            c = ((y0 > y) != (y1 > y)) & (x < (x1 - x0) * (y - y0) / (y1 - y0) + x0)
            hit ^= c
    return hit


def edge_dist(rings, x, y):
    """Distance in metres from points to the nearest ring edge."""
    best = np.full(x.shape, 1e12)
    for ring in rings:
        r = np.asarray(ring); ax, ay = r[:-1, 0] * MX, r[:-1, 1] * MY; bx, by = r[1:, 0] * MX, r[1:, 1] * MY
        px, py = x[:, None] * MX, y[:, None] * MY; dx, dy = bx - ax, by - ay
        t = np.clip(((px - ax) * dx + (py - ay) * dy) / np.maximum(dx * dx + dy * dy, 1e-9), 0, 1)
        best = np.minimum(best, np.hypot(px - (ax + t * dx), py - (ay + t * dy)).min(axis=1))
    return best


def ring_area(ring):
    r = np.asarray(ring); x, y = r[:, 0] * MX, r[:, 1] * MY
    return abs(float(np.sum(x[:-1] * y[1:] - x[1:] * y[:-1]))) / 2


def clip_box(ring):
    """Sutherland-Hodgman clip of one ring to the study box."""
    pts = [tuple(p) for p in ring[:-1]]
    for axis, lim, keep_less in ((0, W, False), (0, E, True), (1, S, False), (1, N, True)):
        ok = (lambda p: p[axis] <= lim) if keep_less else (lambda p: p[axis] >= lim)
        out = []
        for i, p in enumerate(pts):
            q = pts[i - 1]
            if ok(p) != ok(q):
                t = (lim - q[axis]) / (p[axis] - q[axis]); out.append((q[0] + t * (p[0] - q[0]), q[1] + t * (p[1] - q[1])))
            if ok(p): out.append(p)
        pts = out
        if not pts: return []
    return pts + [pts[0]]


def share_in_box(rings):
    """Share of the shape's area that lies inside the study box. Ring 0 is the outline; any others are holes (true for every shape here)."""
    full = ring_area(rings[0]) - sum(ring_area(r) for r in rings[1:])
    part = sum((1 if k == 0 else -1) * (ring_area(c) if (c := clip_box(r)) else 0) for k, r in enumerate(rings))
    return max(0.0, min(1.0, part / full)) if full > 0 else 0.0


def rss(ms): return math.sqrt(sum(m * m for m in ms))     # Census rule for the margin of error of a sum of estimates


def main():
    lab, shapes, acs = load_raw("--refresh" in sys.argv)
    ids = sorted(shapes)
    T = acs["tables"]; pos = {t: {n: k for k, n in enumerate(w)} for t, w in TABLES.items()}
    def val(t, geo, ns):                                  # [sum of estimates, margin of error of the sum]
        row = T[t][geo]; ps = [row[pos[t][n]] for n in ns]
        return [round(sum(p[0] for p in ps)), round(rss([p[1] for p in ps]))]
    def record(geo):
        sizes = [val("B25009", geo, (3 + k, 11 + k))[0] for k in range(7)]
        return {"hh": val("B25044", geo, (1,)), "nocar": val("B25044", geo, (3, 10)), "with65": val("B11007", geo, (2,)), "alone65": val("B11007", geo, (3,)),
                "pop": val("B01001", geo, (1,)), "age65": val("B01001", geo, (20, 21, 22, 23, 24, 25, 44, 45, 46, 47, 48, 49)), "age75": val("B01001", geo, (23, 24, 25, 47, 48, 49)),
                "adults": val("C21007", geo, (1,)), "dis18": val("C21007", geo, (5, 8, 12, 15, 20, 23, 27, 30)), "sizes": sizes}

    # buildings -> block group
    b = np.array([[float(r["lon"]), float(r["lat"]), float(r["footprint_m2"])] for r in csv.DictReader(open(f"{root}/dataset/buildings_lamorinda.csv"))])
    x, y, area = b[:, 0], b[:, 1], b[:, 2]
    bg = np.full(len(b), -1, np.int32)
    boxes = [np.asarray(shapes[g]["rings"][0]) for g in ids]
    for k, g in enumerate(ids):
        r = boxes[k]; m = (bg < 0) & (x >= r[:, 0].min()) & (x <= r[:, 0].max()) & (y >= r[:, 1].min()) & (y <= r[:, 1].max())
        idx = np.flatnonzero(m); bg[idx[inside(shapes[g]["rings"], x[idx], y[idx])]] = k
    loose = np.flatnonzero(bg < 0); snapped = 0
    if len(loose):
        d = np.stack([edge_dist(shapes[g]["rings"], x[loose], y[loose]) for g in ids]); near = d.argmin(axis=0); ok = d.min(axis=0) <= SNAP_M
        bg[loose[ok]] = near[ok]; snapped = int(ok.sum())
    res = (area >= RES_MIN) & (area <= RES_MAX) & (bg >= 0)

    # grid cell -> block group, for clicks on the map
    cx = W + (np.arange(NX) + 0.5) * (E - W) / NX; cy = N - (np.arange(NY) + 0.5) * (N - S) / NY
    gx, gy = np.meshgrid(cx, cy); gx, gy = gx.ravel(), gy.ravel(); cell = np.full(NX * NY, 255, np.uint8)
    for k, g in enumerate(ids):
        r = boxes[k]; idx = np.flatnonzero((cell == 255) & (gx >= r[:, 0].min()) & (gx <= r[:, 0].max()) & (gy >= r[:, 1].min()) & (gy <= r[:, 1].max()))
        cell[idx[inside(shapes[g]["rings"], gx[idx], gy[idx])]] = k
    runs = bytearray(); i = 0
    while i < len(cell):
        j = i
        while j < len(cell) and cell[j] == cell[i] and j - i < 65535: j += 1
        runs += bytes([int(cell[i]), (j - i) & 255, (j - i) >> 8]); i = j

    rows = []
    for k, g in enumerate(ids):
        m = res & (bg == k); rec = record(f"1500000US{g}"); frac = share_in_box(shapes[g]["rings"])
        lon, lat = (float(x[m].mean()), float(y[m].mean())) if m.any() else shapes[g]["intpt"]
        rows.append({"id": g, "tract": f"{int(g[5:9])}.{g[9:11]}", "group": g[11], "frac": round(frac, 4), "n": int(m.sum()), "area": int(area[m].sum()), "lon": round(lon, 5), "lat": round(lat, 5), **rec})
    county = record(f"0500000US{STATE}{COUNTY}")

    # packed residential-sized buildings: uint16 x, y (box = 0..65535), uint16 footprint m2, uint8 block group
    keep = np.flatnonzero(res)
    qx = np.round((x[keep] - W) / (E - W) * 65535).astype("<u2"); qy = np.round((y[keep] - S) / (N - S) * 65535).astype("<u2")
    pack = qx.tobytes() + qy.tobytes() + np.round(area[keep]).astype("<u2").tobytes() + bg[keep].astype(np.uint8).tobytes()

    meta = {"vintage": f"American Community Survey {VINTAGE - 4} to {VINTAGE} 5-year estimates", "year": VINTAGE, "source": acs["source"], "fetched": acs["fetched"],
            "shapes": f"TIGERweb ACS {VINTAGE} block groups (boundaries of January 1, {VINTAGE}), simplified to about 2 m", "county": "Contra Costa County, California (06013)",
            "moe": "margins of error are the published 90% margins; sums use the root sum of squares", "res_m2": [RES_MIN, RES_MAX], "bbox": [W, S, E, N], "grid": [NX, NY],
            "tables": {t: {"concept": lab[t]["concept"], "vars": [var(t, n) for n in TABLES[t]]} for t in TABLES},
            "buildings": {"all": int(len(b)), "packed": int(len(keep)), "no_block_group": int((bg < 0).sum()), "outside_size_range": int(((bg >= 0) & ~res).sum())},
            "county_totals": {"hh": county["hh"], "nocar": county["nocar"], "alone65": county["alone65"]}}
    out = {"meta": meta, "bg": rows, "cells": base64.b64encode(bytes(runs)).decode(), "bld": base64.b64encode(pack).decode()}
    open(f"{root}/site/data/census_bg.js", "w").write("window.GT_CENSUS=" + json.dumps(out, separators=(",", ":")) + ";\n")

    with open(f"{root}/dataset/census_block_groups_lamorinda.csv", "w", newline="") as fh:
        w = csv.writer(fh); keys = ["hh", "nocar", "with65", "alone65", "pop", "age65", "age75", "adults", "dis18"]
        w.writerow(["geoid", "tract", "block_group", "share_of_area_in_box", "residential_sized_buildings_in_box"] + [c for k in keys for c in (k, k + "_moe")] + [f"hh_size_{n}" for n in "1234567"])
        for r in rows: w.writerow([r["id"], r["tract"], r["group"], r["frac"], r["n"]] + [v for k in keys for v in r[k]] + r["sizes"])
    with open(f"{root}/dataset/buildings_block_group.csv", "w", newline="") as fh:
        w = csv.writer(fh); w.writerow(["lon", "lat", "footprint_m2", "block_group_geoid", "residential_sized"])
        for k in range(len(b)): w.writerow([f"{x[k]:.5f}", f"{y[k]:.5f}", int(area[k]), ids[bg[k]] if bg[k] >= 0 else "", int(res[k])])

    # sanity checks
    hh_box = sum(r["hh"][0] * r["frac"] for r in rows if r["n"]); nocar_box = sum(r["nocar"][0] * r["frac"] for r in rows if r["n"])
    print(len(ids), "block groups;", int((bg >= 0).sum()), "of", len(b), "buildings assigned,", snapped, "by snapping,", int((bg < 0).sum()), "in no Contra Costa block group;", len(keep), "residential-sized")
    print(f"households in the box (estimate x share of area in the box): {hh_box:,.0f}; residential-sized buildings: {len(keep):,}; households per building {hh_box / len(keep):.2f}")
    print(f"no-vehicle households, box {nocar_box / hh_box:.1%}; county {county['nocar'][0] / county['hh'][0]:.1%} ({county['nocar'][0]:,} of {county['hh'][0]:,}, margin {county['nocar'][1]:,})")
    for r in rows:
        if r["n"] == 0 and r["hh"][0] * r["frac"] >= 20: print("  note:", r["id"], "has no residential-sized building in the box but about", round(r["hh"][0] * r["frac"]), "households by area share")
    print("census_bg.js bytes", os.path.getsize(f"{root}/site/data/census_bg.js"))


if __name__ == "__main__":
    main()
