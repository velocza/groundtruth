"""3D map data pull: REAL building footprint polygons (with heights where mapped), road centre lines, water, parks and place names
from Overture Maps (AWS open data), for both areas in one pass. Writes <workdir>/map3d_raw_<area>.json."""
import sys, re, json, urllib.request, time, os
import pyarrow.fs as pafs, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor
from shapely import wkb
OUT = sys.argv[1]
AREAS = {"lamorinda": (-122.215, -122.055, 37.805, 37.925), "sf": (-122.520, -122.360, 37.705, 37.825)}   # W, E, S, N
d = urllib.request.urlopen("https://overturemaps-us-west-2.s3.amazonaws.com/?delimiter=/&prefix=release/").read().decode()
rel = re.findall(r"<Prefix>(release/[^<]+)</Prefix>", d)[-1]; print(rel, flush=True)
open(f"{OUT}/overture_release_map3d.txt", "w").write(rel)
fs = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=os.environ.get("HTTPS_PROXY") or None)
def hit(b, a): return b["xmin"] < a[1] and b["xmax"] > a[0] and b["ymin"] < a[3] and b["ymax"] > a[2]
def scan(theme, typ, cols, fn):
    base = f"overturemaps-us-west-2/{rel}theme={theme}/type={typ}/"
    files = [f.path for f in fs.get_file_info(pafs.FileSelector(base)) if f.path.endswith(".parquet")]
    print(theme, typ, len(files), "files", flush=True)
    def one(f):
        err = None
        for attempt in range(4):
            try:
                pf = pq.ParquetFile(fs.open_input_file(f)); md = pf.metadata
                names = [md.schema.column(j).path for j in range(md.num_columns)]
                have = set(pf.schema_arrow.names); use = [c for c in cols if c in have]
                ix = {k: names.index(f"bbox.{k}") for k in ("xmin", "xmax", "ymin", "ymax")}
                out = {k: [] for k in AREAS}
                for rg in range(md.num_row_groups):
                    g = md.row_group(rg); st = {k: g.column(v).statistics for k, v in ix.items()}
                    sb = {"xmin": st["xmin"].min, "xmax": st["xmax"].max, "ymin": st["ymin"].min, "ymax": st["ymax"].max}
                    if not any(hit(sb, a) for a in AREAS.values()): continue
                    for r in pf.read_row_group(rg, columns=use + ["geometry", "bbox"]).to_pylist():
                        for k, a in AREAS.items():
                            if hit(r["bbox"], a):
                                x = fn(r)
                                if x: out[k].append(x)
                return out
            except Exception as e: err = e; time.sleep(2)
        print("ERR", f, str(err)[:80], flush=True); return {k: [] for k in AREAS}
    rows = {k: [] for k in AREAS}
    with ThreadPoolExecutor(8) as ex:
        for out in ex.map(one, files):
            for k in AREAS: rows[k] += out[k]
    return rows
R5 = lambda cs: [[round(x, 6), round(y, 6)] for x, y, *_ in cs]
def polys(g):
    if g.geom_type == "Polygon": return [g]
    if g.geom_type == "MultiPolygon": return list(g.geoms)
    return []
def bld(r):
    g = wkb.loads(r["geometry"]); out = [R5(p.exterior.coords) for p in polys(g) if not p.is_empty]
    if out: return {"p": out, "h": r.get("height"), "f": r.get("num_floors"), "c": r.get("class"), "u": r.get("has_parts")}
def part(r):
    g = wkb.loads(r["geometry"]); out = [R5(p.exterior.coords) for p in polys(g) if not p.is_empty]
    if out: return {"p": out, "h": r.get("height"), "f": r.get("num_floors"), "m": r.get("min_height")}
def road(r):
    if r.get("subtype") not in ("road", "rail"): return
    g = wkb.loads(r["geometry"])
    if g.geom_type != "LineString": return
    fl = r.get("road_flags") or []
    return {"n": (r.get("names") or {}).get("primary"), "c": r.get("class"), "s": r.get("subtype"), "l": R5(g.coords),
            "t": any("is_tunnel" in (x.get("values") or []) for x in fl), "b": any("is_bridge" in (x.get("values") or []) for x in fl)}
def area(r):
    g = wkb.loads(r["geometry"]); n = (r.get("names") or {}).get("primary")
    if g.geom_type == "LineString": return {"n": n, "s": r.get("subtype"), "c": r.get("class"), "l": R5(g.coords)}
    out = [[R5(p.exterior.coords)] + [R5(i.coords) for i in p.interiors] for p in polys(g) if not p.is_empty]
    if out: return {"n": n, "s": r.get("subtype"), "c": r.get("class"), "p": out}
def place(r):
    g = wkb.loads(r["geometry"]); n = (r.get("names") or {}).get("primary")
    if n and g.geom_type == "Point": return {"n": n, "s": r.get("subtype"), "c": r.get("class"), "pop": r.get("population"), "xy": [round(g.x, 6), round(g.y, 6)]}
t = time.time(); res = {k: {} for k in AREAS}
for key, args in [("water", ("base", "water", ["names", "subtype", "class"], area)), ("landuse", ("base", "land_use", ["names", "subtype", "class"], area)),
                  ("places", ("divisions", "division", ["names", "subtype", "class", "population"], place)),
                  ("roads", ("transportation", "segment", ["names", "class", "subtype", "road_flags"], road)),
                  ("parts", ("buildings", "building_part", ["height", "num_floors", "min_height"], part)),
                  ("buildings", ("buildings", "building", ["height", "num_floors", "class", "has_parts"], bld))]:
    rows = scan(*args)
    for k in AREAS: res[k][key] = rows[k]; print(key, k, len(rows[k]), round(time.time() - t), flush=True)
for k in AREAS: json.dump(res[k], open(f"{OUT}/map3d_raw_{k}.json", "w"))
print("done", round(time.time() - t), "s")
