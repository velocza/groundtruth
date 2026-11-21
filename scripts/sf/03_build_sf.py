"""San Francisco data build: derive every feature on the same 480 x 456 grid as Lamorinda and write dataset_sf/.

Everything here is REAL. There is no simulated ground motion for San Francisco (OPERA DISP-S1 needs a NASA Earthdata
login, so it is left out, not faked).

Run: python3 03_build_sf.py <workdir> <rawdir> <dataset_sf>
  workdir: output of 01_fetch_real.py and 02_fetch_overture.py
  rawdir:  the downloads that need an open network (see dataset_sf/README.md, "Sources"):
           sf311_flooding.csv, gt_bundle_weather.json, gt_bundle_slides.json, gt_bundle_usgs.json
"""
import sys, os, io, json, csv, math, heapq, datetime as dt, collections
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from region import W, E, S, N, NX, NY
WK, RAW, DS = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(DS, exist_ok=True)
dx = (E - W) / NX * 111320 * math.cos(math.radians((S + N) / 2)); dy = (N - S) / NY * 110950
CELL = (dx + dy) / 2
def cell_of(lon, lat): return int((N - lat) / (N - S) * NY), int((lon - W) / (E - W) * NX)
def inbox(lon, lat): return W < lon < E and S < lat < N
rr, cc = np.mgrid[0:NY, 0:NX]
LON = W + (cc + 0.5) / NX * (E - W); LAT = N - (rr + 0.5) / NY * (N - S)

# ---------------- Sentinel-2 (real) ----------------
SCENES = json.load(open(f"{WK}/scenes.json"))
S2 = {}
for lab in SCENES:
    red, nir, swir, green, scl = np.load(f"{WK}/s2_{lab}_bands.npy")
    S2[lab] = dict(ndvi=np.clip((nir - red) / (nir + red + 1e-6), -1, 1), ndmi=np.clip((nir - swir) / (nir + swir + 1e-6), -1, 1),
                   ndwi=np.clip((green - nir) / (green + nir + 1e-6), -1, 1), scl=scl)
SDATE = {lab: p.split("_")[2] for lab, p in SCENES.items()}
SDATE = {k: f"{v[:4]}-{v[4:6]}-{v[6:]}" for k, v in SDATE.items()}

# ---------------- elevation and water (real) ----------------
raw_dem = np.load(f"{WK}/dem.npy")
water_votes = sum((S2[l]["scl"] == 6).astype(int) for l in S2)
water = (water_votes >= len(S2) // 2 + 1) & (raw_dem < 3)
water = ndi.binary_opening(water, iterations=1)
lab_, n_ = ndi.label(water)                       # keep the ocean and the bay, and ponds bigger than 2 ha
if n_:
    sizes = ndi.sum(water, lab_, range(1, n_ + 1)); water = np.isin(lab_, 1 + np.flatnonzero(sizes >= 24))
land = ~water
dem = np.where(water, 0.0, np.maximum(raw_dem, 0.0)).astype(np.float64)

# ---------------- terrain derivatives, same code as Lamorinda (Horn 1981 / Zevenbergen & Thorne 1987) ----------------
z = ndi.gaussian_filter(dem, 0.8)
p = np.pad(z, 1, mode="edge")
a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
d, e, f = p[1:-1, :-2], p[1:-1, 1:-1], p[1:-1, 2:]
g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx); dzdy = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * dy)
slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
aspect = (np.degrees(np.arctan2(-dzdx, -dzdy)) + 360) % 360
D = ((d + f) / 2 - e) / dx ** 2; Ee = ((b + h) / 2 - e) / dy ** 2
F = (-a + c + g - i) / (4 * dx * dy); G = (f - d) / (2 * dx); H = (b - h) / (2 * dy)
den = G ** 2 + H ** 2 + 1e-12
profc = -2 * (D * G ** 2 + Ee * H ** 2 + F * G * H) / den
planc = 2 * (D * H ** 2 + Ee * G ** 2 - F * G * H) / den
relief = ndi.maximum_filter(z, 9) - ndi.minimum_filter(z, 9)
order = np.argsort(-z, axis=None)
acc = np.ones(NY * NX); zf = z.ravel(); wf = water.ravel()
nb = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
for idx in order:
    if wf[idx]: continue
    r, c0 = divmod(idx, NX); best, bd = -1, 0.0
    for dr, dc in nb:
        r2, c2 = r + dr, c0 + dc
        if 0 <= r2 < NY and 0 <= c2 < NX:
            drop = (zf[idx] - zf[r2 * NX + c2]) / math.hypot(dr * dy, dc * dx)
            if drop > bd: bd, best = drop, r2 * NX + c2
    if best >= 0: acc[best] += acc[idx]
acc = acc.reshape(NY, NX)
twi = np.log((acc * dx * dy / dx) / np.tan(np.radians(np.maximum(slope, 0.5))))
streams = (acc > 250) & land
dstream = ndi.distance_transform_edt(~streams) * CELL

# ---------------- flood terrain (real, from the same elevation) ----------------
# 1. depression depth: priority-flood fill (Barnes 2014) from the map edge and open water; filled minus ground
filled = z.copy(); seen = np.zeros((NY, NX), bool); pq = []
for r in range(NY):
    for c0 in range(NX):
        if water[r, c0] or r in (0, NY - 1) or c0 in (0, NX - 1):
            heapq.heappush(pq, (z[r, c0], r, c0)); seen[r, c0] = True
while pq:
    v, r, c0 = heapq.heappop(pq)
    for dr, dc in nb:
        r2, c2 = r + dr, c0 + dc
        if 0 <= r2 < NY and 0 <= c2 < NX and not seen[r2, c2]:
            seen[r2, c2] = True; filled[r2, c2] = max(z[r2, c2], v); heapq.heappush(pq, (filled[r2, c2], r2, c2))
sink_depth = np.where(land, filled - z, 0.0)
# 2. how low the cell sits against its surroundings, and how much ground drains to it
low_150 = z - ndi.uniform_filter(z, 11); low_450 = z - ndi.uniform_filter(z, 31)
elev_above_min_300 = z - ndi.minimum_filter(z, 21)
log_acc = np.log10(acc * dx * dy)
dist_water = ndi.distance_transform_edt(land) * CELL

# ---------------- streets and buildings (real, Overture) ----------------
roads = json.load(open(f"{WK}/roads_raw.json"))
KEEP = {"residential", "tertiary", "secondary", "primary", "trunk", "motorway", "unclassified", "living_street"}
RW, RH = NX * 3, NY * 3
rimg = Image.new("L", (RW, RH), 0); drw = ImageDraw.Draw(rimg)
wdt = {"motorway": 5, "trunk": 4, "primary": 4, "secondary": 3, "tertiary": 2}
streets, street_segs, lines = {}, {}, []
for s in roads:
    if s["class"] not in KEEP: continue
    co = [q for q in s["coords"] if inbox(*q)]
    if len(co) < 2: continue
    lines.append(dict(cls=s["class"], co=co))
    drw.line([((x - W) / (E - W) * RW, (N - y) / (N - S) * RH) for x, y in co], fill=255 if s["class"] in wdt else 150, width=wdt.get(s["class"], 1))
    if s["name"] and s["class"] != "motorway":
        streets.setdefault(s["name"], []).extend(co); street_segs.setdefault(s["name"], []).append(co)
dist_road = ndi.distance_transform_edt(np.asarray(rimg.resize((NX, NY), Image.BILINEAR)) < 40) * CELL
rimg.save(f"{WK}/roads_overlay.png")
bl = json.load(open(f"{WK}/buildings_raw.json"))
bcount = np.zeros((NY, NX), np.int32); barea = np.zeros((NY, NX))
for lon, lat, ar, ht in bl:
    r, c0 = cell_of(lon, lat)
    if 0 <= r < NY and 0 <= c0 < NX: bcount[r, c0] += 1; barea[r, c0] += ar
built_frac = np.clip(ndi.uniform_filter(barea, 5) / (dx * dy), 0, 1)       # roof share within about 70 m

# ---------------- city flood reports: SF 311, service "Sewer / Flooding" (real) ----------------
R311 = []
for r in csv.DictReader(open(f"{RAW}/sf311_flooding.csv")):
    try: lon, lat = float(r["long"]), float(r["lat"])
    except ValueError: continue
    if not inbox(lon, lat): continue
    row, col = cell_of(lon, lat)
    R311.append(dict(id=r["service_request_id"], dt=r["requested_datetime"][:19], date=r["requested_datetime"][:10], where=r["service_details"].lower().replace("flooding ", ""),
                     address=r["address"], neighborhood=r["neighborhoods_sffind_boundaries"], district=r["supervisor_district"].split(".")[0],
                     lon=lon, lat=lat, row=row, col=col, source=r["source"], status=r["status_description"]))
print("311 flood reports in box", len(R311), R311[0]["date"], R311[-1]["date"])
# neighbourhood of each cell: the neighbourhood named on the nearest 311 report (real city labels, no polygons needed)
pts = np.array([(q["row"], q["col"]) for q in R311 if q["neighborhood"]]); pn = [q["neighborhood"] for q in R311 if q["neighborhood"]]
seed = np.full((NY, NX), -1, np.int32); names = sorted(set(pn)); nid = {n: k for k, n in enumerate(names)}
for (r, c0), n in zip(pts, pn): seed[r, c0] = nid[n]
_, (ir, ic) = ndi.distance_transform_edt(seed < 0, return_indices=True)
hood = seed[ir, ic]

# ---------------- rainfall (real gauges) ----------------
gh = json.load(open(f"{WK}/ghcn_raw.json"))
wx = json.load(open(f"{RAW}/gt_bundle_weather.json")); sl = json.load(open(f"{RAW}/gt_bundle_slides.json"))
GA = {"US1CASF0017": "CoCoRaHS San Francisco 1.6 SE", "US1CASF0020": "CoCoRaHS San Francisco 3.1 W", "US1CASF0021": "CoCoRaHS San Francisco 3.4 S",
      "US1CASF0004": "CoCoRaHS San Francisco 1.1 SW", "US1CASF0014": "CoCoRaHS San Francisco 4.9 WSW", "US1CASF0003": "CoCoRaHS San Francisco 2.8 WNW",
      "US1CASF0008": "CoCoRaHS San Francisco 3.0 W", "USC00047767": "San Francisco Oceanside (NOAA co-op)"}
full = {s: {k: v for k, v in gh[s]["daily_mm"].items()} for s in GA}
dtn = {}                                               # downtown gauge: GHCN to 2007, NWS co-op feed (SFOC1, same gauge) from 2008
for k, v in gh["USW00023272"]["daily_mm"].items():
    if k < "20080101": dtn[k] = v
for r in csv.DictReader(io.StringIO(sl["iem_daily_sfoc1"])):
    if r["precip_in"] not in ("None", "", "M"): dtn[r["day"].replace("-", "")] = round(max(0.0, float(r["precip_in"])) * 25.4, 2)
full["SFOC1"] = dtn; GA["SFOC1"] = "San Francisco Downtown (NWS co-op SFOC1 / GHCN USW00023272)"
sfo = {}
for r in csv.DictReader(io.StringIO(sl["iem_daily_sfo"])):
    if r["station"] == "SFO" and r["precip_in"] not in ("None", "", "M"): sfo[r["day"]] = round(max(0.0, float(r["precip_in"])) * 25.4, 2)
d0, d1 = dt.date(2008, 7, 1), dt.date(2026, 11, 20)
days = [d0 + dt.timedelta(n) for n in range((d1 - d0).days + 1)]; di = {d_: k for k, d_ in enumerate(days)}
rain = np.zeros(len(days)); nrep = np.zeros(len(days), int); dt_mm = np.full(len(days), np.nan)
for k, day in enumerate(days):
    key = day.strftime("%Y%m%d"); v = [full[s][key] for s in full if key in full[s]]
    nrep[k] = len(v); rain[k] = float(np.mean(v)) if v else 0.0
    if key in dtn: dt_mm[k] = dtn[key]
def roll(x, n): cs = np.concatenate([[0], np.cumsum(x)]); return cs[1:] - np.concatenate([np.zeros(n), cs[1:-n]])[:len(x)]
r3, r7, r30 = roll(rain, 3), roll(rain, 7), roll(rain, 30)
api = np.zeros(len(days))
for k in range(1, len(days)): api[k] = 0.92 * api[k - 1] + rain[k]
# hourly intensity at the nearest hourly gauge (SFO airport ASOS, 13 km south of downtown)
hmax = collections.defaultdict(float); hsum = collections.defaultdict(float)
for line in wx["iem_asos_sfo_hourly"].splitlines()[1:]:
    st, t, v = line.split(",")
    if st != "SFO" or v in ("M", ""): continue
    v = float(v) * 25.4
    if v > 0.01: hmax[t[:10]] = max(hmax[t[:10]], v); hsum[t[:10]] += v
# soil moisture and model rain (ERA5 reanalysis via Open-Meteo: real analysis, not a gauge)
om = {}
for key in ("om_archive_2015_2020", "om_archive_2021_2026"):
    A = json.loads(wx[key]); uniq = {}
    for loc in A: uniq[(loc["latitude"], loc["longitude"])] = loc["hourly"]
    for hh in uniq.values():
        for t, pr, s0, s1, s2 in zip(hh["time"], hh["precipitation"], hh["soil_moisture_0_to_7cm"], hh["soil_moisture_7_to_28cm"], hh["soil_moisture_28_to_100cm"]):
            o = om.setdefault(t[:10], [0.0, 0.0, [], [], []])
            if pr is not None: o[0] += pr / len(uniq); o[1] = max(o[1], pr)
            if s0 is not None: o[2].append(s0); o[3].append(s1); o[4].append(s2)
def m(v): return round(float(np.mean(v)), 4) if v else None

# ---------------- landslide records (real) ----------------
SL = []
def md(s):
    mth, day, yr = s.split()[0].split("/"); return f"{int(yr):04d}-{int(mth):02d}-{int(day):02d}"
for r in csv.DictReader(io.StringIO(json.load(open(f"{RAW}/gt_bundle_usgs.json"))["usgs_2023_csv"])):
    lon, lat = float(r["POINT_X"]), float(r["POINT_Y"])
    if not inbox(lon, lat): continue
    date = md(r["Reported_LS_Date_Time_PST"]); note = ""
    if date == "2023-12-31": date = "2022-12-31"; note = " (inventory lists 12/31/2023, a typo: the linked report and photo are from 12/31/2022)"
    SL.append(dict(date=date, town="San Francisco", where=r["Observer_Description"][:80], what=r["Observer_Description"] + note + f" Impact: {r['Impact']}.", lon=lon, lat=lat,
                   radius_m=60.0, precision="mapped point, USGS reconnaissance inventory", source="USGS San Francisco Bay Area Reconnaissance Landslide Inventory, January 2023, doi.org/10.5066/P9NJ3KMG, ID " + r["ID"], dated=True))
for r in csv.DictReader(io.StringIO(wx["iem_lsr_mtr"])):
    lon, lat = float(r["LON"]), float(r["LAT"])
    if r["TYPETEXT"] in ("LANDSLIDE", "DEBRIS FLOW") and inbox(lon, lat):
        v = r["VALID"]; SL.append(dict(date=f"{v[:4]}-{v[4:6]}-{v[6:8]}", town="San Francisco", where=r["CITY"], what=r["REMARK"], lon=lon, lat=lat, radius_m=300.0,
                                       precision="NWS storm report, position to 0.01 degree (about 1 km)", source="NWS Bay Area Local Storm Report " + r["VALID2"] + " UTC (Iowa Environmental Mesonet archive)", dated=True))
CG = []
for key, v in sl.items():
    if not key.startswith("cgs_dc"): continue
    for ft in json.loads(v)["features"]:
        gm, pr = ft["geometry"], ft["properties"]
        if gm["type"] == "Point": lon, lat = gm["coordinates"]; area = None
        elif gm["type"] == "Polygon": ring = np.array(gm["coordinates"][0]); lon, lat = ring[:, 0].mean(), ring[:, 1].mean(); area = pr.get("SHAPE.STArea()")
        else: ring = np.array(gm["coordinates"] if gm["type"] == "LineString" else gm["coordinates"][0]); lon, lat = ring[:, 0].mean(), ring[:, 1].mean(); area = None
        if not inbox(lon, lat): continue
        CG.append(dict(cgs_layer=key.replace("cgs_", ""), objectid=pr.get("OBJECTID"), lon=round(float(lon), 6), lat=round(float(lat), 6), geometry=gm["type"], area_m2=area,
                       activity={"h": "historic", "d": "dormant", "a": "active"}.get(pr.get("activity"), pr.get("activity")),
                       type={"ds": "debris slide", "df": "debris flow", "dfs": "debris flow source"}.get(pr.get("init_type") or pr.get("source_type"), pr.get("init_type") or pr.get("source_type")),
                       movement_year=pr.get("mvmt_date_yr"), map_year=pr.get("map_year"), evidence=pr.get("ls_data_source_desc"), citation=pr.get("citable_product")))
seen_ = set(); CG = [q for q in CG if not ((q["objectid"], q["geometry"]) in seen_ or seen_.add((q["objectid"], q["geometry"])))]
for q in CG:                                           # the dated ones (January 1982 storm) are usable labels
    if q["movement_year"]:
        SL.append(dict(date=f"{int(q['movement_year'])}-01-04", town="San Francisco", where=f"CGS inventory {q['objectid']}", what=f"{q['type']} mapped after the January 1982 storm ({q['citation']}). Before the rain record in this package starts.",
                       lon=q["lon"], lat=q["lat"], radius_m=60.0, precision="mapped point, state inventory", source="California Geological Survey Landslide Inventory, " + str(q["citation"]), dated=False))
SL.sort(key=lambda s: s["date"])
print("landslide records", len(SL), "CGS mapped features", len(CG))

# ---------------- NWS storm reports for the county (real) ----------------
LSR = []
for r in csv.DictReader(io.StringIO(wx["iem_lsr_mtr"])):
    lon, lat = float(r["LON"]), float(r["LAT"])
    if inbox(lon, lat) or r["COUNTY"].strip().lower() == "san francisco":
        v = r["VALID"]; LSR.append(dict(utc=r["VALID2"], date_utc=f"{v[:4]}-{v[4:6]}-{v[6:8]}", type=r["TYPETEXT"], magnitude=r["MAG"], lon=lon, lat=lat, in_box=int(inbox(lon, lat)),
                                        place=r["CITY"], source=r["SOURCE"], remark=r["REMARK"]))

# ---------------- write ----------------
np.savez_compressed(f"{DS}/grid_480x456_all_layers.npz", dem=dem.astype(np.float32), slope=slope.astype(np.float32), aspect=aspect.astype(np.float32),
    plan_curv=planc.astype(np.float32), prof_curv=profc.astype(np.float32), twi=twi.astype(np.float32), dist_stream=dstream.astype(np.float32), dist_road=dist_road.astype(np.float32),
    ndvi_2023=S2["2023"]["ndvi"].astype(np.float32), ndvi_2026=S2["2026"]["ndvi"].astype(np.float32),
    # extras that Lamorinda does not have yet
    land=land, relief=relief.astype(np.float32), sink_depth=sink_depth.astype(np.float32), low_150=low_150.astype(np.float32), low_450=low_450.astype(np.float32),
    elev_above_min_300=elev_above_min_300.astype(np.float32), log_flow_acc=log_acc.astype(np.float32), dist_water=dist_water.astype(np.float32),
    buildings_count=bcount, buildings_footprint_m2=barea.astype(np.float32), built_frac=built_frac.astype(np.float32), neighborhood_id=hood,
    **{f"ndvi_{l}": S2[l]["ndvi"].astype(np.float32) for l in S2 if l not in ("2023", "2026")}, **{f"ndmi_{l}": S2[l]["ndmi"].astype(np.float32) for l in S2},
    **{f"ndwi_{l}": S2[l]["ndwi"].astype(np.float32) for l in ("2023", "2026", "2026nov11")})
json.dump(dict(bbox=[W, S, E, N], nx=NX, ny=NY, cell_m=[round(dx, 2), round(dy, 2)], sentinel2={l: dict(scene=SCENES[l].split("/")[-1], date=SDATE[l]) for l in SCENES},
               neighborhoods=names, gauges=GA, rain_start=d0.isoformat(), rain_end=d1.isoformat(), overture=open(f"{WK}/overture_release.txt").read().strip(), built="2026-11-21"),
          open(f"{DS}/meta.json", "w"), indent=1)
with open(f"{DS}/rainfall_daily_san_francisco.csv", "w", newline="") as fh:
    w_ = csv.writer(fh)
    w_.writerow(["date", "rain_mm_area_mean", "stations_reporting", "rain_3d_mm", "rain_7d_mm", "rain_30d_mm", "api_mm_k0.92", "downtown_gauge_mm", "sfo_airport_mm", "sfo_max_1h_mm",
                 "era5_rain_mm", "era5_max_1h_mm", "soil_moisture_0_7cm", "soil_moisture_7_28cm", "soil_moisture_28_100cm", "flood_reports_311"])
    n311 = collections.Counter(q["date"] for q in R311)
    for k, day in enumerate(days):
        ds_ = day.isoformat(); o = om.get(ds_)
        w_.writerow([ds_, round(rain[k], 2), nrep[k], round(r3[k], 1), round(r7[k], 1), round(r30[k], 1), round(api[k], 1), "" if np.isnan(dt_mm[k]) else dt_mm[k], sfo.get(ds_, ""),
                     round(hmax[ds_], 2) if ds_ >= "2015-10-01" else "", round(o[0], 2) if o else "", round(o[1], 2) if o else "", m(o[2]) if o else "", m(o[3]) if o else "", m(o[4]) if o else "", n311.get(ds_, 0)])
with open(f"{DS}/rainfall_downtown_since_1921.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); w_.writerow(["date", "rain_mm", "source"])
    allk = dict(gh["USW00023272"]["daily_mm"]); src = {k: "GHCN-Daily USW00023272" for k in allk}
    for k, v in dtn.items():
        if k >= "20080101": allk[k] = v; src[k] = "NWS co-op SFOC1 (same gauge)"
    for k in sorted(allk): w_.writerow([f"{k[:4]}-{k[4:6]}-{k[6:]}", allk[k], src[k]])
with open(f"{DS}/rainfall_hourly_sfo_airport.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); w_.writerow(["local_time", "rain_mm"])
    for line in wx["iem_asos_sfo_hourly"].splitlines()[1:]:
        st, t, v = line.split(",")
        if st == "SFO" and v not in ("M", ""): w_.writerow([t, round(float(v) * 25.4, 2)])
fc = json.loads(wx["om_forecast_recent"]); uq = {}
for loc in fc: uq[(loc["latitude"], loc["longitude"])] = loc["hourly"]
with open(f"{DS}/storm_nov2026_hourly_model.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); hs = list(uq.values()); keys = [k_ for k_ in hs[0] if k_ != "time"]
    w_.writerow(["local_time", "kind"] + keys)
    for j, t in enumerate(hs[0]["time"]):
        vals = [[h_[k_][j] for h_ in hs if h_[k_][j] is not None] for k_ in keys]
        w_.writerow([t, "analysis" if t < "2026-11-21T12" else "forecast"] + [round(float(np.mean(v)), 3) if v else "" for v in vals])
with open(f"{DS}/landslide_events_san_francisco.csv", "w", newline="") as fh:
    cols = ["date", "town", "where", "what", "lon", "lat", "radius_m", "precision", "source", "dated"]
    w_ = csv.DictWriter(fh, cols); w_.writeheader()
    for s in SL: w_.writerow({k_: s[k_] for k_ in cols})
with open(f"{DS}/cgs_landslide_inventory_san_francisco.csv", "w", newline="") as fh:
    w_ = csv.DictWriter(fh, list(CG[0])); w_.writeheader(); w_.writerows(CG)
with open(f"{DS}/flood_reports_311_san_francisco.csv", "w", newline="") as fh:
    cols = ["id", "dt", "date", "where", "address", "neighborhood", "district", "lon", "lat", "row", "col", "source", "status"]
    w_ = csv.DictWriter(fh, cols); w_.writeheader(); w_.writerows(R311)
with open(f"{DS}/nws_storm_reports_san_francisco.csv", "w", newline="") as fh:
    w_ = csv.DictWriter(fh, list(LSR[0])); w_.writeheader(); w_.writerows(LSR)
for k_ in ("iem_rer_mtr", "iem_pns_mtr", "iem_lsr_text", "iem_ffs", "iem_cli_sfd"):
    open(f"{DS}/nws_text_{k_.replace('iem_', '')}.txt", "w").write(sl[k_])
with open(f"{DS}/streets_san_francisco.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); w_.writerow(["street", "town", "n_points", "centroid_lon", "centroid_lat"])
    for name in sorted(streets):
        co = streets[name]
        if len(co) < 4: continue
        m_ = np.mean(co, 0); r, c0 = cell_of(m_[0], m_[1]); w_.writerow([name, names[hood[min(max(r, 0), NY - 1), min(max(c0, 0), NX - 1)]], len(co), round(m_[0], 5), round(m_[1], 5)])
with open(f"{DS}/buildings_san_francisco.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); w_.writerow(["lon", "lat", "footprint_m2", "height_m"]); w_.writerows([[a_, b_, c_, "" if d_ is None else round(d_, 1)] for a_, b_, c_, d_ in bl])
def u8(x, lo, hi): return np.clip((x - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
hq = np.clip(dem * 100, 0, 65535).astype(np.uint16)
L = {"height": np.dstack([hq >> 8, hq & 255, land.astype(np.uint16) * 255]).astype(np.uint8),
     "terrain": np.dstack([u8(slope, 0, 51), u8(aspect, 0, 360), u8(planc, -0.02, 0.02)]),
     "cover": np.dstack([u8(S2["2023"]["ndvi"], -0.2, 1), u8(S2["2026"]["ndvi"], -0.2, 1), u8(built_frac, 0, 1)]),
     "hydro": np.dstack([u8(twi, 0, 20), u8(dstream, 0, 1020), u8(dist_road, 0, 1020)]),
     "flood": np.dstack([u8(sink_depth, 0, 5.1), u8(-low_450, -25.5, 25.5), u8(log_acc, 2.5, 7.6)]),
     "buildings": np.dstack([np.minimum(bcount, 255).astype(np.uint8)] + [np.zeros((NY, NX), np.uint8)] * 2)}
for k_, v_ in L.items(): Image.fromarray(v_).save(f"{DS}/layer_{k_}.png")
for lab in SCENES: Image.open(f"{WK}/s2_{lab}.png").convert("RGB").save(f"{DS}/sentinel2_truecolor_{SDATE[lab]}.jpg", quality=88)
np.save(f"{WK}/street_segs.npy", np.array([0])); json.dump(dict(streets={n_: street_segs[n_] for n_ in street_segs}, lines=lines), open(f"{WK}/streets_built.json", "w"))
print("land cells", int(land.sum()), "slope p50/p99 on land", np.percentile(slope[land], [50, 99]).round(1), "sink>0.3m cells", int((sink_depth > 0.3).sum()),
      "rain days", len(days), "wettest day", days[int(rain.argmax())], round(rain.max(), 1), "max api", round(api.max(), 1), days[int(api.argmax())])
k18 = di[dt.date(2026, 11, 18)]; print("2026-11-18: area mean", rain[k18], "stations", nrep[k18], "downtown", dt_mm[k18], "api", round(api[k18], 1), "311 reports", n311["2026-11-18"])
