"""escape: REAL street addresses from Overture Maps (theme=addresses, AWS open data) for the address lookup.
Usage: python3 scripts/11_fetch_addresses.py <out.json> [--region sf]
Writes [[number, street, city, postcode, lon, lat], ...] for every address point inside the area box."""
import sys, re, json, urllib.request, time, os
import pyarrow.fs as pafs, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor
OUT = sys.argv[1]
SF = "--region" in sys.argv and sys.argv[sys.argv.index("--region") + 1] == "sf"
W, E, S, N = (-122.520, -122.360, 37.705, 37.825) if SF else (-122.215, -122.055, 37.805, 37.925)
d = urllib.request.urlopen("https://overturemaps-us-west-2.s3.amazonaws.com/?delimiter=/&prefix=release/").read().decode()
rel = re.findall(r"<Prefix>(release/[^<]+)</Prefix>", d)[-1]
print(rel, flush=True)
proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
fs = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=proxy) if proxy else pafs.S3FileSystem(anonymous=True, region="us-west-2")
base = f"overturemaps-us-west-2/{rel}theme=addresses/type=address/"
files = [f.path for f in fs.get_file_info(pafs.FileSelector(base)) if f.path.endswith(".parquet")]
print(len(files), "files", flush=True)
def scan(f):
    err = None
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
                tb = pf.read_row_group(rg, columns=["bbox", "number", "street", "postcode", "address_levels", "country"])
                for r in tb.to_pylist():
                    b = r["bbox"]; x, y = b["xmin"], b["ymin"]
                    if not (W < x < E and S < y < N) or r["country"] != "US": continue
                    lv = [a.get("value") for a in (r["address_levels"] or []) if a and a.get("value")]
                    city = lv[-1] if lv else ""
                    out.append([r["number"] or "", r["street"] or "", city, r["postcode"] or "", round(x, 6), round(y, 6)])
            return f, keep, out
        except Exception as e:
            err = e; time.sleep(2)
    return f, "ERR " + str(err)[:80], []
rows = []; t0 = time.time()
with ThreadPoolExecutor(8) as ex:
    for n, (f, keep, out) in enumerate(ex.map(scan, files)):
        rows += out
        if keep: print(n, f.split("/")[-1][:24], keep if isinstance(keep, str) else len(keep), len(out), round(time.time() - t0), flush=True)
json.dump(rows, open(OUT, "w"))
print("addresses", len(rows), round(time.time() - t0), "s")
