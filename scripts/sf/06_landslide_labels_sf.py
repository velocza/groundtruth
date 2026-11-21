"""San Francisco landslide training data: every real landslide record found for the city, a rain record long enough to date them,
and training rows in the same layout as the Lamorinda sheet.

Run: python3 scripts/sf/06_landslide_labels_sf.py <repo root> <out.xlsx> <sf-sef.e00>
     (sf-sef.e00 is the San Francisco County file of USGS Open-File Report 97-745 C, https://pubs.usgs.gov/of/1997/of97-745/)
Writes dataset_sf/landslides/* and dataset_sf/training/landslide_*.csv.gz, then the workbook.
Nothing here is simulated. Positions that were read off a map or a street description say so in `precision`.
"""
import csv, datetime as dt, gzip, json, os, sys
import numpy as np
import xlsxwriter

ROOT, OUT, E00 = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, os.path.join(ROOT, "model"))
import handoff_common_sf as C
from gbm import GroundTruthGBM, auc, spatial_blocks

D = os.path.join(ROOT, "dataset_sf"); LD = os.path.join(D, "landslides"); TD = os.path.join(D, "training")
os.makedirs(LD, exist_ok=True)
z = np.load(os.path.join(D, "grid_480x456_all_layers.npz"))
land = z["land"].astype(bool); rr, cc = np.mgrid[0:C.H, 0:C.WD]
lon = C.W + (cc + 0.5) / C.WD * (C.E - C.W); lat = C.N - (rr + 0.5) / C.H * (C.N - C.S)

# ---------------------------------------------------------------- 1. rain back to 1921
# Area mean of the city gauges from 2008-07-01 (the record the rest of the package uses); the downtown gauge alone before that.
area = {r["date"]: (float(r["rain_mm_area_mean"] or 0), int(r["stations_reporting"] or 0)) for r in csv.DictReader(open(os.path.join(D, "rainfall_daily_san_francisco.csv")))}
down = {r["date"]: float(r["rain_mm"]) for r in csv.DictReader(open(os.path.join(D, "rainfall_downtown_since_1921.csv")))}
d0, d1 = dt.date(1921, 1, 1), dt.date.fromisoformat(max(area))
DATES = [(d0 + dt.timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]
IDX = {d: i for i, d in enumerate(DATES)}
MM = np.zeros(len(DATES)); NG = np.zeros(len(DATES), int); SRC = []
for i, d in enumerate(DATES):
    if d in area: MM[i], NG[i] = area[d]; SRC.append("city gauges, area mean")
    elif d in down: MM[i], NG[i] = down[d], 1; SRC.append("downtown gauge only")
    else: SRC.append("no reading, counted as 0")
API = np.zeros(len(DATES))
for i in range(len(DATES)): API[i] = (API[i - 1] * 0.92 if i else 0.0) + MM[i]
def storm_at(i): return float(MM[i + 1:i + 4].sum()), float(API[i])
def before_report(date):
    d = IDX[date]; best = max(range(max(0, d - 3), d), key=lambda i: C.trigger_T(*storm_at(i)))
    return (best,) + storm_at(best)
with open(os.path.join(LD, "rainfall_daily_long_san_francisco.csv"), "w", newline="") as f:
    w = csv.writer(f); w.writerow(["date", "rain_mm", "gauges", "source", "api_mm_k0.92", "rain_72h_next_mm", "trigger_T"])
    for i, d in enumerate(DATES):
        r72, api = storm_at(i); w.writerow([d, round(MM[i], 2), NG[i], SRC[i], round(API[i], 2), round(r72, 2), round(float(C.trigger_T(r72, api)), 4)])

# ---------------------------------------------------------------- 2. every landslide record
GLC = "NASA Global Landslide Catalog, as carried in the USGS national landslide inventory v3 (doi.org/10.5066/P13KDCHU)"
MF = "USGS Miscellaneous Field Studies Map MF-2325-G (Hillhouse and Godt, 1999), damaging landslides of the 1997-98 El Nino winter, pubs.usgs.gov/mf/1999/mf-2325-g"
MFP = "point read off the 1:125,000 USGS map, good to about 150 m"
NEW = [  # date, where, what, lon, lat, radius_m, precision, source, dated
    ("1998-02-08", "Sea Cliff, bluff above Phelan (China) Beach", "Rotational slump in the coastal bluff, began 8 February 1998 and damaged three homes.", -122.4915, 37.7860, 150, MFP, MF, True),
    ("1998-02-11", "Warren Drive near Mount Sutro", "Earth slump on the hillside at Warren Drive, 11 to 13 February 1998.", -122.4619, 37.7566, 150, MFP, MF, True),
    ("1998-02-15", "Olympic Club and Fort Funston bluff", "Slump mapped among the four damaging San Francisco landslides of winter 1997-98. The day is not given (most were reported 2 to 26 February 1998), so it is not used as a dated label.", -122.4990, 37.7080, 150, MFP, MF, False),
    ("1998-02-15", "Bernal Heights area", "Landslide mapped among the four damaging San Francisco landslides of winter 1997-98. The day is not given, so it is not used as a dated label.", -122.4162, 37.7458, 150, MFP, MF, False),
    ("2007-02-27", "Telegraph Hill above Broadway, between Montgomery and Kearny", "Hillside came down shortly after 3 a.m. onto a club and apartment buildings on Broadway; about 120 residents displaced (Associated Press, 27 February 2007). The catalog position is 5 km off, so the point was placed from the news report.", -122.4047, 37.7985, 100, "placed from the news report's street description, good to about 100 m", GLC + ", event 190490; Associated Press via nbcnews.com/id/wbna17362399", True),
    ("2014-12-22", "Lands End, hillside by the parking lot", "Hillside slide at the Lands End parking lot.", -122.5103, 37.7837, 150, "catalog point, good to about 150 m", GLC + ", event 192425", True),
    ("2017-01-10", "O'Shaughnessy Boulevard between Malta Drive and Del Vale Avenue", "Slide closed O'Shaughnessy Boulevard between Malta Drive and Del Vale Avenue.", -122.4432, 37.7397, 150, "catalog point on the named stretch of road (the stretch is 560 m long)", GLC + ", event 192997", True),
    ("2017-02-21", "Bernal Hill, south side of Bernal Heights Boulevard just east of Ellsworth Street", "Slide on the south side of Bernal Heights Boulevard just east of Ellsworth Street.", -122.4139, 37.7424, 60, "placed at the named intersection from street geometry, good to about 60 m", GLC + ", event 193016", True),
    ("2023-01-04", "5 W San Francisco (Point Lobos Avenue and Great Highway area)", "Road closed due to slide in lanes. Reported by broadcast media.", -122.51, 37.78, 300, "NWS storm report, position to 0.01 degree (about 1 km)", "NWS Bay Area Local Storm Report 2023/01/04 20:37 UTC (Iowa Environmental Mesonet archive)", True),
    ("2023-12-20", "US 101 southbound, Cesar Chavez Street offramp", "Mudslide in the number 4 lane of southbound 101 at the Cesar Chavez Street offramp. Reported by law enforcement.", -122.4055, 37.7490, 150, "placed at the named offramp, good to about 150 m (the report itself gives 0.01 degree)", "NWS Bay Area Local Storm Report 2023/12/20 18:04 UTC (Iowa Environmental Mesonet archive)", True),
]
EXCLUDED = [
    ("2016-03-07", "NASA Global Landslide Catalog event 191003", "Left out: the text describes a train derailed by a mudslide east of the city (Niles Canyon), not a slide in San Francisco. The catalog point falls in the box only because it was placed on the city name."),
    ("2022-12-31", "NWS storm report 18:02 UTC, 'mud slide behind house', 3 SW San Francisco", "Left out as a duplicate: same hour and neighbourhood as the USGS record for 452 Ulloa Street, which has the exact address."),
    ("1997-12-01", "USGS Open-File Report 97-745 E (debris-flow sources of the January 1982 storm)", "No San Francisco County file exists in that report, so there is nothing to add."),
    ("2026-11-18", "November 2026 storm", "No landslide inside the city is confirmed in the sources pulled (NWS storm reports and news through 20 November list flooding only)."),
    ("", "SF 311 service requests", "Not usable: the public 311 data has no landslide category and the free text of each case is not published."),
    ("", "California Geological Survey deep-seated landslide inventory (DC3 layer)", "Checked: no features inside the box."),
]
slides = []
for r in csv.DictReader(open(os.path.join(D, "landslide_events_san_francisco.csv"))):
    r["dated"] = True if r["date"] >= "1921-01-04" else r["dated"] == "True"       # the long rain record now dates the January 1982 slide
    if r["date"] == "1982-01-04": r["what"] = "Debris flow source mapped after the storm of 3 to 5 January 1982 (Landslide Index 01041982 South Bay)."
    slides.append(r)
for a in NEW: slides.append(dict(zip(["date", "where", "what", "lon", "lat", "radius_m", "precision", "source", "dated"], a), town="San Francisco"))
slides.sort(key=lambda s: (s["date"], float(s["lon"])))
HOLD = "2022-10-01"
def split_of(s):
    if not s["dated"]: return "undated"
    d = s["date"]
    return "train" if d < HOLD else "test_winter2023" if d < "2023-10-01" else "later_2023_2026" if d < "2026-11-01" else "test_nov2026_storm"
for i, s in enumerate(slides):
    s["slide_id"] = f"SFL{i + 1:02d}"; s["lon"], s["lat"], s["radius_m"] = float(s["lon"]), float(s["lat"]), float(s["radius_m"])
    s["row"], s["col"] = C.cell_of(s["lon"], s["lat"]); s["split"] = split_of(s)
    if s["dated"]:
        b, r72, api = before_report(s["date"]); s["storm_morning"], s["storm_rain_72h_mm"], s["storm_api_mm"], s["storm_trigger_T"] = DATES[b], r72, api, float(C.trigger_T(r72, api))
    else: s["storm_morning"] = s["storm_rain_72h_mm"] = s["storm_api_mm"] = s["storm_trigger_T"] = None
SLC = ["slide_id", "date", "split", "town", "where", "what", "lon", "lat", "row", "col", "radius_m", "precision", "source", "storm_morning", "storm_rain_72h_mm", "storm_api_mm", "storm_trigger_T", "dated"]
with open(os.path.join(LD, "landslide_events_all_san_francisco.csv"), "w", newline="") as f:
    w = csv.writer(f); w.writerow(SLC)
    for s in slides: w.writerow([("" if s[c] is None else round(s[c], 4) if isinstance(s[c], float) and c.startswith("storm") else s[c]) for c in SLC])
with open(os.path.join(LD, "records_checked_and_left_out.csv"), "w", newline="") as f:
    w = csv.writer(f); w.writerow(["date", "record", "why"]); w.writerows(EXCLUDED)

# ---------------------------------------------------------------- 3. USGS 1997 landslide map on the grid (undated ground truth)
import geopandas as gpd
from rasterio import features, transform
g = gpd.read_file(E00, layer="PAL").drop(columns=["ArcIds"]).set_crs(26710, allow_override=True).to_crs(4326)   # NAD27 UTM zone 10
tf = transform.from_bounds(C.W, C.S, C.E, C.N, C.WD, C.H)
lscat = features.rasterize(((geom, int(v)) for geom, v in zip(g.geometry, g.LSCAT)), out_shape=(C.H, C.WD), transform=tf, fill=0, dtype="uint8")
CLS = {0: "outside the map", 2: "water", 3: "surficial deposits (flat, few landslides)", 6: "few landslides", 8: "mostly landslide"}
mostly = (lscat == 8) & land
np.savez_compressed(os.path.join(LD, "usgs1997_landslide_map_480x456.npz"), lscat=lscat)

# ---------------------------------------------------------------- 4. training rows, sampled as train_template.build_rows does
fold = spatial_blocks(rr.ravel(), cc.ravel(), block=40, k=5, seed=0).reshape(C.H, C.WD)
Xs, fnames = C.static_features()
dated = [s for s in slides if s["dated"]]
near_any = np.zeros((C.H, C.WD), bool)
for s in slides: near_any |= C.disk(s["row"], s["col"], max(450, s["radius_m"] + 300))
neg_pool = np.flatnonzero(((z["dist_road"] < 150) & land & ~near_any & ~mostly).ravel())
DAY0, DAYN = IDX["1981-10-01"], len(DATES) - 3
rng = np.random.default_rng(0); T = []
for s in dated:
    b, r72, api = before_report(s["date"])
    pos = np.flatnonzero((C.disk(s["row"], s["col"], s["radius_m"]) & land).ravel())
    s["positive_cells"] = len(pos); k = len(pos) * 8 // 2
    same = rng.choice(neg_pool, k); other = rng.choice(np.r_[pos, rng.choice(neg_pool, k)], k); days = rng.integers(DAY0, DAYN, k)
    for kind, idx, dayidx in (("positive", pos, np.full(len(pos), b)), ("neg_same_morning", same, np.full(k, b)), ("neg_other_morning", other, days)):
        for ci, di in zip(idx, dayidx):
            r72_, api_ = storm_at(int(di)); T.append((s["slide_id"], s["split"], kind, int(kind == "positive"), DATES[int(di)], int(ci), r72_, api_))
for s in slides: s.setdefault("positive_cells", 0)
wsp = {}
for sp in set(t[1] for t in T):
    p_ = sum(1 for t in T if t[1] == sp and t[3]); n_ = sum(1 for t in T if t[1] == sp and not t[3]); wsp[sp] = n_ / max(1, p_) / 4
MODEL = fnames + C.STORM_NAMES
TR = ["slide_id", "split", "sample_type", "y", "weight", "morning", "cell_id", "row", "col", "cv_fold"] + MODEL + ["elev_m", "dist_road_m", "usgs1997_lscat"]
dem_, dr_, ff, ls_ = z["dem"].ravel(), z["dist_road"].ravel(), fold.ravel(), lscat.ravel()
def trow(t):
    sid, sp, kind, y, morning, ci, r72, api = t; r, c = divmod(ci, C.WD)
    return [sid, sp, kind, y, wsp[sp] if y else 1.0, morning, ci, r, c, int(ff[ci])] + [float(v) for v in Xs[ci]] + [r72, api, float(C.trigger_T(r72, api)), float(dem_[ci]), float(dr_[ci]), int(ls_[ci])]
ROWS = [trow(t) for t in T]

# ---------------------------------------------------------------- 5. first honest check: fit on train, score the later slides
A = np.array([r[10:10 + len(MODEL)] for r in ROWS], float); y = np.array([r[3] for r in ROWS]); wt = np.array([r[4] for r in ROWS], float)
sp = np.array([r[1] for r in ROWS]); kind = np.array([r[2] for r in ROWS])
tr = sp == "train"
model = GroundTruthGBM(n_trees=120, eta=0.06, max_depth=3, min_leaf=40, subsample=0.8, colsample=0.8, lam=1.0, early_stop=10 ** 9, seed=0).fit(A[tr], y[tr], wt[tr], names=MODEL)
score = model.raw(A); iS, iT = MODEL.index("slope_max_90m"), MODEL.index("trigger_T")
def three(m, s):
    return dict(overall=round(float(auc(y[m], s[m])), 3), where=round(float(auc(y[m & (kind != "neg_other_morning")], s[m & (kind != "neg_other_morning")])), 3),
                when=round(float(auc(y[m & (kind != "neg_same_morning")], s[m & (kind != "neg_same_morning")])), 3))
te = sp != "train"
BASE = dict(test_slides=sorted(set(r[0] for r, m in zip(ROWS, te) if m)), gbm=three(te, score), slope_alone=three(te, A[:, iS]), trigger_alone=three(te, A[:, iT]),
            gbm_winter2023=three(sp == "test_winter2023", score))
cellS = Xs[:, fnames.index("slope_max_90m")].reshape(C.H, C.WD)
BASE["usgs1997_map"] = dict(mostly_landslide_cells=int(mostly.sum()), share_of_land=round(float(mostly.sum() / land.sum()), 4),
                            auc_slope_vs_mostly_landslide=round(float(auc(mostly[land].astype(int), cellS[land])), 3),
                            slides_within_150m_of_mostly_landslide=sum(1 for s in slides if (C.disk(s["row"], s["col"], 150) & mostly).any()), slides=len(slides))
json.dump(BASE, open(os.path.join(LD, "first_check.json"), "w"), indent=1)
print(json.dumps(BASE))

# ---------------------------------------------------------------- 6. write csv.gz copies and the workbook
def val(v):
    if isinstance(v, (np.floating, float)): return None if not np.isfinite(v) else round(float(v), 6)
    if isinstance(v, (np.integer, np.bool_)): return int(v)
    return v
wb = xlsxwriter.Workbook(OUT, {"constant_memory": True, "nan_inf_to_errors": True})
hdr = wb.add_format({"bold": True, "bg_color": "#222222", "font_color": "#FFFFFF"}); ext = wb.add_format({"bold": True, "bg_color": "#1F4E79", "font_color": "#FFFFFF"})
wrap = wb.add_format({"text_wrap": True, "valign": "top"}); bold = wb.add_format({"bold": True, "font_size": 14})
EXTRA = {"usgs1997_lscat", "usgs1997_class", "dated", "positive_cells", "is_land", "label_mostly_landslide", "nearest_slide_any", "dist_slide_any_m", "gauges", "source_of_rain"}
def sheet(name, cols, rows, widths=None, gz=None):
    ws = wb.add_worksheet(name); i = 0; cw = None
    if gz: cf = gzip.open(gz, "wt", newline="", encoding="utf-8", compresslevel=6); cw = csv.writer(cf); cw.writerow(cols)
    for j, c in enumerate(cols): ws.write(0, j, c, ext if c in EXTRA else hdr); ws.set_column(j, j, (widths or {}).get(c, max(10, min(40, len(c) + 2))))
    ws.freeze_panes(1, 0)
    for i, r in enumerate(rows, 1):
        out = []
        for j, v in enumerate(r):
            v = val(v); out.append("" if v is None else v)
            if v is not None and v != "": ws.write(i, j, v)
        if cw: cw.writerow(out)
    if cw: cf.close()
    ws.autofilter(0, 0, max(1, i), len(cols) - 1)

n = {k: sum(1 for s in slides if s["split"] == k) for k in ("train", "test_winter2023", "later_2023_2026", "test_nov2026_storm", "undated")}
npos = {k: sum(1 for r in ROWS if r[1] == k and r[3]) for k in n}
B = BASE; ws = wb.add_worksheet("README"); ws.set_column(0, 0, 160)
readme = [
    ("GroundTruth San Francisco: landslide training data", bold),
    (f"Built 2026-11-21. Same grid as the rest of the San Francisco package ({C.WD} x {C.H} cells of about 29 m) and the same sheet layout and column names as the Lamorinda workbook. Black headers are columns Lamorinda also has. Blue headers are extras.", None),
    ("Everything here is real: each landslide is a record from the USGS, NASA, the National Weather Service or the California Geological Survey, and the rain is gauge rain. Nothing is simulated.", None),
    ("", None), ("What is in it", bold),
    (f"slides: {len(slides)} landslide records inside the city. {n['train']} dated before October 2022 (train), {n['test_winter2023']} in winter 2022-23 (test), {n['later_2023_2026']} later, {n['undated']} with no exact day. The earlier sheet had 7 dated slides and none to train on.", None),
    (f"training_rows: {len(ROWS):,} rows ({sum(r[3] for r in ROWS)} positive cells: {npos['train']} train, {npos['test_winter2023']} winter 2023, {npos['later_2023_2026']} later). Sampled as train_template.py does, seed 0: every land cell within the slide's radius is a positive on the wettest of the three mornings before it, with 4 same-morning negatives (other places, same storm) and 4 other-morning negatives (random days since October 1981) per positive.", None),
    (f"mapped_landslide_cells: every land cell with its class on the USGS 1997 landslide map of San Francisco County (Open-File Report 97-745 C, from Nilsen's photo-interpreted mapping). {int(mostly.sum()):,} cells ({100 * mostly.sum() / land.sum():.1f}% of the land) are 'mostly landslide'. These are landslides with no date: use them to learn or check WHERE, never WHEN.", None),
    (f"rain_long: daily rain 1921-01-01 to {DATES[-1]} with the soil wetness index and trigger. The downtown gauge alone before July 2008, the city gauge mean after. This is what lets the 1982, 1998, 2007, 2014 and 2017 slides carry a storm.", None),
    ("left_out: records that were checked and not used, with the reason.", None), ("dictionary: every column.", None),
    ("", None), ("How to use it honestly", bold),
    ("1. Train only on split = train. test_winter2023 and later_2023_2026 are for scoring. Cross-validate by cv_fold (1.2 km blocks).", None),
    (f"2. This is still a small set: {n['train']} training slides. Several positions are good to 100 to 300 m only (see precision and radius_m), so many positive cells are near the slide, not on it. Expect noisy WHERE scores. A model trained on Lamorinda's slides and checked on these is a fair second test.", None),
    ("3. Negatives are kept within 150 m of a road, away from every recorded slide, and off ground the USGS mapped as mostly landslide. elev_m and dist_road_m are for reference, not model features.", None),
    ("4. ndvi_2023 and ndvi_change come from 2023 and 2026 satellite scenes. For the 1982 to 2017 slides they describe the ground long after the slide. usgs1997_lscat was mapped before every slide here except 1982, so it is a fair feature for the rest.", None),
    ("5. No landslide in the city is confirmed for the November 2026 storm in the sources pulled, so there is no landslide test for it yet. Flooding is the label that storm does have (see the main San Francisco workbook).", None),
    ("", None), ("First check on this sheet", bold),
    (f"Hand-built gradient boosting from model/gbm.py (120 trees, depth 3, the 14 model features) fitted on split = train and scored on the {len(B['test_slides'])} later slides: AUC {B['gbm']['overall']} overall, {B['gbm']['where']} for WHERE (same storm, other places), {B['gbm']['when']} for WHEN (same places, other days). Slope alone: {B['slope_alone']['where']} for WHERE. Rain trigger alone: {B['trigger_alone']['when']} for WHEN. Read WHERE with care given the position accuracy above. A starting point, not a tuned model.", None),
    (f"On the undated map: slope alone ranks a 'mostly landslide' cell above another land cell {B['usgs1997_map']['auc_slope_vs_mostly_landslide']} of the time. {B['usgs1997_map']['slides_within_150m_of_mostly_landslide']} of the {len(slides)} recorded slides fall within 150 m of mapped landslide ground.", None),
]
for i, (t, f) in enumerate(readme): ws.write(i, 0, t, f or wrap)

sheet("slides", SLC + ["positive_cells"], ([s[c] for c in SLC + ["positive_cells"]] for s in slides), {"what": 70, "source": 60, "where": 40, "precision": 34}, gz=os.path.join(TD, "landslide_slides.csv.gz"))
sheet("training_rows", TR, ROWS, gz=os.path.join(TD, "landslide_training_rows.csv.gz"))
best = np.full((C.H, C.WD), np.inf); bid = np.full((C.H, C.WD), "", object)
for s in slides:
    d = np.hypot(rr - s["row"], cc - s["col"]) * C.CELL_M; m = d < best; best[m] = d[m]; bid[m] = s["slide_id"]
MC = ["cell_id", "row", "col", "lon", "lat", "cv_fold"] + fnames + ["usgs1997_lscat", "usgs1997_class", "label_mostly_landslide", "nearest_slide_any", "dist_slide_any_m"]
def mrows():
    for ci in np.flatnonzero(land.ravel()):
        r, c = divmod(int(ci), C.WD)
        yield [int(ci), r, c, lon[r, c], lat[r, c], int(fold[r, c])] + [float(v) for v in Xs[ci]] + [int(lscat[r, c]), CLS[int(lscat[r, c])], int(mostly[r, c]), bid[r, c], best[r, c]]
sheet("mapped_landslide_cells", MC, mrows(), gz=os.path.join(TD, "landslide_mapped_cells.csv.gz"))
def rrows():
    for i, d in enumerate(DATES):
        r72, api = storm_at(i); yield [d, MM[i], NG[i], SRC[i], API[i], r72, float(C.trigger_T(r72, api))]
sheet("rain_long", ["date", "rain_mm_area_mean", "gauges", "source_of_rain", "api_mm_k0.92", "rain_72h_next_mm", "trigger_T"], rrows(), {"source_of_rain": 26})
sheet("left_out", ["date", "record", "why"], EXCLUDED, {"record": 70, "why": 120})

DICT = [
    ("slides", "slide_id", "label id, SFLnn (this sheet's own numbering, by date)"), ("slides", "date", "day the slide happened or was reported"), ("slides", "split", "train (before 2022-10-01), test_winter2023, later_2023_2026 or undated"),
    ("slides", "where / what", "place and description from the source"), ("slides", "lon, lat, row, col", "position and its grid cell"), ("slides", "radius_m", "label radius: how far from the point a cell still counts as the slide, set from how exact the position is"),
    ("slides", "precision", "how the position was obtained and how exact it is"), ("slides", "source", "inventory or report"), ("slides", "storm_morning", "wettest of the three mornings before the slide"),
    ("slides", "storm_rain_72h_mm, storm_api_mm, storm_trigger_T", "the storm values on that morning"), ("slides", "dated", "False when the source gives only the season"), ("slides", "positive_cells", "positive rows this slide gives in training_rows"),
    ("training_rows", "sample_type", "positive, neg_same_morning (same storm, other place: teaches WHERE) or neg_other_morning (random day: teaches WHEN)"), ("training_rows", "y", "1 = landslide, 0 = none"),
    ("training_rows", "weight", "positives weigh a quarter of the negatives in total, within each split"), ("training_rows", "morning", "the morning the storm values refer to"), ("training_rows", "cell_id", "row * 480 + col"),
    ("training_rows", "cv_fold", "spatial cross-validation fold 0..4 (40 x 40 cell blocks, seed 0)"),
    ("training_rows", "slope_deg, slope_max_90m, relief_150m, northness, eastness, plan_curv, prof_curv, twi, dist_stream_m", "terrain features from USGS 3DEP elevation, exactly as handoff_common_sf.static_features()"),
    ("training_rows", "ndvi_2023, ndvi_change", "Sentinel-2 greenness on 2023-04-19 and its change to 2026-11-04"), ("training_rows", "rain_72h_mm", "gauge rain in the 72 hours after that morning, mm"),
    ("training_rows", "api_mm", "soil wetness index that morning (yesterday's index x 0.92 plus today's rain), mm"), ("training_rows", "trigger_T", "0.55*min(1.5, r72/200) + 0.45*min(1.3, api/200)"),
    ("training_rows", "elev_m, dist_road_m", "for reference, not model features"), ("training_rows", "usgs1997_lscat", "class on the USGS 1997 landslide map: 8 mostly landslide, 6 few landslides, 3 surficial deposits, 2 water, 0 outside the map"),
    ("mapped_landslide_cells", "label_mostly_landslide", "1 where the USGS 1997 map shows mostly landslide ground (undated)"), ("mapped_landslide_cells", "nearest_slide_any, dist_slide_any_m", "nearest recorded slide and the distance to it"),
    ("rain_long", "gauges, source_of_rain", "how many gauges reported and which record the day comes from"),
]
ws = wb.add_worksheet("dictionary")
for j, (h, w_) in enumerate([("sheet", 24), ("column", 60), ("meaning", 120)]): ws.write(0, j, h, hdr); ws.set_column(j, j, w_)
for i, r in enumerate(DICT, 1): ws.write_row(i, 0, r)
wb.close()
print("slides", len(slides), n, "rows", len(ROWS), npos, "mostly landslide cells", int(mostly.sum()), os.path.getsize(OUT) // 1000, "KB")
for s in slides: print(s["slide_id"], s["date"], s["split"], s["where"][:50], s["radius_m"], s["positive_cells"], s["storm_morning"], s["storm_rain_72h_mm"] and round(s["storm_rain_72h_mm"]), s["storm_api_mm"] and round(s["storm_api_mm"]))
