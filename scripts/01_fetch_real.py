"""GroundTruth data pull, part 1: REAL public data for Lamorinda.
 - Elevation: AWS Terrain Tiles (Mapzen terrarium; USGS 3DEP-derived in the US), zoom 13
 - Optical imagery: Sentinel-2 L2A COGs (Element84 / AWS open data), tile 10SEG
 - Rainfall: NOAA GHCN-Daily station files (AWS open data)
Run: python3 01_fetch_real.py <workdir>
"""
import sys, os, io, math, json, csv, urllib.request
import numpy as np
from PIL import Image
import rasterio
from rasterio.warp import reproject, Resampling, transform_bounds
from rasterio.transform import from_bounds
from rasterio.windows import from_bounds as win_from_bounds

OUT = sys.argv[1]
W, E, S, N = -122.215, -122.055, 37.805, 37.925      # Lamorinda study box
NX, NY = 480, 456                                     # ~29 m analysis grid
dst_tf = from_bounds(W, S, E, N, NX, NY)

def get(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return r.read()

# ---------- 1. elevation ----------
Z = 13
def tile_xy(lon, lat, z):
    n = 2 ** z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y
x0, y0 = tile_xy(W, N, Z); x1, y1 = tile_xy(E, S, Z)
tx0, tx1, ty0, ty1 = int(x0), int(x1), int(y0), int(y1)
mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float32)
for ty in range(ty0, ty1 + 1):
    for tx in range(tx0, tx1 + 1):
        im = np.asarray(Image.open(io.BytesIO(get(
            f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{tx}/{ty}.png"))).convert("RGB")).astype(np.float32)
        h = im[..., 0] * 256 + im[..., 1] + im[..., 2] / 256 - 32768
        mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = h
# sample mosaic (web mercator) onto the lon/lat grid, bilinear
lons = W + (np.arange(NX) + 0.5) * (E - W) / NX
lats = N - (np.arange(NY) + 0.5) * (N - S) / NY
px = (lons + 180) / 360 * 2 ** Z * 256 - tx0 * 256
py = (1 - np.arcsinh(np.tan(np.radians(lats))) / math.pi) / 2 * 2 ** Z * 256 - ty0 * 256
X, Y = np.meshgrid(px, py)
xi, yi = np.floor(X).astype(int), np.floor(Y).astype(int)
fx, fy = X - xi, Y - yi
dem = (mos[yi, xi] * (1 - fx) * (1 - fy) + mos[yi, xi + 1] * fx * (1 - fy)
       + mos[yi + 1, xi] * (1 - fx) * fy + mos[yi + 1, xi + 1] * fx * fy)
np.save(f"{OUT}/dem.npy", dem.astype(np.float32))
print("dem", dem.shape, dem.min(), dem.max())

# ---------- 2. Sentinel-2 ----------
B = "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/10/S/EG"
SCENES = {"2023": f"{B}/2023/4/S2A_10SEG_20230419_0_L2A", "2026": f"{B}/2026/11/S2B_10SEG_20261104_0_L2A"}
def read_band(url, nx, ny, resamp=Resampling.bilinear):
    with rasterio.open(url) as src:
        b = transform_bounds("EPSG:4326", src.crs, W, S, E, N)
        win = win_from_bounds(*b, src.transform).round_offsets().round_lengths()
        win = rasterio.windows.Window(win.col_off - 8, win.row_off - 8, win.width + 16, win.height + 16)
        arr = src.read(window=win).astype(np.float32)
        tf = src.window_transform(win)
        out = np.zeros((arr.shape[0], ny, nx), np.float32)
        reproject(arr, out, src_transform=tf, src_crs=src.crs,
                  dst_transform=from_bounds(W, S, E, N, nx, ny), dst_crs="EPSG:4326", resampling=resamp)
        return out
with rasterio.Env(GDAL_HTTP_MERGE_CONSECUTIVE_RANGES="YES", GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
    for yr, base in SCENES.items():
        tci = read_band("/vsicurl/" + base + "/TCI.tif", 1440, 1368)
        Image.fromarray(np.clip(tci, 0, 255).astype(np.uint8).transpose(1, 2, 0)).save(f"{OUT}/s2_{yr}.png")
        red = read_band("/vsicurl/" + base + "/B04.tif", NX, NY, Resampling.average)[0]
        nir = read_band("/vsicurl/" + base + "/B08.tif", NX, NY, Resampling.average)[0]
        swir = read_band("/vsicurl/" + base + "/B11.tif", NX, NY, Resampling.average)[0]
        np.save(f"{OUT}/s2_{yr}_bands.npy", np.stack([red, nir, swir]))
        print("s2", yr, tci.shape, red.mean(), nir.mean())

# ---------- 3. rainfall ----------
ST = {"US1CACC0006": "Lafayette 0.7 E", "US1CACC0010": "Lafayette 1.9 WSW", "US1CACC0025": "Moraga 2.4 NNW",
      "US1CACC0051": "Moraga Town 1.2 WSW", "US1CACC0031": "Walnut Creek 2.3 WSW", "US1CAAL0001": "Piedmont 1.0 SE"}
rain = {}
for sid, name in ST.items():
    txt = get(f"https://noaa-ghcn-pds.s3.amazonaws.com/csv/by_station/{sid}.csv").decode()
    d = {}
    for row in csv.reader(io.StringIO(txt)):
        if row[2] == "PRCP" and row[1] >= "20221001" and not row[5]:   # skip rows with a quality flag
            d[row[1]] = int(row[3]) / 10.0                              # tenths of mm -> mm
    rain[sid] = {"name": name, "daily_mm": d}
    print(sid, name, len(d), max(d) if d else None)
json.dump(rain, open(f"{OUT}/ghcn_raw.json", "w"))
