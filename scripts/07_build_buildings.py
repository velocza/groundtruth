"""Rasterise REAL Overture building footprints to the 480 x 456 grid (count of building centroids per cell).
Writes site/data/buildings.js (PNG, red channel = count capped at 255), dataset/buildings_lamorinda.csv and dataset/layer_buildings.png."""
import json, csv, base64, io, os, sys
import numpy as np
from PIL import Image
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, E, S, N, NX, NY = -122.215, -122.055, 37.805, 37.925, 480, 456
rows = json.load(open(f"{root}/work/buildings_raw.json"))
grid = np.zeros((NY, NX), np.int32)
for lon, lat, a in rows:
    c = int((lon - W) / (E - W) * NX); r = int((N - lat) / (N - S) * NY)
    if 0 <= r < NY and 0 <= c < NX: grid[r, c] += 1
img = np.zeros((NY, NX, 3), np.uint8); img[..., 0] = np.minimum(grid, 255)
buf = io.BytesIO(); Image.fromarray(img).save(buf, "PNG", optimize=True)
open(f"{root}/site/data/buildings.js", "w").write('window.GT_ASSETS.buildings="data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode() + '";\n')
Image.fromarray(img).save(f"{root}/dataset/layer_buildings.png")
with open(f"{root}/dataset/buildings_lamorinda.csv", "w", newline="") as fh:
    w = csv.writer(fh); w.writerow(["lon", "lat", "footprint_m2"]); w.writerows(rows)
print(len(rows), "buildings,", int((grid > 0).sum()), "cells with a building, max per cell", int(grid.max()), ", png bytes", len(buf.getvalue()))
