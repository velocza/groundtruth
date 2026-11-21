"""GroundTruth data build, part 3: derive features, build the SIMULATED InSAR sample, package everything.
Real inputs: dem.npy, s2_*.npy/png, GHCN rain, Overture roads.  Simulated: OPERA DISP-S1-like ground motion (clearly flagged)."""
import sys, os, io, json, csv, math, base64, urllib.request, datetime as dt
import numpy as np
from PIL import Image
from scipy import ndimage as ndi
WK, SITE, DS = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(SITE, exist_ok=True); os.makedirs(DS, exist_ok=True)
W, E, S, N = -122.215, -122.055, 37.805, 37.925
dem = np.load(f"{WK}/dem.npy"); NY, NX = dem.shape
dx = (E - W) / NX * 111320 * math.cos(math.radians((S + N) / 2)); dy = (N - S) / NY * 110950
rng = np.random.default_rng(20230118)

# ---------------- terrain derivatives (Horn 1981 / Zevenbergen & Thorne 1987) ----------------
z = ndi.gaussian_filter(dem, 0.8)
p = np.pad(z, 1, mode="edge")
a, b, c = p[:-2, :-2], p[:-2, 1:-1], p[:-2, 2:]
d, e, f = p[1:-1, :-2], p[1:-1, 1:-1], p[1:-1, 2:]
g, h, i = p[2:, :-2], p[2:, 1:-1], p[2:, 2:]
dzdx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * dx)          # east positive
dzdy = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * dy)          # north positive
slope = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
aspect = (np.degrees(np.arctan2(-dzdx, -dzdy)) + 360) % 360    # downslope azimuth, 0 = north
D = ((d + f) / 2 - e) / dx ** 2; Ee = ((b + h) / 2 - e) / dy ** 2
F = (-a + c + g - i) / (4 * dx * dy); G = (f - d) / (2 * dx); H = (b - h) / (2 * dy)
den = G ** 2 + H ** 2 + 1e-12
profc = -2 * (D * G ** 2 + Ee * H ** 2 + F * G * H) / den      # + = convex downslope
planc = 2 * (D * H ** 2 + Ee * G ** 2 - F * G * H) / den       # - = convergent (hollow)
relief = ndi.maximum_filter(z, 9) - ndi.minimum_filter(z, 9)
# D8 flow accumulation (no pit filling; fine for a sample)
order = np.argsort(-z, axis=None)
acc = np.ones(NY * NX); zf = z.ravel()
nb = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
for idx in order:
    r, cc = divmod(idx, NX); best, bd = -1, 0.0
    for dr, dc in nb:
        rr, c2 = r + dr, cc + dc
        if 0 <= rr < NY and 0 <= c2 < NX:
            drop = (zf[idx] - zf[rr * NX + c2]) / math.hypot(dr * dy, dc * dx)
            if drop > bd: bd, best = drop, rr * NX + c2
    if best >= 0: acc[best] += acc[idx]
acc = acc.reshape(NY, NX)
twi = np.log((acc * dx * dy / dx) / np.tan(np.radians(np.maximum(slope, 0.5))))
streams = acc > 250
dstream = ndi.distance_transform_edt(~streams) * (dx + dy) / 2

# ---------------- Sentinel-2 indices (real) ----------------
def idx(yr):
    red, nir, swir = np.load(f"{WK}/s2_{yr}_bands.npy")
    ndvi = (nir - red) / (nir + red + 1e-6); ndmi = (nir - swir) / (nir + swir + 1e-6)
    return np.clip(ndvi, -1, 1), np.clip(ndmi, -1, 1)
ndvi23, ndmi23 = idx("2023"); ndvi26, ndmi26 = idx("2026")

# ---------------- rainfall (real, GHCN-Daily / CoCoRaHS) ----------------
LONG = ["US1CACC0010", "US1CACC0025", "US1CACC0031", "US1CAAL0001", "US1CACC0006", "US1CACC0004"]
cache = f"{WK}/ghcn_full.json"
if not os.path.exists(cache):
    full = {}
    for sid in LONG:
        txt = urllib.request.urlopen(f"https://noaa-ghcn-pds.s3.amazonaws.com/csv/by_station/{sid}.csv", timeout=120).read().decode()
        full[sid] = {r[1]: int(r[3]) / 10 for r in csv.reader(io.StringIO(txt)) if r[2] == "PRCP" and r[1] >= "20151001" and not r[5]}
    json.dump(full, open(cache, "w"))
full = json.load(open(cache))
d0, d1 = dt.date(2015, 10, 1), dt.date(2026, 11, 14)
days = [d0 + dt.timedelta(n) for n in range((d1 - d0).days + 1)]
rain = np.zeros(len(days)); nrep = np.zeros(len(days), int)
for k, day in enumerate(days):
    v = [full[s][day.strftime("%Y%m%d")] for s in LONG if day.strftime("%Y%m%d") in full[s]]
    nrep[k] = len(v); rain[k] = float(np.mean(v)) if v else 0.0
def roll(x, n): cs = np.concatenate([[0], np.cumsum(x)]); out = cs[1:] - np.concatenate([np.zeros(n), cs[1:-n]])[:len(x)]; return out
r3, r7, r30 = roll(rain, 3), roll(rain, 7), roll(rain, 30)
api = np.zeros(len(days)); kdec = 0.92                         # antecedent precipitation index, mm
for k in range(1, len(days)): api[k] = kdec * api[k - 1] + rain[k]
di = {d: k for k, d in enumerate(days)}
print("rain WY2023 total mm", rain[di[dt.date(2022,10,1)]:di[dt.date(2023,9,30)]+1].sum(), "WY2026", rain[di[dt.date(2025,10,1)]:di[dt.date(2026,9,30)]+1].sum(), "max API", api.max(), days[int(api.argmax())])

# ---------------- SIMULATED InSAR (stand-in for OPERA DISP-S1; NOT real measurements) ----------------
# creep-prone score from real terrain: moderate slopes, convergent hollows, high local relief, moist/grassy cover
sus = (np.exp(-((slope - 19) / 8) ** 2) * (1 + np.clip(-planc * 400, -0.5, 1)) * np.clip(relief / 60, 0.2, 1.4)
       * (0.7 + 0.6 * np.clip(ndvi23, 0, 1)))
sus *= (dem > 60)
noise = ndi.gaussian_filter(rng.standard_normal((NY, NX)), 9); noise = (noise - noise.min()) / np.ptp(noise)
pick = ndi.gaussian_filter(sus, 3) * (0.4 + noise)
blobs, vfield, kfield = [], np.zeros((NY, NX)), np.zeros((NY, NX))
pk = pick.copy(); pk[:12] = pk[-12:] = 0; pk[:, :12] = pk[:, -12:] = 0
yy, xx = np.mgrid[0:NY, 0:NX]
for n in range(46):
    r0, c0 = np.unravel_index(np.argmax(pk), pk.shape)
    rad = rng.uniform(5.5, 15.0); v0 = -rng.gamma(2.2, 3.6) - 2.0            # mm/yr LOS, away from satellite
    v0 = max(v0, -32.0); ksens = rng.uniform(0.6, 3.2)
    th = math.radians(aspect[r0, c0]); el = rng.uniform(1.2, 2.2)           # elongate downslope
    u = (xx - c0) * math.sin(th) - (yy - r0) * math.cos(th); w = (xx - c0) * math.cos(th) + (yy - r0) * math.sin(th)
    m = np.exp(-((u / (rad * el)) ** 2 + (w / rad) ** 2)) * np.clip(sus / (sus[r0, c0] + 1e-6), 0.3, 1.2)
    vfield += v0 * m; kfield = np.maximum(kfield, ksens * m)
    blobs.append(dict(r=int(r0), c=int(c0), v0=float(v0), k=float(ksens), rad=float(rad)))
    pk[np.hypot(yy - r0, xx - c0) < 24] = 0
vfield += ndi.gaussian_filter(rng.standard_normal((NY, NX)), 1.2) * 0.9      # pixel noise, mm/yr
vfield += ndi.gaussian_filter(rng.standard_normal((NY, NX)), 30) * 14       # long-wavelength (atmosphere/orbit) residual
# wetness forcing from REAL rain: seasonal multiplier on creep rate
wet = np.clip((api - 60) / 110, 0, None)                                     # 0 dry .. ~2 in Jan 2023
ep0 = dt.date(2016, 7, 4); epochs = [ep0 + dt.timedelta(12 * n) for n in range(((d1 - ep0).days) // 12 + 1)]
ek = np.array([di[x] for x in epochs]); t_yr = np.array([(x - ep0).days / 365.25 for x in epochs])
cumwet = np.concatenate([[0], np.cumsum(wet)])[ek + 1] / 365.25              # integral of wetness, yr
def window_rate(a_, b_):                                                     # mean (1 + k*wet) factor needs per-pixel k -> return time & wet integrals
    ia, ib = di[a_], di[b_]; T = (ib - ia) / 365.25; return T, wet[ia:ib].sum() / 365.25
def vel(a_, b_):
    T, Wint = window_rate(a_, b_); return vfield * (1 + kfield * Wint / T) if True else None
creep = vfield - ndi.gaussian_filter(rng.standard_normal((NY, NX)), 30) * 0  # (kept explicit for readers)
def vel_win(a_, b_):
    T, Wint = window_rate(a_, b_)
    signal = np.where(kfield > 0.02, vfield * (1 + kfield * Wint / T), vfield)
    return signal + rng.standard_normal((NY, NX)) * 1.4 / math.sqrt(max(T, 0.5))
v_pre = vel_win(dt.date(2016, 7, 4), dt.date(2022, 10, 1))
v_23 = vel_win(dt.date(2022, 10, 1), dt.date(2023, 9, 30))
v_now = vel_win(dt.date(2025, 11, 14), dt.date(2026, 11, 14))
coh = np.clip(0.92 - 0.45 * np.clip(ndvi23, 0, 1) - 0.004 * slope + rng.standard_normal((NY, NX)) * 0.05, 0.15, 0.98)
print("sim v_pre pct", np.percentile(v_pre, [1, 5, 50, 95]), "v23 min", v_23.min())

# sample time series: every blob centre + stable references
def series(r, c):
    base = vfield[r, c] * (t_yr + kfield[r, c] * cumwet) if kfield[r, c] > 0.02 else vfield[r, c] * t_yr
    atm = np.convolve(rng.standard_normal(len(epochs) + 4), np.ones(5) / 5, "valid") * 3.0
    return base + atm + rng.standard_normal(len(epochs)) * 1.6
def ll(r, c): return [round(W + (c + 0.5) * (E - W) / NX, 5), round(N - (r + 0.5) * (N - S) / NY, 5)]
pts = [(b_["r"], b_["c"], "creep") for b_ in blobs]
flat = np.argwhere((slope < 4) & (kfield < 0.01) & (np.abs(vfield) < 3)); 
for q in flat[rng.choice(len(flat), 6, replace=False)]: pts.append((int(q[0]), int(q[1]), "stable"))
ts = [dict(id=f"P{n:02d}", kind=k_, lonlat=ll(r, c), rc=[r, c], disp_mm=[round(float(x), 1) for x in series(r, c)]) for n, (r, c, k_) in enumerate(pts)]

# ---------------- streets (real, Overture/OSM) ----------------
roads = json.load(open(f"{WK}/roads_raw.json"))
KEEP = {"residential", "tertiary", "secondary", "primary", "trunk", "motorway", "unclassified", "living_street"}
def rc(lon, lat): return (N - lat) / (N - S) * NY - 0.5, (lon - W) / (E - W) * NX - 0.5
streets, lines, street_segs = {}, [], {}
for s in roads:
    if s["class"] not in KEEP: continue
    co = [p_ for p_ in s["coords"] if W < p_[0] < E and S < p_[1] < N]
    if len(co) < 2: continue
    lines.append(dict(cls=s["class"], co=co))
    if s["name"] and s["class"] != "motorway":
        streets.setdefault(s["name"], []).extend(co); street_segs.setdefault(s["name"], []).append([[round(x, 5), round(y, 5)] for x, y in co])
def town(lon, lat):
    # coarse town assignment by nearest civic centre (real coordinates)
    C = {"Lafayette": (-122.118, 37.886), "Orinda": (-122.183, 37.877), "Moraga": (-122.130, 37.835)}
    return min(C, key=lambda k_: math.hypot((lon - C[k_][0]) * 0.79, lat - C[k_][1]))
st_out = []
for name, co in streets.items():
    if len(co) < 4: continue
    step = max(1, len(co) // 40); pts_ = co[::step][:48]
    st_out.append(dict(n=name, t=town(*np.mean(co, 0)), p=[[round(x, 4), round(y, 4)] for x, y in pts_], g=street_segs[name]))
st_out.sort(key=lambda s_: s_["n"])
print("streets", len(st_out), "line segs", len(lines))
# road raster overlay (for the 3D drape) at 2x grid
RW, RH = 1440, 1368
from PIL import ImageDraw
rimg = Image.new("L", (RW, RH), 0); drw = ImageDraw.Draw(rimg)
wdt = {"motorway": 5, "trunk": 4, "primary": 4, "secondary": 3, "tertiary": 2}
for l_ in lines:
    xy = [((x - W) / (E - W) * RW, (N - y) / (N - S) * RH) for x, y in l_["co"]]
    drw.line(xy, fill=255 if l_["cls"] in wdt else 150, width=wdt.get(l_["cls"], 1))
dist_road = ndi.distance_transform_edt(np.asarray(rimg.resize((NX, NY), Image.BILINEAR)) < 40) * (dx + dy) / 2

# ---------------- documented winter 2022-23 events (real reports, street-level geocode from Overture geometry) ----------------
def mid(name, frac=0.5):
    co = streets[name]; return co[int(len(co) * frac)]
def near(n1, n2):
    A, B_ = np.array(streets[n1]), np.array(streets[n2]); dd = np.hypot((A[:, None, 0] - B_[None, :, 0]) * 0.79, A[:, None, 1] - B_[None, :, 1])
    i_, j_ = np.unravel_index(dd.argmin(), dd.shape); return [float((A[i_, 0] + B_[j_, 0]) / 2), float((A[i_, 1] + B_[j_, 1]) / 2)]
SRC1 = "https://www.lamorindaweekly.com/archive/issue1624/Lamorinda-suffers-storm-damage-but-dodges-major-devastation.html"
SRC2 = "https://lamorindaweekly.com/archive/issue1625/print/Two-Orinda-homes-lost-in-landslide-government-help-uncertain.html"
SRC3 = "https://lamorindaweekly.com/archive/issue1626/print/Orinda-gets-winter-storm-damage-update-after-county-qualifies-for-FEMA-assistance.html"
SRC4 = "https://patch.com/california/lamorinda/latest-lafayette-road-closures-storm-information-city-gives-update"
EV = []
def ev(date, town_, where, what, ll_, prec, src): EV.append(dict(date=date, town=town_, where=where, what=what, lonlat=[round(ll_[0], 5), round(ll_[1], 5)], precision=prec, source=src))
CED = [n for n in streets if n == "Cedar Terrace"]   # Cedar Lane itself is unnamed in Overture; it meets Cedar Terrace
print("cedar candidates", [n for n in streets if "Cedar" in n])
if CED: ev("2023-01-19", "Orinda", "Cedar Lane", "House at 14 Cedar Lane slid downhill and was red-tagged; neighbor at 10 Cedar Lane red-tagged Jan 21.", mid(CED[0]), "adjacent street", SRC2)
ev("2022-12-31", "Lafayette", "Pleasant Hill Road between Springhill Road and Deer Hill Road", "Landslide in Briones Regional Park sent mud onto southbound Pleasant Hill Road in the New Year's Eve storm.", [(near("Pleasant Hill Road", "Springhill Road")[0] + near("Pleasant Hill Road", "Deer Hill Road")[0]) / 2, (near("Pleasant Hill Road", "Springhill Road")[1] + near("Pleasant Hill Road", "Deer Hill Road")[1]) / 2], "segment", SRC4)
ev("2023-01-01", "Lafayette", "Lafayette Ridge Trail", "Trail and service roads into Briones closed Jan 1 due to landslides.", mid("Lafayette Ridge Trail") if "Lafayette Ridge Trail" in streets else [-122.128, 37.912], "trail", SRC4)
dw = near("Saint Mary's Road", "Driftwood Drive")
ev("2023-01-10", "Lafayette", "St. Mary's Road, about 300 ft south of Driftwood Drive", "Slide and erosion along Las Trampas Creek put the road edge at risk; emergency rip rap, closure Jan 12 for repairs.", [dw[0], dw[1] - 0.0008], "address", SRC4)
ev("2023-01-10", "Orinda", "Miner Road", "Slide reported to city council on Jan 10.", mid("Miner Road"), "street", SRC1)
ev("2023-01-10", "Orinda", "Wilder", "Slide reported in the Wilder development on Jan 10.", mid("Wilder Road"), "street", SRC1)
ev("2023-02-07", "Orinda", "57 Tarry Lane", "Shoulder and road edge failure, lane closure in effect.", mid("Tarry Lane"), "street", SRC3)
ev("2023-01-11", "Moraga", "Bollinger Canyon Road", "Landslide reported in the Jan 11 town staff report.", mid("Bollinger Canyon Road", 0.3), "street", SRC1)
ev("2023-01-11", "Moraga", "Rheem Boulevard", "Debris from Painted Rock slid onto the road.", mid("Rheem Boulevard"), "street", SRC1)
ev("2023-01-11", "Moraga", "Mulholland Ridge above Camino Ricardo and Ashbrook Place", "Landslide on the ridge above the two streets.", near("Camino Ricardo", "Ashbrook Place"), "segment", SRC1)
for e_ in EV:
    r_, c_ = rc(*e_["lonlat"]); e_["rc"] = [int(round(r_)), int(round(c_))]
    print(e_["date"], e_["where"][:40], e_["lonlat"], "slope", round(float(slope[e_["rc"][0], e_["rc"][1]]), 1))

# ---------------- pack rasters into PNG layers ----------------
def u8(x, lo, hi): return np.clip((x - lo) / (hi - lo) * 255, 0, 255).astype(np.uint8)
hq = np.clip((dem - 0) * 100, 0, 65535).astype(np.uint16)      # centimetres
L = {
 "height": np.dstack([hq >> 8, hq & 255, np.zeros_like(hq)]).astype(np.uint8),
 "terrain": np.dstack([u8(slope, 0, 51), u8(aspect, 0, 360), u8(planc, -0.02, 0.02)]),
 "motion": np.dstack([u8(-v_pre, -8, 32), u8(-v_23, -8, 72), u8(-v_now, -8, 32)]),
 "cover": np.dstack([u8(ndvi23, -0.2, 1), u8(ndvi26, -0.2, 1), u8(coh, 0, 1)]),
 "hydro": np.dstack([u8(twi, 0, 20), u8(dstream, 0, 1020), u8(dist_road, 0, 1020)]),
}
def uri(img, fmt="PNG", **kw):
    bio = io.BytesIO(); img.save(bio, fmt, **kw); return f"data:image/{fmt.lower()};base64," + base64.b64encode(bio.getvalue()).decode()
assets = {k_: uri(Image.fromarray(v_), optimize=True) for k_, v_ in L.items()}
for yr in ("2023", "2026"):
    im = Image.open(f"{WK}/s2_{yr}.png").convert("RGB")
    assets[f"s2_{yr}"] = uri(im, "JPEG", quality=84)
    im.save(f"{DS}/sentinel2_truecolor_{yr}.jpg", quality=88)
assets["roads"] = uri(rimg.resize((960, 912), Image.LANCZOS), optimize=True)
open(f"{SITE}/assets.js", "w").write("window.GT_ASSETS=" + json.dumps(assets) + ";")
for k_, v_ in L.items(): Image.fromarray(v_).save(f"{DS}/layer_{k_}.png")

# ---------------- JSON for the site ----------------
def span(a_, b_):
    ia, ib = di[a_], di[b_] + 1
    return dict(start=a_.isoformat(), mm=[round(float(x), 1) for x in rain[ia:ib]], api=[round(float(x), 1) for x in api[ia:ib]], stations=[int(x) for x in nrep[ia:ib]])
GT = dict(
  meta=dict(bbox=[W, S, E, N], nx=NX, ny=NY, cell_m=[round(dx, 2), round(dy, 2)], built="2026-11-21",
            scales=dict(height_cm=True, slope=[0, 51], aspect=[0, 360], planc=[-0.02, 0.02], v_pre=[-8, 32], v_23=[-8, 72], v_now=[-8, 32],
                        ndvi=[-0.2, 1], coh=[0, 1], twi=[0, 20], dstream=[0, 1020], droad=[0, 1020]),
            s2=dict(y2023="S2A_10SEG_20230419_0_L2A", y2026="S2B_10SEG_20261104_0_L2A"),
            stations=LONG, insar="SIMULATED stand-in for OPERA DISP-S1 (frame access needs a NASA Earthdata login)"),
  rain=dict(wy2023=span(dt.date(2022, 10, 1), dt.date(2023, 4, 30)), recent=span(dt.date(2025, 10, 1), d1)),
  insar=dict(epoch0=ep0.isoformat(), step_days=12, n=len(epochs), points=ts),
  events=EV, streets=st_out)
open(f"{SITE}/data.js", "w").write("window.GT=" + json.dumps(GT, separators=(",", ":")) + ";")

# ---------------- flat files for the team ----------------
with open(f"{DS}/rainfall_daily_lamorinda.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); w_.writerow(["date", "rain_mm_area_mean", "stations_reporting", "rain_3d_mm", "rain_7d_mm", "rain_30d_mm", "api_mm_k0.92"])
    for k in range(di[dt.date(2015, 10, 1)], len(days)): w_.writerow([days[k].isoformat(), round(rain[k], 2), nrep[k], round(r3[k], 1), round(r7[k], 1), round(r30[k], 1), round(api[k], 1)])
with open(f"{DS}/landslide_events_winter2023.csv", "w", newline="") as fh:
    w_ = csv.DictWriter(fh, ["date", "town", "where", "what", "lon", "lat", "precision", "source"]); w_.writeheader()
    for e_ in EV: w_.writerow(dict(date=e_["date"], town=e_["town"], where=e_["where"], what=e_["what"], lon=e_["lonlat"][0], lat=e_["lonlat"][1], precision=e_["precision"], source=e_["source"]))
with open(f"{DS}/streets_lamorinda.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); w_.writerow(["street", "town", "n_points", "centroid_lon", "centroid_lat"])
    for s_ in st_out: m_ = np.mean(s_["p"], 0); w_.writerow([s_["n"], s_["t"], len(s_["p"]), round(m_[0], 5), round(m_[1], 5)])
sel = rng.choice(NY * NX, 20000, replace=False)
with open(f"{DS}/cells_sample_20k.csv", "w", newline="") as fh:
    w_ = csv.writer(fh)
    w_.writerow(["row", "col", "lon", "lat", "elev_m", "slope_deg", "aspect_deg", "plan_curv", "prof_curv", "relief_m", "twi", "dist_stream_m", "dist_road_m",
                 "ndvi_2023", "ndvi_2026", "ndmi_2023", "ndmi_2026", "SIM_v_los_2016_2022_mm_yr", "SIM_v_los_wy2023_mm_yr", "SIM_v_los_last12mo_mm_yr", "SIM_coherence"])
    for q in sel:
        r, c = divmod(int(q), NX); lo, la = ll(r, c)
        w_.writerow([r, c, lo, la, round(float(dem[r, c]), 1), round(float(slope[r, c]), 2), round(float(aspect[r, c]), 1), round(float(planc[r, c]), 5), round(float(profc[r, c]), 5),
                     round(float(relief[r, c]), 1), round(float(twi[r, c]), 2), round(float(dstream[r, c])), round(float(dist_road[r, c])),
                     round(float(ndvi23[r, c]), 3), round(float(ndvi26[r, c]), 3), round(float(ndmi23[r, c]), 3), round(float(ndmi26[r, c]), 3),
                     round(float(v_pre[r, c]), 2), round(float(v_23[r, c]), 2), round(float(v_now[r, c]), 2), round(float(coh[r, c]), 2)])
with open(f"{DS}/SIM_insar_timeseries_points.csv", "w", newline="") as fh:
    w_ = csv.writer(fh); w_.writerow(["date"] + [f'{t_["id"]}_{t_["kind"]}' for t_ in ts])
    for k, ep in enumerate(epochs): w_.writerow([ep.isoformat()] + [t_["disp_mm"][k] for t_ in ts])
np.savez_compressed(f"{DS}/grid_480x456_all_layers.npz", dem=dem.astype(np.float32), slope=slope.astype(np.float32), aspect=aspect.astype(np.float32), plan_curv=planc.astype(np.float32),
                    prof_curv=profc.astype(np.float32), twi=twi.astype(np.float32), dist_stream=dstream.astype(np.float32), dist_road=dist_road.astype(np.float32),
                    ndvi_2023=ndvi23.astype(np.float32), ndvi_2026=ndvi26.astype(np.float32), SIM_v_pre=v_pre.astype(np.float32), SIM_v_wy2023=v_23.astype(np.float32), SIM_v_now=v_now.astype(np.float32))
print({k_: round(len(v_) / 1e3) for k_, v_ in assets.items()}, "data.js KB", os.path.getsize(f"{SITE}/data.js") // 1000)
