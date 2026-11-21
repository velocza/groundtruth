"""Fire station locations for both areas from Overture Maps places (AWS open data, anonymous S3, no key).
Keeps places whose category is fire_station inside each area's box and writes <workdir>/fire_stations_raw.json with every field
needed to review them by hand (name, category, confidence, address, source). scripts/14_build_help_routes.py cleans them.
Usage: python3 scripts/13_fetch_fire_stations.py <workdir>"""
import sys, re, json, urllib.request, os, time
import pyarrow.fs as pafs, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor
from shapely import wkb
OUT = sys.argv[1]
AREAS = {"lamorinda": (-122.235, -122.035, 37.785, 37.945), "sf": (-122.530, -122.350, 37.700, 37.830)}   # W, E, S, N, a little past each map box
d = urllib.request.urlopen("https://overturemaps-us-west-2.s3.amazonaws.com/?delimiter=/&prefix=release/").read().decode()
rel = re.findall(r"<Prefix>(release/[^<]+)</Prefix>", d)[-1]; print(rel, flush=True)
fs = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=os.environ.get("HTTPS_PROXY") or None)
base = f"overturemaps-us-west-2/{rel}theme=places/type=place/"
files = [f.path for f in fs.get_file_info(pafs.FileSelector(base)) if f.path.endswith(".parquet")]
print(len(files), "files", flush=True)
def hit(b, a): return b["xmin"] < a[1] and b["xmax"] > a[0] and b["ymin"] < a[3] and b["ymax"] > a[2]
def cats(r):
    c = r.get("categories") or {}; out = [c.get("primary")] + list(c.get("alternate") or [])
    for k in ("basic_category",): out.append(r.get(k))
    tx = r.get("taxonomy") or {}
    if isinstance(tx, dict): out += [tx.get("primary")] + list(tx.get("hierarchy") or [])
    return [x for x in out if x]
def one(f):
    for attempt in range(4):
        try:
            pf = pq.ParquetFile(fs.open_input_file(f)); md = pf.metadata
            names = [md.schema.column(j).path for j in range(md.num_columns)]
            ix = {k: names.index(f"bbox.{k}") for k in ("xmin", "xmax", "ymin", "ymax")}
            have = set(pf.schema_arrow.names); cols = [c for c in ("id", "names", "categories", "basic_category", "taxonomy", "confidence", "addresses", "sources", "geometry", "bbox") if c in have]
            out = []
            for rg in range(md.num_row_groups):
                g = md.row_group(rg); st = {k: g.column(v).statistics for k, v in ix.items()}
                sb = {"xmin": st["xmin"].min, "xmax": st["xmax"].max, "ymin": st["ymin"].min, "ymax": st["ymax"].max}
                if not any(hit(sb, a) for a in AREAS.values()): continue
                for r in pf.read_row_group(rg, columns=cols).to_pylist():
                    area = next((k for k, a in AREAS.items() if hit(r["bbox"], a)), None)
                    if not area: continue
                    cs = cats(r)
                    if not any("fire_station" in c or c == "fire_department" for c in cs): continue
                    p = wkb.loads(r["geometry"]); ad = (r.get("addresses") or [{}])[0] or {}
                    out.append(dict(area=area, id=r["id"], name=(r.get("names") or {}).get("primary"), cats=cs, confidence=r.get("confidence"),
                                    lon=round(p.x, 6), lat=round(p.y, 6), address=ad.get("freeform"), locality=ad.get("locality"),
                                    sources=sorted({s.get("dataset") for s in (r.get("sources") or []) if s})))
            return out
        except Exception as e: err = e; time.sleep(2)
    print("ERR", f, str(err)[:120], flush=True); return []
with ThreadPoolExecutor(8) as ex: rows = [x for part in ex.map(one, files) for x in part]
json.dump(dict(release=rel, rows=rows), open(f"{OUT}/fire_stations_raw.json", "w"), indent=1)
for k in AREAS: print(k, sum(r["area"] == k for r in rows))
