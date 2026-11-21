"""GroundTruth data pull, part 2: REAL street centerlines from Overture Maps (OpenStreetMap-derived), AWS open data."""
import sys, re, json, urllib.request, time
import pyarrow.dataset as ds, pyarrow.fs as pafs, pyarrow.compute as pc, pyarrow.parquet as pq
from shapely import wkb
OUT = sys.argv[1]
W, E, S, N = -122.215, -122.055, 37.805, 37.925
d = urllib.request.urlopen("https://overturemaps-us-west-2.s3.amazonaws.com/?delimiter=/&prefix=release/").read().decode()
rel = re.findall(r"<Prefix>(release/[^<]+)</Prefix>", d)[-1]
print(rel, flush=True)
fs = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options="http://127.0.0.1:39081")
base = f"overturemaps-us-west-2/{rel}theme=transportation/type=segment/"
files = [f.path for f in fs.get_file_info(pafs.FileSelector(base)) if f.path.endswith(".parquet")]
print(len(files), flush=True)
rows = []
for i, f in enumerate(files):
    t = time.time()
    pf = pq.ParquetFile(fs.open_input_file(f))
    md = pf.metadata
    # find bbox columns
    names = [md.schema.column(j).path for j in range(md.num_columns)]
    ix = {k: names.index(f"bbox.{k}") for k in ("xmin", "xmax", "ymin", "ymax")}
    keep = []
    for rg in range(md.num_row_groups):
        g = md.row_group(rg)
        st = {k: g.column(v).statistics for k, v in ix.items()}
        if st["xmin"].min < E and st["xmax"].max > W and st["ymin"].min < N and st["ymax"].max > S:
            keep.append(rg)
    print(i, f.split("/")[-1][:20], md.num_row_groups, keep, round(time.time() - t, 1), flush=True)
    for rg in keep:
        tb = pf.read_row_group(rg, columns=["id", "names", "class", "subtype", "geometry", "bbox"])
        for r in tb.to_pylist():
            b = r["bbox"]
            if r["subtype"] != "road" or not (b["xmin"] < E and b["xmax"] > W and b["ymin"] < N and b["ymax"] > S):
                continue
            g = wkb.loads(r["geometry"])
            if g.geom_type != "LineString": continue
            rows.append({"name": (r["names"] or {}).get("primary"), "class": r["class"],
                         "coords": [[round(x, 5), round(y, 5)] for x, y in g.coords]})
    json.dump(rows, open(f"{OUT}/roads_raw.json", "w"))
print("roads", len(rows))
