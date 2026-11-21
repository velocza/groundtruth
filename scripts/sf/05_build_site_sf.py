"""Pack the San Francisco dataset for the dashboard: site/data_sf/{assets,buildings,data,rainlong}.js.
Same shapes as the Lamorinda files in site/data/, so the same page code runs on either area.
Real data only: there is no ground motion layer for San Francisco, so the motion texture is a flat zero and no motion points are listed.

Run: python3 scripts/sf/05_build_site_sf.py <workdir>      (workdir holds roads_overlay.png and streets_built.json from 03_build_sf.py)
"""
import base64, collections, csv, datetime as dt, io, json, math, os, sys
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import region as R
WK, DS, OUT = sys.argv[1], f"{ROOT}/dataset_sf", f"{ROOT}/site/data_sf"
os.makedirs(OUT, exist_ok=True)
W, E, S, N, NX, NY = R.W, R.E, R.S, R.N, R.NX, R.NY
meta = json.load(open(f"{DS}/meta.json"))

def uri(img, fmt="PNG", **kw):
    bio = io.BytesIO(); img.save(bio, fmt, **kw); return f"data:image/{fmt.lower()};base64," + base64.b64encode(bio.getvalue()).decode()

# ---------------- textures ----------------
assets = {k: uri(Image.open(f"{DS}/layer_{k}.png").convert("RGB"), optimize=True) for k in ("height", "terrain", "cover", "hydro")}
flat = np.zeros((NY, NX, 3), np.uint8); flat[..., 0] = 51; flat[..., 1] = 26; flat[..., 2] = 51      # decodes to 0 mm/yr in every band: no motion data
assets["motion"] = uri(Image.fromarray(flat), optimize=True)
S2 = {"2023": "2023-04-19", "2026": "2026-11-04"}
for k, d in S2.items(): assets[f"s2_{k}"] = uri(Image.open(f"{DS}/sentinel2_truecolor_{d}.jpg").convert("RGB"), "JPEG", quality=84)
assets["roads"] = uri(Image.open(f"{WK}/roads_overlay.png").convert("L").resize((960, 912), Image.LANCZOS), optimize=True)
open(f"{OUT}/assets.js", "w").write("window.GT_ASSETS=" + json.dumps(assets) + ";")
open(f"{OUT}/buildings.js", "w").write('window.GT_ASSETS.buildings="' + uri(Image.open(f"{DS}/layer_buildings.png").convert("RGB"), optimize=True) + '";\n')

# ---------------- rain ----------------
rows = list(csv.DictReader(open(f"{DS}/rainfall_daily_san_francisco.csv")))
di = {r["date"]: i for i, r in enumerate(rows)}
def span(a, b):
    xs = rows[di[a]:di[b] + 1]
    return dict(start=a, mm=[round(float(r["rain_mm_area_mean"]), 1) for r in xs], api=[round(float(r["api_mm_k0.92"]), 1) for r in xs], stations=[int(r["stations_reporting"]) for r in xs])
last = rows[-1]["date"]
long = rows[di["2015-10-01"]:]
open(f"{OUT}/rainlong.js", "w").write("window.GT_RAIN=" + json.dumps(dict(start="2015-10-01", mm=[round(float(r["rain_mm_area_mean"]), 1) for r in long], api=[round(float(r["api_mm_k0.92"]), 1) for r in long]), separators=(",", ":")) + ";\n")

# ---------------- streets, grouped into eleven named parts of the city ----------------
AREAS = {"1": "Richmond", "2": "Marina", "3": "North Beach", "4": "Sunset", "5": "Haight", "6": "SoMa", "7": "Twin Peaks", "8": "Castro", "9": "Mission", "10": "Bayview", "11": "Excelsior"}
fl = [(float(r["lon"]), float(r["lat"]), r["district"]) for r in csv.DictReader(open(f"{DS}/flood_reports_311_san_francisco.csv")) if r["district"] in AREAS]
FX = np.array([[a, b] for a, b, _ in fl]); FD = [d for _, _, d in fl]
def area(lon, lat):                                # supervisor district of the nearest 311 report (real city records)
    return AREAS[FD[int(np.argmin(((FX[:, 0] - lon) * 0.79) ** 2 + (FX[:, 1] - lat) ** 2))]]
sb = json.load(open(f"{WK}/streets_built.json"))
st_out = []
for name, segs in sb["streets"].items():
    co = [p for g in segs for p in g]
    if len(co) < 4: continue
    step = max(1, len(co) // 40); pts = co[::step][:48]; m = np.mean(co, 0)
    st_out.append(dict(n=name, t=area(m[0], m[1]), p=[[round(x, 4), round(y, 4)] for x, y in pts], g=[[[round(x, 5), round(y, 5)] for x, y in g] for g in segs]))
st_out.sort(key=lambda s: s["n"])
cent = collections.defaultdict(list)
for s in st_out: cent[s["t"]].append(np.mean(s["p"], 0))
towns = [[t, round(float(np.mean([c[0] for c in v])), 4), round(float(np.mean([c[1] for c in v])), 4)] for t, v in cent.items()]
towns.sort(key=lambda t: list(AREAS.values()).index(t[0]))

# ---------------- reported slides of winter 2022-23 (USGS reconnaissance inventory, mapped points) ----------------
def nearest_street(lon, lat):
    best, bd = None, 1e9
    for s in st_out:
        for g in s["g"]:
            for x, y in g:
                d = math.hypot((x - lon) * 87800, (y - lat) * 110950)
                if d < bd: bd, best = d, s["n"]
    return best, bd
EV = []
for r in csv.DictReader(open(f"{DS}/landslide_events_san_francisco.csv")):
    if not ("2022-10-01" <= r["date"] <= "2023-04-30") or r["dated"] != "True": continue
    lon, lat = float(r["lon"]), float(r["lat"]); nm, d = nearest_street(lon, lat)
    EV.append(dict(date=r["date"], town=area(lon, lat), where=f"Slope by {nm}" if d < 200 else "Open slope", what=r["what"], lonlat=[round(lon, 5), round(lat, 5)],
                   precision=r["precision"], source=r["source"], rc=[int((N - lat) / (N - S) * NY), int((lon - W) / (E - W) * NX)]))
EV.sort(key=lambda e: e["date"])
seen = collections.Counter()
for e in EV:
    seen[e["where"]] += 1
    if seen[e["where"]] > 1: e["where"] += f" ({seen[e['where']]})"

nb = sum(1 for _ in open(f"{DS}/buildings_san_francisco.csv")) - 1
GT = dict(
    meta=dict(bbox=[W, S, E, N], nx=NX, ny=NY, cell_m=meta["cell_m"], built=meta["built"],
              scales=dict(height_cm=True, slope=[0, 51], aspect=[0, 360], planc=[-0.02, 0.02], v_pre=[-8, 32], v_23=[-8, 72], v_now=[-8, 32], ndvi=[-0.2, 1], coh=[0, 1], twi=[0, 20], dstream=[0, 1020], droad=[0, 1020]),
              s2=dict(y2023=meta["sentinel2"]["2023"]["scene"], y2026=meta["sentinel2"]["2026"]["scene"]), stations=list(meta["gauges"]),
              insar="none: real ground motion (OPERA DISP-S1) is not in this package yet, and nothing is simulated in its place",
              region="sf", towns=towns, rain_end=last, n_streets=len(st_out), n_buildings=nb, n_gauges=len(meta["gauges"])),
    rain=dict(wy2023=span("2022-10-01", "2023-04-30"), recent=span("2025-10-01", last)),
    insar=dict(epoch0="2016-01-01", step_days=12, n=0, points=[]),
    events=EV, streets=st_out)
open(f"{OUT}/data.js", "w").write("window.GT=" + json.dumps(GT, separators=(",", ":")) + ";")

# No landslide model for San Francisco: the Lamorinda landslide trees are not transferred (site/data_sf/local-model.js is not written).

print("streets", len(st_out), "areas", [(t[0], len(cent[t[0]])) for t in towns], "events", [(e["date"], e["where"], e["town"]) for e in EV], "rain to", last, "buildings", nb)
print({f: os.path.getsize(f"{OUT}/{f}") // 1000 for f in sorted(os.listdir(OUT))}, "KB")
