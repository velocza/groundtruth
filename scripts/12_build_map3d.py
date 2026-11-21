"""Pack the 3D map layers for the site from the raw Overture pull (11_fetch_map3d.py).
  python3 scripts/12_build_map3d.py <workdir> <lamorinda|sf>
Writes site/data/map3d.js or site/data_sf/map3d.js: real building footprint polygons with heights, road centre lines by class,
a water / green space / footprint mask, and place and street names. Nothing here is modelled or simulated. Where Overture has no
height for a building it is stored as 0 and the map draws it at the area's median mapped height."""
import sys, json, math, base64, io, struct, os, statistics
import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Polygon, LineString, box
from shapely.geometry.polygon import orient
WORK, AREA = sys.argv[1], sys.argv[2]
W, E, S, N = {"lamorinda": (-122.215, -122.055, 37.805, 37.925), "sf": (-122.520, -122.360, 37.705, 37.825)}[AREA]
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "site", "data" if AREA == "lamorinda" else "data_sf", "map3d.js")
raw = json.load(open(f"{WORK}/map3d_raw_{AREA}.json")); rel = open(f"{WORK}/overture_release_map3d.txt").read().strip("/").split("/")[-1]
KX = 111320 * math.cos(math.radians((S + N) / 2)); KY = 110950; MX, MY = (E - W) * KX, (N - S) * KY      # box size in metres
Q = 65535; T = 10                                                                                          # coordinate steps across the box, tiles per side
m_of = lambda p: ((p[0] - W) * KX, (p[1] - S) * KY)
q_of = lambda x, y: (int(round(min(1, max(0, x / MX)) * Q)), int(round(min(1, max(0, y / MY)) * Q)))
BOX = box(0, 0, MX, MY)

# ---- buildings: [n u8][height dm u16][min height dm u16][x0 u16][y0 u16] then n-1 steps (i8 i8, or 0x80 + i16 i16)
def ring_bytes(pts):
    q = [q_of(*p) for p in pts]; d = [q[0]]
    for p in q[1:]:
        if p != d[-1]: d.append(p)
    if len(d) > 1 and d[0] == d[-1]: d.pop()
    if len(d) < 3 or len(d) > 255: return None
    out = bytearray(struct.pack("<HH", *d[0]))
    for a, b in zip(d, d[1:]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        out += struct.pack("<bb", dx, dy) if -127 <= dx <= 127 and -127 <= dy <= 127 else b"\x80" + struct.pack("<hh", dx, dy)
    return len(d), bytes(out)
def height(r):
    if r.get("h"): return float(r["h"])
    if r.get("f"): return float(r["f"]) * 3.2
    return 0.0
tiles = [[] for _ in range(T * T)]; nb = 0; known = []; skipped = 0
def add(r, minh=0.0):
    global nb, skipped
    for ring in r["p"]:
        try: g = Polygon([m_of(p) for p in ring]).buffer(0)
        except Exception: continue
        if g.is_empty or g.geom_type != "Polygon" or g.area < 9: skipped += 1; continue
        c = g.centroid
        if not (0 < c.x < MX and 0 < c.y < MY): continue
        tol = 0.35
        while True:
            s = orient(g.simplify(tol, preserve_topology=True), 1.0); rb = ring_bytes(list(s.exterior.coords)) if s.geom_type == "Polygon" else None
            if rb or tol > 6: break
            tol *= 2
        if not rb: skipped += 1; continue
        h = height(r)
        if h: known.append(h)
        ti = min(T - 1, int(c.y / MY * T)) * T + min(T - 1, int(c.x / MX * T))
        tiles[ti].append(struct.pack("<BHH", rb[0], min(65535, int(round(h * 10))), min(65535, int(round((minh or 0) * 10)))) + rb[1]); nb += 1
for r in raw["buildings"]:
    if not r.get("u"): add(r)
whole = [r for r in raw["buildings"] if r.get("u")]
parts = [r for r in raw["parts"] if height(r)]
# a building mapped in parts is drawn from its parts; if none of its parts carry a height, the whole outline is drawn instead
from shapely.strtree import STRtree
pg = [Polygon([m_of(p) for p in r["p"][0]]).buffer(0) for r in parts]; tree = STRtree(pg) if pg else None
for r in whole:
    g = Polygon([m_of(p) for p in r["p"][0]]).buffer(0)
    cov = sum(pg[i].intersection(g).area for i in tree.query(g)) if tree is not None else 0
    if cov < 0.5 * g.area: add(r)
for r in parts: add(r, r.get("m") or 0.0)
bbytes = b"".join(b"".join(t) for t in tiles); bcount = [len(t) for t in tiles]
defh = round(statistics.median(known), 1)
print("buildings", nb, "skipped", skipped, "bytes", len(bbytes), "height known", len(known), "default", defh)

# ---- roads: [class u8][n u16][x0 u16][y0 u16] then n-1 steps i16 i16
CLS = {"motorway": 0, "trunk": 1, "primary": 2, "secondary": 3, "tertiary": 4, "residential": 5, "unclassified": 5, "living_street": 5, "unknown": 6, "service": 6,
       "pedestrian": 7, "footway": 7, "path": 7, "steps": 7, "cycleway": 7, "track": 7, "bridleway": 7}
rt = [[] for _ in range(T * T)]; nr = 0; named = {}
for r in raw["roads"]:
    if r.get("t"): continue                                              # tunnels are underground
    c = 8 if r["s"] == "rail" else CLS.get(r["c"], 6)
    if r["s"] == "rail" and r["c"] == "subway": continue
    g = LineString([m_of(p) for p in r["l"]]).intersection(BOX)
    for ln in ([g] if g.geom_type == "LineString" else list(getattr(g, "geoms", []))):
        if ln.geom_type != "LineString" or ln.length < 3: continue
        ln = ln.simplify(0.6); q = [q_of(*p) for p in ln.coords]; d = [q[0]]
        for p in q[1:]:
            if p != d[-1]: d.append(p)
        if len(d) < 2: continue
        out = bytearray(struct.pack("<BHHH", c + (16 if r.get("b") else 0), len(d), *d[0]))
        for a, b in zip(d, d[1:]): out += struct.pack("<hh", max(-32767, min(32767, b[0] - a[0])), max(-32767, min(32767, b[1] - a[1])))
        mid = ln.interpolate(0.5, normalized=True); ti = min(T - 1, int(mid.y / MY * T)) * T + min(T - 1, int(mid.x / MX * T)); rt[ti].append(bytes(out)); nr += 1
        if r.get("n") and c <= 6: named.setdefault((r["n"], min(c, 5)), []).append(ln)
rbytes = b"".join(b"".join(t) for t in rt); rcount = [len(t) for t in rt]
print("roads", nr, "bytes", len(rbytes))

# ---- names: places, parks, water, and streets (a few label points along each named street)
u_of = lambda x, y: [round(x / MX, 4), round(y / MY, 4)]
labels = []                                                              # [name, u, v, kind, rank]   kind 0 place, 1 park, 2 water, 3 street
PR = {"locality": 0, "macrohood": 1, "neighborhood": 2, "microhood": 3}
seen = set()
for p in raw["places"]:
    x, y = m_of(p["xy"])
    if not (0 < x < MX and 0 < y < MY) or p["s"] not in PR or p["n"] in seen: continue
    seen.add(p["n"]); rk = PR[p["s"]]
    if p["s"] == "locality" and p["c"] != "town" and p["c"] != "city": rk = 1
    labels.append([p["n"], *u_of(x, y), 0, rk])
GREEN = {"park", "golf_course", "golf", "pitch", "garden", "grass", "cemetery", "playground", "recreation_ground", "fairway", "green", "tee", "rough", "dog_park", "meadow", "village_green", "flowerbed", "driving_range"}
def geoms(r):
    for p in r.get("p", []):
        try: g = Polygon(*[[m_of(q) for q in p[0]], [[m_of(q) for q in h] for h in p[1:]]]).buffer(0).intersection(BOX)
        except Exception: continue
        if not g.is_empty: yield g
def named_area(rows, kind, min_m2, ok):
    best = {}
    for r in rows:
        if not r.get("n") or not ok(r): continue
        for g in geoms(r):
            if g.area >= min_m2 and g.area > best.get(r["n"], (0,))[0]: best[r["n"]] = (g.area, g.representative_point())
    for n, (a, pt) in best.items(): labels.append([n, *u_of(pt.x, pt.y), kind, 0 if a > 2.5e6 else 1 if a > 4e5 else 2])
named_area(raw["landuse"], 1, 6e4, lambda r: r["c"] in ("park", "golf_course", "nature_reserve", "cemetery") or r["s"] in ("park", "golf", "protected", "cemetery"))
named_area(raw["water"], 2, 4e4, lambda r: r["s"] != "ocean")
ns = 0
for (n, c), lns in named.items():
    lns.sort(key=lambda l: -l.length); placed = []
    for ln in lns:
        if ln.length < 60: continue
        m = ln.interpolate(0.5, normalized=True)
        if any(math.hypot(m.x - a, m.y - b) < 1100 for a, b in placed): continue
        placed.append((m.x, m.y)); labels.append([n, *u_of(m.x, m.y), 3, c]); ns += 1
        if len(placed) >= 8: break
print("labels", len(labels), "street points", ns)

# ---- mask: R water, G green space, B building footprints, drawn at 4096 and averaged down to 2048
M = 4096; px = lambda g: [(x / MX * M, (1 - y / MY) * M) for x, y in g]
chan = []
def draw(rows, ok):
    im = Image.new("L", (M, M), 0); dr = ImageDraw.Draw(im)
    for r in rows:
        if not ok(r): continue
        for g in geoms(r):
            for pg_ in ([g] if g.geom_type == "Polygon" else list(getattr(g, "geoms", []))):
                if pg_.geom_type != "Polygon": continue
                dr.polygon(px(pg_.exterior.coords), fill=255)
                for h in pg_.interiors: dr.polygon(px(h.coords), fill=0)
    return im
chan.append(draw(raw["water"], lambda r: True))
chan.append(draw(raw["landuse"], lambda r: r["c"] in GREEN or r["s"] in ("park", "golf", "cemetery")))
im = Image.new("L", (M, M), 0); dr = ImageDraw.Draw(im)
for r in raw["buildings"]:
    for ring in r["p"]: dr.polygon(px([m_of(p) for p in ring]), fill=255)
chan.append(im)
mask = Image.merge("RGB", [c.resize((2048, 2048), Image.LANCZOS) for c in chan]); buf = io.BytesIO(); mask.save(buf, "JPEG", quality=84)
print("mask", len(buf.getvalue()) // 1024, "KB", [round(np.asarray(c).mean() / 255, 3) for c in chan])

b64 = lambda b: base64.b64encode(b).decode()
js = {"release": rel, "tiles": T, "q": Q, "defH": defh, "nb": nb, "nr": nr, "known": len(known), "bcount": bcount, "rcount": rcount, "labels": labels,
      "b": b64(bbytes), "r": b64(rbytes), "mask": "data:image/jpeg;base64," + b64(buf.getvalue())}
open(OUT, "w").write("/* Real map layers from Overture Maps " + rel + " (buildings, roads, water, green space, names). Built by scripts/12_build_map3d.py. */\nwindow.GT_MAP3D=" + json.dumps(js, separators=(",", ":")) + ";\n")
print("wrote", OUT, os.path.getsize(OUT) // 1024, "KB")

# ---- optional sharper layers, appended as separate files so the page still works without them:
#   <workdir>/dem10_<area>.npy   USGS 3DEP 1/3 arc-second elevation (about 10 m) cut to the box  -> hillshade normals, 2048 px
#   <workdir>/naip_<area>.jpg    USGS / USDA NAIP aerial photo mosaic of the box, plate carree    -> ground imagery, 4096 px
SITE = os.path.dirname(OUT); extra = {}
p = f"{WORK}/dem10_{AREA}.npy"
if os.path.exists(p):
    z = np.load(p).astype(np.float64); z[z < -100] = 0
    z = np.asarray(Image.fromarray(z.astype(np.float32)).resize((2048, 2048), Image.BICUBIC), dtype=np.float64)
    k = np.array([1, 4, 6, 4, 1]) / 16.0                                  # light smoothing so the 10 m steps do not show as terraces
    z = np.apply_along_axis(lambda r: np.convolve(np.pad(r, 2, mode="edge"), k, "valid"), 1, z); z = np.apply_along_axis(lambda r: np.convolve(np.pad(r, 2, mode="edge"), k, "valid"), 0, z)
    EX = 1.6; dzdy, dzdx = np.gradient(z, MY / 2048, MX / 2048)          # rows run north to south, so +row is +z (south) in the scene
    n = np.dstack([-dzdx * EX, np.ones_like(z), -dzdy * EX]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    buf = io.BytesIO(); Image.fromarray(np.uint8(np.clip(n * 0.5 + 0.5, 0, 1) * 255 + 0.5)).save(buf, "JPEG", quality=88); extra["normal"] = "data:image/jpeg;base64," + b64(buf.getvalue())
    print("normal map", len(buf.getvalue()) // 1024, "KB")
p = f"{WORK}/naip_{AREA}.jpg"
if os.path.exists(p):
    Image.MAX_IMAGE_PIXELS = None
    im = Image.open(p).convert("RGB").resize((4096, 4096), Image.LANCZOS); buf = io.BytesIO(); im.save(buf, "JPEG", quality=80, optimize=True); extra["photo"] = "data:image/jpeg;base64," + b64(buf.getvalue())
    print("aerial photo", len(buf.getvalue()) // 1024, "KB")
if extra:
    f = os.path.join(SITE, "map3d_hi.js"); open(f, "w").write("/* Sharper ground for the 3D map: hillshade normals from the USGS 3DEP 10 m elevation model and the USGS / USDA NAIP aerial photo. Built by scripts/12_build_map3d.py. */\nwindow.GT_MAP3D_HI=" + json.dumps(extra, separators=(",", ":")) + ";\n")
    print("wrote", f, os.path.getsize(f) // 1024, "KB")
