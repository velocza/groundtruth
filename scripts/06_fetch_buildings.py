"""GroundTruth data pull, part 3: REAL building footprints from Overture Maps (AWS open data). Writes work/buildings_raw.json: [lon, lat, area_m2]."""
import sys, re, json, urllib.request, time, os
import pyarrow.fs as pafs, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor
from shapely import wkb
OUT = sys.argv[1]
W, E, S, N = -122.215, -122.055, 37.805, 37.925
d = urllib.request.urlopen("https://overturemaps-us-west-2.s3.amazonaws.com/?delimiter=/&prefix=release/").read().decode()
rel = re.findall(r"<Prefix>(release/[^<]+)</Prefix>", d)[-1]
print(rel, flush=True)
proxy = os.environ.get("HTTPS_PROXY") or "http://127.0.0.1:39081"
fs = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=proxy)
base = f"overturemaps-us-west-2/{rel}theme=buildings/type=building/"
files = [f.path for f in fs.get_file_info(pafs.FileSelector(base)) if f.path.endswith(".parquet")]
print(len(files), "files", flush=True)
def scan(f):
    for attempt in range(3):
        try:
            pf = pq.ParquetFile(fs.open_input_file(f)); md = pf.metadata
            names = [md.schema.column(j).path for j in range(md.num_columns)]
            ix = {k: names.index(f"bbox.{k}") for k in ("xmin", "xmax", "ymin", "ymax")}
            keep = []
            for rg in range(md.num_row_groups):
                g = md.row_group(rg); st = {k: g.column(v).statistics for k, v in ix.items()}
                if st["xmin"].min < E and st["xmax"].max > W and st["ymin"].min < N and st["ymax"].max > S: keep.append(rg)
            out = []
            for rg in keep:
                tb = pf.read_row_group(rg, columns=["geometry", "bbox"])
                for r in tb.to_pylist():
                    b = r["bbox"]
                    if not (b["xmin"] < E and b["xmax"] > W and b["ymin"] < N and b["ymax"] > S): continue
                    g = wkb.loads(r["geometry"]); c = g.centroid
                    if W < c.x < E and S < c.y < N: out.append([round(c.x, 5), round(c.y, 5), round(g.area * 87800 * 110950)])
            return f, keep, out
        except Exception as e:
            err = e; time.sleep(2)
    return f, "ERR " + str(err)[:80], []
rows = []; t0 = time.time()
with ThreadPoolExecutor(8) as ex:
    for n, (f, keep, out) in enumerate(ex.map(scan, files)):
        rows += out
        if keep: print(n, f.split("/")[-1][:24], keep if isinstance(keep, str) else len(keep), len(out), round(time.time() - t0), flush=True)
json.dump(rows, open(f"{OUT}/buildings_raw.json", "w"))
print("buildings", len(rows), round(time.time() - t0), "s")
