"""SF data pull, part 2: REAL streets and building footprints from Overture Maps (AWS open data).
Writes roads_raw.json and buildings_raw.json ([lon, lat, area_m2, height_m or null]) into <workdir>."""
import sys, re, json, urllib.request, time, os, math
import pyarrow.fs as pafs, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor
from shapely import wkb
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from region import W, E, S, N
OUT = sys.argv[1]
d = urllib.request.urlopen("https://overturemaps-us-west-2.s3.amazonaws.com/?delimiter=/&prefix=release/").read().decode()
rel = re.findall(r"<Prefix>(release/[^<]+)</Prefix>", d)[-1]; print(rel, flush=True)
open(f"{OUT}/overture_release.txt", "w").write(rel)
fs = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=os.environ["HTTPS_PROXY"])
KX = 111320 * math.cos(math.radians((S + N) / 2)); KY = 110950
def scan(theme, typ, cols, fn):
    base = f"overturemaps-us-west-2/{rel}theme={theme}/type={typ}/"
    files = [f.path for f in fs.get_file_info(pafs.FileSelector(base)) if f.path.endswith(".parquet")]
    print(theme, len(files), "files", flush=True)
    def one(f):
        for attempt in range(4):
            try:
                pf = pq.ParquetFile(fs.open_input_file(f)); md = pf.metadata
                names = [md.schema.column(j).path for j in range(md.num_columns)]
                ix = {k: names.index(f"bbox.{k}") for k in ("xmin", "xmax", "ymin", "ymax")}
                out = []
                for rg in range(md.num_row_groups):
                    g = md.row_group(rg); st = {k: g.column(v).statistics for k, v in ix.items()}
                    if not (st["xmin"].min < E and st["xmax"].max > W and st["ymin"].min < N and st["ymax"].max > S): continue
                    for r in pf.read_row_group(rg, columns=cols + ["geometry", "bbox"]).to_pylist():
                        b = r["bbox"]
                        if b["xmin"] < E and b["xmax"] > W and b["ymin"] < N and b["ymax"] > S:
                            x = fn(r)
                            if x: out.append(x)
                return out
            except Exception as e: err = e; time.sleep(2)
        print("ERR", f, str(err)[:80], flush=True); return []
    rows = []
    with ThreadPoolExecutor(8) as ex:
        for out in ex.map(one, files): rows += out
    return rows
def road(r):
    if r["subtype"] != "road": return
    g = wkb.loads(r["geometry"])
    if g.geom_type != "LineString": return
    return {"name": (r["names"] or {}).get("primary"), "class": r["class"], "coords": [[round(x, 5), round(y, 5)] for x, y in g.coords]}
def bld(r):
    g = wkb.loads(r["geometry"]); c = g.centroid
    if W < c.x < E and S < c.y < N: return [round(c.x, 5), round(c.y, 5), round(g.area * KX * KY), r.get("height")]
t = time.time()
if not os.path.exists(f"{OUT}/roads_raw.json"):
    rows = scan("transportation", "segment", ["names", "class", "subtype"], road); json.dump(rows, open(f"{OUT}/roads_raw.json", "w")); print("roads", len(rows), round(time.time() - t), flush=True)
if not os.path.exists(f"{OUT}/buildings_raw.json"):
    rows = scan("buildings", "building", ["height"], bld); json.dump(rows, open(f"{OUT}/buildings_raw.json", "w")); print("buildings", len(rows), round(time.time() - t), flush=True)
