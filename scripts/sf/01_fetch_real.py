"""SF data pull, part 1: REAL elevation (AWS Terrain Tiles / USGS 3DEP), Sentinel-2 L2A (several dates), NOAA GHCN-Daily rain.
Run: python3 01_fetch_real.py <workdir>"""
import sys, os, io, math, json, csv, urllib.request
import numpy as np
from PIL import Image
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_bounds
from rasterio.windows import from_bounds as win_from_bounds
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from region import W, E, S, N, NX, NY
OUT = sys.argv[1]

def get(url):
    for k in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r: return r.read()
        except Exception as e: err = e
    raise err

# ---------- 1. elevation ----------
if not os.path.exists(f"{OUT}/dem.npy"):
    Z = 13
    def tile_xy(lon, lat, z):
        n = 2 ** z
        return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    x0, y0 = tile_xy(W, N, Z); x1, y1 = tile_xy(E, S, Z)
    tx0, tx1, ty0, ty1 = int(x0), int(x1) + 1, int(y0), int(y1) + 1
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
    for ty in range(ty0, ty1 + 1):
        for tx in range(tx0, tx1 + 1):
            im = np.asarray(Image.open(io.BytesIO(get(f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png"))).convert("RGB")).astype(np.float32)
            mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
    lons = W + (np.arange(NX) + 0.5) * (E - W) / NX; lats = N - (np.arange(NY) + 0.5) * (N - S) / NY
    px = (lons + 180) / 360 * 2 ** Z * 256 - tx0 * 256
    py = (1 - np.arcsinh(np.tan(np.radians(lats))) / math.pi) / 2 * 2 ** Z * 256 - ty0 * 256
    X, Y = np.meshgrid(px, py); xi, yi = np.floor(X).astype(int), np.floor(Y).astype(int); fx, fy = X - xi, Y - yi
    dem = (mos[yi, xi] * (1 - fx) * (1 - fy) + mos[yi, xi + 1] * fx * (1 - fy) + mos[yi + 1, xi] * (1 - fx) * fy + mos[yi + 1, xi + 1] * fx * fy)
    np.save(f"{OUT}/dem.npy", dem.astype(np.float32)); print("dem", dem.shape, dem.min(), dem.max(), flush=True)

# ---------- 3. rainfall (before imagery: small and fast) ----------
ST = {"USW00023272": "San Francisco Downtown", "USC00047767": "San Francisco Oceanside", "US1CASF0017": "San Francisco 1.6 SE",
      "US1CASF0020": "San Francisco 3.1 W", "US1CASF0021": "San Francisco 3.4 S", "US1CASF0004": "San Francisco 1.1 SW",
      "US1CASF0014": "San Francisco 4.9 WSW", "US1CASF0003": "San Francisco 2.8 WNW", "US1CASF0008": "San Francisco 3.0 W",
      "USW00023234": "San Francisco Intl Airport (outside the box, reference only)"}
if not os.path.exists(f"{OUT}/ghcn_raw.json"):
    rain = {}
    for sid, name in ST.items():
        txt = get(f"https://noaa-ghcn-pds.s3.amazonaws.com/csv/by_station/{sid}.csv").decode()
        d = {}; q = {}
        for row in csv.reader(io.StringIO(txt)):
            if row[2] == "PRCP":
                if not row[5]: d[row[1]] = int(row[3]) / 10.0
                else: q[row[1]] = row[5]
        rain[sid] = {"name": name, "daily_mm": d, "flagged": q}
        print(sid, name, len(d), min(d), max(d), flush=True)
    json.dump(rain, open(f"{OUT}/ghcn_raw.json", "w"))

# ---------- 2. Sentinel-2 ----------
B = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/EG"
SCENES = json.load(open(f"{OUT}/scenes.json"))   # {"label": "YYYY/M/SCENE_ID"}
def read_band(url, nx, ny, resamp=Resampling.bilinear):
    with rasterio.open(url) as src:
        b = transform_bounds("EPSG:4326", src.crs, W, S, E, N)
        win = win_from_bounds(*b, src.transform).round_offsets().round_lengths()
        win = rasterio.windows.Window(win.col_off - 8, win.row_off - 8, win.width + 16, win.height + 16)
        arr = src.read(window=win).astype(np.float32); tf = src.window_transform(win)
        out = np.zeros((arr.shape[0], ny, nx), np.float32)
        reproject(arr, out, src_transform=tf, src_crs=src.crs, dst_transform=from_bounds(W, S, E, N, nx, ny), dst_crs="EPSG:4326", resampling=resamp)
        return out
with rasterio.Env(GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
    for lab, path in SCENES.items():
        if os.path.exists(f"{OUT}/s2_{lab}_bands.npy"): continue
        base = "/vsicurl/" + B + "/" + path
        tci = read_band(base + "/TCI.tif", 1440, 1368)
        Image.fromarray(np.clip(tci, 0, 255).astype(np.uint8).transpose(1, 2, 0)).save(f"{OUT}/s2_{lab}.png")
        bands = [read_band(base + f"/{b}.tif", NX, NY, Resampling.average)[0] for b in ("B04", "B08", "B11", "B03")]
        scl = read_band(base + "/SCL.tif", NX, NY, Resampling.nearest)[0]
        np.save(f"{OUT}/s2_{lab}_bands.npy", np.stack(bands + [scl]))
        print("s2", lab, path, "cloudy cells %", round(float(np.isin(scl, [3, 8, 9, 10]).mean() * 100), 1), flush=True)
