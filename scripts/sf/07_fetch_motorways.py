"""SF data pull, part 7: freeways, bridges and their ramps from Overture Maps (AWS open data), for the Getting out road graph.

The named street list (03_build_sf.py) leaves class "motorway" out, but the Golden Gate Bridge, the Bay Bridge, US 101 and I-280
are the city's main ways out. This keeps every motorway segment (main lanes and links) that touches the box, clips it to the box
and writes dataset_sf/roads_motorway_overture.json. scripts/08_road_graph.py --region sf reads it.

Usage: python3 scripts/sf/07_fetch_motorways.py [release]     (default: the release in <repo>/dataset_sf/meta.json, else the latest)
Needs pyarrow and shapely; reads through HTTPS_PROXY like 02_fetch_overture.py.
"""
import sys, os, re, json, time, urllib.request
import pyarrow.fs as pafs, pyarrow.parquet as pq
from concurrent.futures import ThreadPoolExecutor
from shapely import wkb
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from region import W, E, S, N
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

d = urllib.request.urlopen("https://overturemaps-us-west-2.s3.amazonaws.com/?delimiter=/&prefix=release/").read().decode()
rels = re.findall(r"<Prefix>(release/[^<]+)</Prefix>", d)
want = sys.argv[1] if len(sys.argv) > 1 else json.load(open(os.path.join(ROOT, 'dataset_sf', 'meta.json'))).get('overture', '')
rel = next((r for r in rels if want and want.strip('/').split('/')[-1] in r), rels[-1]); print('Overture', rel, flush=True)
fs = pafs.S3FileSystem(anonymous=True, region="us-west-2", proxy_options=os.environ.get("HTTPS_PROXY", ""))
base = f"overturemaps-us-west-2/{rel}theme=transportation/type=segment/"
files = [f.path for f in fs.get_file_info(pafs.FileSelector(base)) if f.path.endswith(".parquet")]


def one(f):
    for attempt in range(4):
        try:
            pf = pq.ParquetFile(fs.open_input_file(f)); md = pf.metadata
            names = [md.schema.column(j).path for j in range(md.num_columns)]
            ix = {k: names.index(f"bbox.{k}") for k in ("xmin", "xmax", "ymin", "ymax")}; out = []
            for rg in range(md.num_row_groups):
                st = {k: md.row_group(rg).column(v).statistics for k, v in ix.items()}
                if not (st["xmin"].min < E and st["xmax"].max > W and st["ymin"].min < N and st["ymax"].max > S): continue
                for r in pf.read_row_group(rg, columns=["id", "names", "class", "subtype", "subclass", "geometry", "bbox"]).to_pylist():
                    b = r["bbox"]
                    if not (b["xmin"] < E and b["xmax"] > W and b["ymin"] < N and b["ymax"] > S) or r["subtype"] != "road" or r["class"] != "motorway": continue
                    g = wkb.loads(r["geometry"])
                    if g.geom_type == "LineString":
                        out.append(dict(id=r["id"], name=(r["names"] or {}).get("primary"), link=r.get("subclass") == "link", coords=[[round(x, 5), round(y, 5)] for x, y in g.coords]))
            return out
        except Exception as e: err = e; time.sleep(2)
    print("ERR", f, str(err)[:80], flush=True); return []


inb = lambda p: W <= p[0] <= E and S <= p[1] <= N
def edge(a, b):                                                # where the segment from a (inside) to b (outside) crosses the box edge
    t = 1.0
    for k, lo, hi in ((0, W, E), (1, S, N)):
        if b[k] < lo: t = min(t, (lo - a[k]) / (b[k] - a[k]))
        if b[k] > hi: t = min(t, (hi - a[k]) / (b[k] - a[k]))
    return [round(a[0] + (b[0] - a[0]) * t, 5), round(a[1] + (b[1] - a[1]) * t, 5)]


rows = []
with ThreadPoolExecutor(12) as ex:
    for o in ex.map(one, files): rows += o
lines = []
for r in rows:
    co, run = r['coords'], []
    for i, p in enumerate(co + [None]):
        if p is not None and inb(p):
            if not run and i > 0: run.append(edge(p, co[i - 1]))
            run.append(p)
        else:
            if run and p is not None: run.append(edge(co[i - 1], p))
            if len(run) > 1: lines.append(dict(r, coords=run))
            run = []
meta = dict(source='Overture Maps ' + rel.strip('/').split('/')[-1] + ', transportation segments of class motorway (freeways, bridges and their ramps), clipped to the San Francisco box',
            why='The named street list in site/data_sf/data.js leaves freeways out. The Getting out road graph needs them: the Golden Gate Bridge, the Bay Bridge, US 101 and I-280 are the main ways out of the city.')
json.dump(dict(meta=meta, lines=lines), open(os.path.join(ROOT, 'dataset_sf', 'roads_motorway_overture.json'), 'w'), separators=(',', ':'))
print(len(rows), 'segments,', len(lines), 'pieces inside the box')
