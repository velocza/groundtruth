"""Export every piece of San Francisco training data into one Excel workbook, in the same layout as the Lamorinda
workbook (same sheet names, same column names and order for the shared columns; San Francisco extras come after).

Run: python3 04_export_training_data_sf.py <repo root> <out.xlsx>
"""
import gzip, csv, json, os, sys, collections
import numpy as np
import xlsxwriter

ROOT = sys.argv[1]; OUT = sys.argv[2]
sys.path.insert(0, os.path.join(ROOT, "model"))
import handoff_common_sf as C
from gbm import spatial_blocks

D = os.path.join(ROOT, "dataset_sf")
z = np.load(os.path.join(D, "grid_480x456_all_layers.npz")); META = json.load(open(os.path.join(D, "meta.json")))
rain = C.Rain(); NDAY = len(rain.dates)
HOLD = "2022-10-01"
def split_of(date):
    if date < rain.dates[0]: return "before_rain_record"
    if date < HOLD: return "train"
    if date < "2023-10-01": return "test_winter2023"
    if date < "2026-11-01": return "later_2023_2026"
    return "test_nov2026_storm"
def storm_at(i):                                  # same as C.Rain.storm_at, but safe at the end of the record
    return float(rain.mm[i + 1:i + 4].sum()), float(rain.api[i])
def before_report(date):
    d = rain.idx[date]; best = max(range(max(0, d - 3), d), key=lambda i: C.trigger_T(*storm_at(i)))
    return (best,) + storm_at(best)

land = z["land"]; rr, cc = np.mgrid[0:C.H, 0:C.WD]
lon = C.W + (cc + 0.5) / C.WD * (C.E - C.W); lat = C.N - (rr + 0.5) / C.H * (C.N - C.S)
fold = spatial_blocks(rr.ravel(), cc.ravel(), block=40, k=5, seed=0).reshape(C.H, C.WD)
Xs, fnames = C.static_features()
F = {n: Xs[:, i].reshape(C.H, C.WD) for i, n in enumerate(fnames)}
road_ok = (z["dist_road"] < 150) & land

# ---------------------------------------------------------------- landslides
slides = [dict(r) for r in csv.DictReader(open(os.path.join(D, "landslide_events_san_francisco.csv")))]
for i, s in enumerate(slides):
    s["slide_id"] = f"SF{i + 1:02d}"; s["lon"], s["lat"] = float(s["lon"]), float(s["lat"]); s["radius_m"] = float(s["radius_m"])
    s["row"], s["col"] = C.cell_of(s["lon"], s["lat"]); s["split"] = split_of(s["date"])
    if s["date"] in rain.idx:
        b, r72, api = before_report(s["date"]); s["storm_morning"], s["storm_rain_72h_mm"], s["storm_api_mm"] = rain.dates[b], r72, api
        s["storm_trigger_T"] = float(C.trigger_T(r72, api))
    else: s["storm_morning"] = s["storm_rain_72h_mm"] = s["storm_api_mm"] = s["storm_trigger_T"] = None
def nearest(pred):
    best = np.full((C.H, C.WD), np.inf); bid = np.full((C.H, C.WD), "", object)
    for s in slides:
        if not pred(s): continue
        d = np.hypot(rr - s["row"], cc - s["col"]) * C.CELL_M; m = d < best; best[m] = d[m]; bid[m] = s["slide_id"]
    return best, bid
dtr, idtr = nearest(lambda s: s["split"] == "train"); dte, idte = nearest(lambda s: s["split"] == "test_winter2023")
dany, idany = nearest(lambda s: True)
cgs = list(csv.DictReader(open(os.path.join(D, "cgs_landslide_inventory_san_francisco.csv"))))
dcgs = np.full((C.H, C.WD), np.inf)
for q in cgs:
    r, c = C.cell_of(float(q["lon"]), float(q["lat"])); dcgs = np.minimum(dcgs, np.hypot(rr - r, cc - c) * C.CELL_M)

# ---------------------------------------------------------------- floods (SF 311)
FL = list(csv.DictReader(open(os.path.join(D, "flood_reports_311_san_francisco.csv"))))
cnt = {k: np.zeros((C.H, C.WD), np.int32) for k in ("train", "test_winter2023", "later_2023_2026", "test_nov2026_storm")}
rainy = np.zeros(NDAY, bool); rainy[1:] = (rain.mm[1:] + rain.mm[:-1]) >= 5.0; rainy[0] = rain.mm[0] >= 5
day_cells = collections.defaultdict(set)          # day index -> cells with a report on a rain day
for q in FL:
    q["row"], q["col"] = int(q["row"]), int(q["col"]); q["split"] = split_of(q["date"]); d = rain.idx[q["date"]]
    q["rain_day_mm"] = float(rain.mm[d]); q["rain_prev_day_mm"] = float(rain.mm[d - 1]) if d else 0.0; q["rain_linked"] = int(rainy[d])
    q["api_mm"] = float(rain.api[d]); q["cell_id"] = q["row"] * C.WD + q["col"]
    if q["rain_linked"]:
        cnt[q["split"]][q["row"], q["col"]] += 1; day_cells[d].add(q["cell_id"])
dry_cnt = np.zeros((C.H, C.WD), np.int32)
for q in FL:
    if not q["rain_linked"]: dry_cnt[q["row"], q["col"]] += 1

# ---------------------------------------------------------------- per-cell table (same first columns as Lamorinda)
nb = np.array(META["neighborhoods"], object)
cells = [
    ("cell_id", rr * C.WD + cc), ("row", rr), ("col", cc), ("lon", lon), ("lat", lat),
    ("elev_m", z["dem"]), ("aspect_deg", z["aspect"]), ("dist_road_m", z["dist_road"]),
] + [(n, F[n]) for n in fnames] + [
    ("ndvi_2026", z["ndvi_2026"]),
    ("buildings_count", z["buildings_count"]), ("buildings_footprint_m2", z["buildings_footprint_m2"]),
    ("cv_fold", fold),
    ("nearest_train_slide", idtr), ("dist_train_slide_m", dtr), ("label_train_150m", (dtr <= 150).astype(int)),
    ("nearest_test_slide", idte), ("dist_test_slide_m", dte), ("label_test2023_150m", (dte <= 150).astype(int)),
    # ---- San Francisco extras
    ("is_land", land.astype(int)), ("neighborhood", nb[z["neighborhood_id"]]),
    ("nearest_slide_any", idany), ("dist_slide_any_m", dany), ("dist_cgs_mapped_slide_m", dcgs),
    ("relief_m", z["relief"]), ("sink_depth_m", z["sink_depth"]), ("low_vs_150m_m", z["low_150"]), ("low_vs_450m_m", z["low_450"]),
    ("elev_above_min_300m_m", z["elev_above_min_300"]), ("log10_drain_area_m2", z["log_flow_acc"]), ("dist_open_water_m", z["dist_water"]),
    ("built_frac_70m", z["built_frac"]),
    ("ndvi_2017_03_31", z["ndvi_2017"]), ("ndvi_2021_10_16", z["ndvi_2021pre"]), ("ndvi_2021_11_20", z["ndvi_2021post"]), ("ndvi_2022_10_26", z["ndvi_2022"]),
    ("ndvi_2023_01_24", z["ndvi_2023jan"]), ("ndvi_2026_04_03", z["ndvi_2026apr"]), ("ndvi_2026_11_11", z["ndvi_2026nov11"]),
    ("ndmi_2022_10_26", z["ndmi_2022"]), ("ndmi_2023_01_24", z["ndmi_2023jan"]), ("ndmi_2023_04_19", z["ndmi_2023"]), ("ndmi_2026_11_04", z["ndmi_2026"]), ("ndmi_2026_11_11", z["ndmi_2026nov11"]),
    ("flood_reports_train", cnt["train"]), ("flood_reports_test_winter2023", cnt["test_winter2023"]), ("flood_reports_later_2023_2026", cnt["later_2023_2026"]),
    ("flood_reports_test_nov2026", cnt["test_nov2026_storm"]), ("flood_reports_dry_days_all_years", dry_cnt),
    ("label_flood_train", (cnt["train"] > 0).astype(int)), ("label_flood_test_nov2026", (cnt["test_nov2026_storm"] > 0).astype(int)),
]
cell_cols = [c for c, _ in cells]; cellarr = dict(cells)
FLOOD_EXTRA = ["sink_depth_m", "low_vs_150m_m", "low_vs_450m_m", "elev_above_min_300m_m", "log10_drain_area_m2", "dist_open_water_m", "built_frac_70m", "flood_reports_train"]

# ---------------------------------------------------------------- landslide training rows, sampled exactly as train_template.build_rows
rng = np.random.default_rng(0)
near_any = np.zeros((C.H, C.WD), bool)
dated = [s for s in slides if s["date"] in rain.idx]
for s in dated: near_any |= C.disk(s["row"], s["col"], 450)
neg_pool = np.flatnonzero((road_ok & ~near_any).ravel())
T = []
for s in dated:
    b, r72, api = before_report(s["date"])
    pos = np.flatnonzero((C.disk(s["row"], s["col"], s["radius_m"]) & land).ravel())
    k = len(pos) * 8 // 2
    same = rng.choice(neg_pool, k); other = rng.choice(np.r_[pos, rng.choice(neg_pool, k)], k); days = rng.integers(0, rain.n, k)
    for kind, idx, dayidx in (("positive", pos, np.full(len(pos), b)), ("neg_same_morning", same, np.full(k, b)), ("neg_other_morning", other, days)):
        for ci, di in zip(idx, dayidx):
            r72_, api_ = storm_at(int(di)); T.append((s["slide_id"], s["split"], kind, int(kind == "positive"), rain.dates[int(di)], int(ci), r72_, api_))

# ---------------------------------------------------------------- flood training rows: same design, one positive per (rain day, cell with a report)
rngf = np.random.default_rng(1)
pool = np.flatnonzero(road_ok.ravel()); TF = []
for d in sorted(day_cells):
    if d == 0: continue
    b = max(range(max(0, d - 3), d), key=lambda i: C.trigger_T(*storm_at(i))); r72, api = storm_at(b); sp = split_of(rain.dates[d])
    pos = np.array(sorted(day_cells[d])); near = np.zeros(C.H * C.WD, bool)
    for dr in (-2, -1, 0, 1, 2):
        for dc in (-2, -1, 0, 1, 2):
            near[np.clip(pos + dr * C.WD + dc, 0, C.H * C.WD - 1)] = True
    k = len(pos) * 2
    cand = rngf.choice(pool, k * 2); same = cand[~near[cand]][:k]
    oth_cells = rngf.choice(np.r_[pos, rngf.choice(pool, k)], k); oth_days = rngf.integers(0, rain.n, k)
    ok = np.array([int(c_) not in day_cells.get(int(dd) + 1, ()) and int(c_) not in day_cells.get(int(dd) + 2, ()) and int(c_) not in day_cells.get(int(dd) + 3, ()) for c_, dd in zip(oth_cells, oth_days)], bool)
    fid = "F" + rain.dates[d].replace("-", "")
    for kind, idx, dayidx in (("positive", pos, np.full(len(pos), b)), ("neg_same_morning", same, np.full(len(same), b)), ("neg_other_morning", oth_cells[ok], oth_days[ok])):
        for ci, di in zip(idx, dayidx):
            r72_, api_ = storm_at(int(di)); TF.append((fid, sp, kind, int(kind == "positive"), rain.dates[int(di)], int(ci), r72_, api_))
print("landslide rows", len(T), "flood rows", len(TF), "flood positives", sum(t[3] for t in TF), "rain-linked report days", len(day_cells))

# ---------------------------------------------------------------- write
wb = xlsxwriter.Workbook(OUT, {"constant_memory": True, "nan_inf_to_errors": True})
hdr = wb.add_format({"bold": True, "bg_color": "#222222", "font_color": "#FFFFFF"})
ext = wb.add_format({"bold": True, "bg_color": "#1F4E79", "font_color": "#FFFFFF"})
wrap = wb.add_format({"text_wrap": True, "valign": "top"}); bold = wb.add_format({"bold": True, "font_size": 14})
LAM_COLS = set("cell_id row col lon lat elev_m aspect_deg dist_road_m ndvi_2026 buildings_count buildings_footprint_m2 cv_fold nearest_train_slide dist_train_slide_m label_train_150m nearest_test_slide dist_test_slide_m label_test2023_150m slide_id date split town where what radius_m precision source storm_morning storm_rain_72h_mm storm_api_mm storm_trigger_T sample_type y weight morning rain_mm_area_mean stations_reporting rain_3d_mm rain_7d_mm rain_30d_mm api_mm_k0.92 rain_72h_next_mm trigger_T".split()) | set(fnames) | set(C.STORM_NAMES)

def val(v):
    if isinstance(v, (np.floating, float)): return None if not np.isfinite(v) else round(float(v), 6)
    if isinstance(v, np.integer): return int(v)
    if isinstance(v, np.bool_): return int(v)
    return v
CSV_DIR = os.environ.get("GT_CSV_DIR")            # optional: also write the big sheets as csv.gz (the workbook is over GitHub's 100 MB limit)
CSV_SHEETS = {"slides", "training_rows", "training_rows_flood", "flood_days", "cells"}
def sheet(name, cols, rows, widths=None, shared=None):
    ws = wb.add_worksheet(name); i = 0; cw = None
    if CSV_DIR and name in CSV_SHEETS:
        os.makedirs(CSV_DIR, exist_ok=True)
        cf = gzip.open(os.path.join(CSV_DIR, name + ".csv.gz"), "wt", newline="", encoding="utf-8", compresslevel=6); cw = csv.writer(cf); cw.writerow(cols)
    for j, c in enumerate(cols):
        ws.write(0, j, c, hdr if (shared if shared is not None else c in LAM_COLS) else ext); ws.set_column(j, j, (widths or {}).get(c, max(10, min(40, len(c) + 2))))
    ws.freeze_panes(1, 0)
    for i, r in enumerate(rows, 1):
        out = []
        for j, v in enumerate(r):
            v = val(v); out.append("" if v is None else v)
            if v is not None and v != "": ws.write(i, j, v)
        if cw: cw.writerow(out)
    if cw: cf.close()
    ws.autofilter(0, 0, max(1, i), len(cols) - 1); return ws

k18 = rain.idx["2026-11-18"]; nsp = collections.Counter(q["split"] for q in FL if q["rain_linked"])
readme = [
    ("GroundTruth San Francisco: all ML training data in one workbook", bold),
    (f"Built 2026-11-21. Area: San Francisco (city mainland). Box {C.W} to {C.E} lon, {C.S} to {C.N} lat. Grid {C.WD} columns x {C.H} rows of about 29 m (218,880 cells, {int(land.sum()):,} on land). Same grid shape, cell size, sheet names and column names as the Lamorinda workbook (groundtruth_training_data.xlsx). Black headers are columns the Lamorinda workbook also has, in the same order. Blue headers are San Francisco extras.", None),
    ("EVERYTHING in this workbook is real. There are no simulated columns. Ground motion (NASA OPERA DISP-S1) is left out because it needs a NASA Earthdata login; it was not simulated.", None),
    ("", None), ("Sheets", bold),
    ("cells: every grid cell with the exact model features from handoff_common.static_features(), then flood terrain features, seven more Sentinel-2 dates, neighbourhood, and labels.", None),
    (f"slides: all {len(slides)} landslide records inside the box (USGS January 2023 reconnaissance inventory, NWS storm reports, the dated California Geological Survey points). San Francisco has few: {sum(s['split'] == 'train' for s in slides)} fall in the training period, so use them as a test set, not to train.", None),
    (f"training_rows: {len(T):,} landslide rows sampled exactly as train_template.py does (seed 0, 8 negatives per positive). Same columns as the Lamorinda sheet minus the simulated ones.", None),
    (f"flood_reports: {len(FL):,} flooding reports to the city (SF 311, service Sewer / Flooding), July 2008 to 20 November 2026, each with address, time, cell and that day's rain. rain_linked = 1 when at least 5 mm fell that day or the day before ({sum(q['rain_linked'] for q in FL):,} reports). The rest are dry-day reports (blocked drains, broken pipes) and are not storm labels.", None),
    (f"training_rows_flood: {len(TF):,} ready-to-train flood rows ({sum(t[3] for t in TF):,} positive). One positive per rain day and cell with a report, 2 same-morning negatives and up to 2 other-morning negatives each. Same columns as training_rows, then the flood features.", None),
    ("flood_days: one row per day with at least one rain-linked report: reports, rain, soil wetness. The storm ranking.", None),
    ("rain_daily: daily rain 2008-07-01 to 2026-11-20. Same first nine columns as Lamorinda, then the downtown gauge, SFO airport, hourly peak, ERA5 soil moisture and the daily flood report count.", None),
    ("rain_downtown_1921: the downtown San Francisco gauge every day since 1921 (38,000 days).", None),
    ("storm_nov2026_hourly: hour by hour rain and soil moisture, 7 October to 27 November 2026 (model analysis, then forecast from 21 November noon).", None),
    ("nws_storm_reports: every National Weather Service storm report in the city since 2008 (floods, wind, hail, landslides) with time and position.", None),
    ("cgs_inventory: the mapped landslides the state inventory holds inside the box (mostly undated, coastal bluffs and the south edge).", None),
    ("dictionary: every column, its units, source and whether the model uses it.", None),
    ("", None), ("The storm happening now (November 2026)", bold),
    (f"13 Nov: {rain.mm[rain.idx['2026-11-13']]:.1f} mm. 15 to 16 Nov: {rain.mm[rain.idx['2026-11-15']] + rain.mm[rain.idx['2026-11-16']]:.1f} mm. 18 Nov: {rain.mm[k18]:.1f} mm at the downtown gauge (2.64 in), a record for the date (old record 2.24 in, 1918; NWS Record Event Report). Soil wetness index that morning: {rain.api[k18 - 1]:.0f} mm. 18 November has the most flood reports of any day in the 18 year record ({sum(1 for q in FL if q['date'] == '2026-11-18')}; next is 31 December 2022 with {sum(1 for q in FL if q['date'] == '2022-12-31')}).", None),
    (f"split = test_nov2026_storm marks every label from 1 November 2026 on ({nsp['test_nov2026_storm']:,} rain-linked flood reports). Train on split = train ({nsp['train']:,} reports), check on test_winter2023 ({nsp['test_winter2023']:,}), and score once on the November 2026 storm. No landslide inside the city has been confirmed for this storm in the sources pulled (NWS storm reports through 19 November list flooding only).", None),
    ("After 14 November only the downtown gauge had reported when this was built (stations_reporting = 1), so the last six days of rain_mm_area_mean are that one gauge.", None),
    ("", None), ("Rules that keep the result honest (same as Lamorinda)", bold),
    ("1. Never train on anything dated 2022-10-01 or later. flood_reports_train and label_flood_train only count reports before that date, so they are fair inputs when scoring the test splits. Inside split = train they contain the training positives themselves, so there they leak: leave them out when fitting, or recount them out of fold. The other flood_reports_* columns are test labels.", None),
    ("2. Cross-validate by cv_fold (1.2 km blocks), not random rows.", None),
    ("3. Elevation and distance to road are in the table for reference but left out of the landslide model on purpose. 311 reports only come from where people are, so keep negatives near roads (the sampling here does).", None),
    ("First check done on this sheet (hand-built gradient boosting from model/gbm.py, 120 trees, the 14 model features plus the flood terrain features, flood_reports_train left out, trained on split = train only): on the November 2026 storm it ranks a reported flood cell above an unreported one 0.90 of the time overall (AUC), 0.83 for WHERE within the same storm and 0.96 for WHEN. Winter 2023: 0.86, 0.76, 0.96. Slope alone scores 0.69 on WHERE, wetness index alone 0.72. A starting point to beat, not a tuned model.", None),
    ("4. The site's landslide formula was not tuned for flat ground. Flooding is a different hazard: it collects in low, flat, paved places. Train it as its own model on training_rows_flood.", None),
]
ws = wb.add_worksheet("README"); ws.set_column(0, 0, 160)
for i, (t, f) in enumerate(readme): ws.write(i, 0, t, f or wrap)

S2D = {k: v["date"] for k, v in META["sentinel2"].items()}
DICT = {
    "cell_id": ("row * 480 + col; joins cells to the training sheets", "", "derived"), "row": ("grid row, 0 = north edge", "", "grid"), "col": ("grid column, 0 = west edge", "", "grid"),
    "lon": ("cell centre longitude", "deg", "grid"), "lat": ("cell centre latitude", "deg", "grid"),
    "elev_m": ("ground elevation, 0 on open water (NOT a landslide model feature)", "m", "USGS 3DEP via AWS Terrain Tiles"),
    "aspect_deg": ("direction the slope faces, clockwise from north", "deg", "USGS 3DEP"),
    "dist_road_m": ("distance to the nearest road (NOT a model feature: reporting bias)", "m", "Overture Maps " + META["overture"]),
    "slope_deg": ("slope of the cell", "deg", "USGS 3DEP"), "slope_max_90m": ("steepest slope within one cell (3x3 window)", "deg", "USGS 3DEP"),
    "relief_150m": ("highest minus lowest ground within 150 m (5x5 window)", "m", "USGS 3DEP"),
    "northness": ("cos(aspect) * sin(slope)", "-1..1", "USGS 3DEP"), "eastness": ("sin(aspect) * sin(slope)", "-1..1", "USGS 3DEP"),
    "plan_curv": ("curvature across the slope", "1/m", "USGS 3DEP"), "prof_curv": ("curvature down the slope", "1/m", "USGS 3DEP"),
    "twi": ("topographic wetness index ln(area / tan slope)", "", "USGS 3DEP"), "dist_stream_m": ("distance to nearest drainage line", "m", "USGS 3DEP flow routing"),
    "ndvi_2023": ("greenness, 2023-04-19 (same scene date as Lamorinda)", "-1..1", "Sentinel-2 L2A tile 10SEG"), "ndvi_change": ("ndvi_2026 minus ndvi_2023", "", "Sentinel-2"),
    "ndvi_2026": ("greenness, 2026-11-04 (same scene date as Lamorinda)", "-1..1", "Sentinel-2 L2A tile 10SEG"),
    "buildings_count": ("building centroids in the cell", "count", "Overture Maps buildings"), "buildings_footprint_m2": ("total building footprint in the cell", "m2", "Overture Maps buildings"),
    "cv_fold": ("spatial cross-validation fold 0..4 (40x40 cell blocks, seed 0, same as train_template)", "", "derived"),
    "nearest_train_slide": ("slide_id of nearest landslide before 2022-10-01", "", "slides sheet"), "dist_train_slide_m": ("distance to it", "m", "derived"),
    "label_train_150m": ("1 if within 150 m of a training landslide", "0/1", "derived"),
    "nearest_test_slide": ("slide_id of nearest HELD-OUT winter 2023 landslide", "", "slides sheet"), "dist_test_slide_m": ("distance to it", "m", "derived"),
    "label_test2023_150m": ("1 if within 150 m of a winter 2023 landslide. TEST ONLY", "0/1", "derived"),
    "is_land": ("1 on land, 0 on ocean, bay or lake", "0/1", "Sentinel-2 scene classification + elevation"), "neighborhood": ("city neighbourhood (from the nearest 311 report's neighbourhood)", "", "SF 311"),
    "nearest_slide_any": ("slide_id of the nearest landslide record of any date", "", "slides sheet"), "dist_slide_any_m": ("distance to it", "m", "derived"),
    "dist_cgs_mapped_slide_m": ("distance to the nearest landslide mapped in the state inventory", "m", "California Geological Survey"),
    "relief_m": ("highest minus lowest ground within about 130 m (9x9 window)", "m", "USGS 3DEP"),
    "sink_depth_m": ("how deep water would pond here before spilling (priority-flood fill minus ground)", "m", "USGS 3DEP"),
    "low_vs_150m_m": ("ground height minus the mean within 150 m; negative = a dip", "m", "USGS 3DEP"), "low_vs_450m_m": ("same within 450 m", "m", "USGS 3DEP"),
    "elev_above_min_300m_m": ("height above the lowest ground within 300 m", "m", "USGS 3DEP"),
    "log10_drain_area_m2": ("log10 of the area that drains through the cell", "log10 m2", "USGS 3DEP flow routing"),
    "dist_open_water_m": ("distance to the ocean, the bay or a lake", "m", "derived"), "built_frac_70m": ("share of ground under roofs within about 70 m", "0..1", "Overture Maps buildings"),
    "flood_reports_train": ("rain-linked flood reports in the cell before 2022-10-01 (safe as a feature)", "count", "SF 311"),
    "flood_reports_test_winter2023": ("same, 2022-10-01 to 2023-09-30. TEST LABEL", "count", "SF 311"),
    "flood_reports_later_2023_2026": ("same, 2023-10-01 to 2026-10-31", "count", "SF 311"),
    "flood_reports_test_nov2026": ("same, from 2026-11-01: the storm happening now. TEST LABEL", "count", "SF 311"),
    "flood_reports_dry_days_all_years": ("flood reports on days without rain (drains, pipes)", "count", "SF 311"),
    "label_flood_train": ("1 if flood_reports_train > 0", "0/1", "SF 311"), "label_flood_test_nov2026": ("1 if a flood was reported here in the November 2026 storm. TEST ONLY", "0/1", "SF 311"),
    "slide_id": ("label id: SFnn for a landslide, Fyyyymmdd for a flood day", "", ""), "split": ("train (before 2022-10-01), test_winter2023, later_2023_2026 or test_nov2026_storm", "", ""),
    "sample_type": ("positive, neg_same_morning (same storm, other place: teaches WHERE) or neg_other_morning (random day: teaches WHEN)", "", "train_template.build_rows"),
    "y": ("1 = slide or flood report, 0 = none", "0/1", ""), "morning": ("the morning the storm values refer to", "date", ""),
    "rain_72h_mm": ("rain in the 72 hours after that morning (gauge rain as a perfect forecast)", "mm", "NOAA gauges"),
    "api_mm": ("soil wetness (antecedent precipitation index, decay 0.92/day) that morning", "mm", "NOAA gauges"),
    "trigger_T": ("site rain trigger 0.55*min(1.5, r72/200) + 0.45*min(1.3, api/200)", "", "derived"),
    "weight": ("positives weigh a quarter of the negatives in total, within each split", "", "derived"),
}
for k, d_ in S2D.items():
    tag = d_.replace("-", "_"); DICT[f"ndvi_{tag}"] = (f"greenness on {d_}", "-1..1", "Sentinel-2 L2A " + META["sentinel2"][k]["scene"]); DICT[f"ndmi_{tag}"] = (f"moisture index (NIR, SWIR) on {d_}", "-1..1", "Sentinel-2 L2A " + META["sentinel2"][k]["scene"])
model_feats = fnames + C.STORM_NAMES
ws = wb.add_worksheet("dictionary")
for j, (h, w) in enumerate([("sheet", 20), ("column", 30), ("meaning", 90), ("units", 10), ("source", 44), ("real or simulated", 16), ("model feature?", 14), ("also in Lamorinda workbook?", 16)]):
    ws.write(0, j, h, hdr); ws.set_column(j, j, w)
ws.freeze_panes(1, 0); di_ = [1]
def drow(sh, c, meaning=None, units="", src=""):
    d = DICT.get(c, (meaning or "", units, src))
    ws.write_row(di_[0], 0, [sh, c, d[0], d[1], d[2], "real", "yes" if c in model_feats else ("flood extra" if c in FLOOD_EXTRA else ""), "yes" if c in LAM_COLS else ""]); di_[0] += 1
for c in cell_cols: drow("cells", c)
SLC = ["slide_id", "date", "split", "town", "where", "what", "lon", "lat", "row", "col", "radius_m", "precision", "source", "storm_morning", "storm_rain_72h_mm", "storm_api_mm", "storm_trigger_T"]
for c in SLC:
    drow("slides", c, {"date": "date the slide was reported", "town": "town", "where": "place", "what": "what happened", "precision": "how exact the position is", "source": "inventory or report",
                       "radius_m": "label radius used", "storm_morning": "wettest of the three mornings before the report", "storm_rain_72h_mm": "rain_72h_mm on that morning",
                       "storm_api_mm": "api_mm on that morning", "storm_trigger_T": "trigger_T on that morning"}.get(c, ""), src="USGS, NWS, CGS")
TR = ["slide_id", "split", "sample_type", "y", "weight", "morning", "cell_id", "row", "col", "cv_fold"] + model_feats + ["elev_m", "dist_road_m"]
for c in TR: drow("training_rows", c)
TRF = TR + FLOOD_EXTRA + ["buildings_count"]
for c in TRF: drow("training_rows_flood", c)
RD = ["date", "rain_mm_area_mean", "stations_reporting", "rain_3d_mm", "rain_7d_mm", "rain_30d_mm", "api_mm_k0.92", "rain_72h_next_mm", "trigger_T",
      "downtown_gauge_mm", "sfo_airport_mm", "sfo_max_1h_mm", "era5_rain_mm", "era5_max_1h_mm", "soil_moisture_0_7cm", "soil_moisture_7_28cm", "soil_moisture_28_100cm", "flood_reports_311"]
RDM = {"date": "day", "rain_mm_area_mean": "mean rain across reporting city gauges (downtown, Oceanside, 7 CoCoRaHS)", "stations_reporting": "gauges with a reading",
       "rain_3d_mm": "rain over the last 3 days", "rain_7d_mm": "last 7 days", "rain_30d_mm": "last 30 days", "api_mm_k0.92": "soil wetness index (same as api_mm)",
       "rain_72h_next_mm": "rain in the next 3 days (same as rain_72h_mm)", "trigger_T": "site rain trigger", "downtown_gauge_mm": "downtown San Francisco gauge alone",
       "sfo_airport_mm": "SFO airport, 13 km south (outside the box)", "sfo_max_1h_mm": "wettest hour of the day at SFO, from 2015-10 (rain intensity drives street flooding)",
       "era5_rain_mm": "model reanalysis rain over the city (not a gauge)", "era5_max_1h_mm": "wettest hour in the reanalysis",
       "soil_moisture_0_7cm": "soil water content, top 7 cm, daily mean (reanalysis)", "soil_moisture_7_28cm": "7 to 28 cm", "soil_moisture_28_100cm": "28 to 100 cm",
       "flood_reports_311": "flood reports to the city that day"}
for c in RD: drow("rain_daily", c, RDM[c], "m3/m3" if "soil" in c else ("mm" if "mm" in c else ""), "ERA5 / ERA5-Land via Open-Meteo" if ("era5" in c or "soil" in c) else ("SF 311" if "311" in c else ("NWS ASOS via Iowa Environmental Mesonet" if "sfo" in c else "NOAA GHCN-Daily, NWS co-op")))
ws.autofilter(0, 0, di_[0] - 1, 7)

sheet("slides", SLC, ([s[c] for c in SLC] for s in slides), {"what": 70, "source": 60, "where": 40, "precision": 34})

def w_of(rows_):
    o = {}
    for sp in set(t[1] for t in rows_):
        p_ = sum(1 for t in rows_ if t[1] == sp and t[3]); n_ = sum(1 for t in rows_ if t[1] == sp and not t[3]); o[sp] = n_ / max(1, p_) / 4
    return o
def trows(rows_, extra):
    tw = w_of(rows_); ex = [cellarr[c].ravel() for c in extra]; dem_, dr_ = z["dem"].ravel(), z["dist_road"].ravel(); ff = fold.ravel()
    for sid, sp, kind, y, morning, ci, r72, api in rows_:
        r, c = divmod(ci, C.WD)
        yield [sid, sp, kind, y, tw[sp] if y else 1.0, morning, ci, r, c, ff[ci]] + list(Xs[ci]) + [r72, api, float(C.trigger_T(r72, api)), dem_[ci], dr_[ci]] + [e_[ci] for e_ in ex]
sheet("training_rows", TR, trows(T, []))
sheet("training_rows_flood", TRF, trows(TF, FLOOD_EXTRA + ["buildings_count"]), shared=False)

FC = ["id", "dt", "date", "split", "rain_linked", "rain_day_mm", "rain_prev_day_mm", "api_mm", "where", "address", "neighborhood", "district", "lon", "lat", "row", "col", "cell_id", "source", "status"]
sheet("flood_reports", FC, ([q[c] if c not in ("lon", "lat") else float(q[c]) for c in FC] for q in FL), {"address": 46, "dt": 20}, shared=False)
byday = collections.Counter(q["date"] for q in FL if q["rain_linked"])
def fdays():
    for d_, n_ in sorted(byday.items(), key=lambda kv: -kv[1]):
        k = rain.idx[d_]; b, r72, api = before_report(d_) if k else (0, 0, 0)
        yield [d_, split_of(d_), n_, len(day_cells[k]), float(rain.mm[k]), float(rain.mm[k - 1]), float(rain.api[k - 1]), rain.dates[b], r72, api, float(C.trigger_T(r72, api))]
sheet("flood_days", ["date", "split", "flood_reports", "cells_with_report", "rain_day_mm", "rain_prev_day_mm", "api_prev_morning_mm", "storm_morning", "storm_rain_72h_mm", "storm_api_mm", "storm_trigger_T"], fdays(), shared=False)

flat = [np.asarray(a).ravel() for _, a in cells]
sheet("cells", cell_cols, (tuple(a[k] for a in flat) for k in range(C.H * C.WD)))

rows = list(csv.DictReader(open(os.path.join(D, "rainfall_daily_san_francisco.csv"))))
def rrows():
    for k, r in enumerate(rows):
        nx = sum(float(rows[k + d]["rain_mm_area_mean"] or 0) for d in (1, 2, 3)) if k + 3 < len(rows) else None
        api = float(r["api_mm_k0.92"] or 0)
        yield [r["date"]] + [float(r[c]) if r[c] not in ("", None) else None for c in RD[1:7]] + [nx, float(C.trigger_T(nx, api)) if nx is not None else None] + [float(r[c]) if r[c] not in ("", None) else None for c in RD[9:]]
sheet("rain_daily", RD, rrows())
sheet("rain_downtown_1921", ["date", "rain_mm", "source"], ([r["date"], float(r["rain_mm"]), r["source"]] for r in csv.DictReader(open(os.path.join(D, "rainfall_downtown_since_1921.csv")))), shared=False)
def gen(path, num=()):
    rd = csv.reader(open(os.path.join(D, path))); h = next(rd)
    def conv(v):
        try: return float(v)
        except ValueError: return v
    return h, ([conv(v) if j not in num else v for j, v in enumerate(r)] for r in rd)
h, it = gen("storm_nov2026_hourly_model.csv", num=(0, 1)); sheet("storm_nov2026_hourly", h, it, {"local_time": 18}, shared=False)
h, it = gen("nws_storm_reports_san_francisco.csv", num=(0, 1, 2, 7, 8, 9)); sheet("nws_storm_reports", h, it, {"remark": 100, "utc": 18}, shared=False)
h, it = gen("cgs_landslide_inventory_san_francisco.csv", num=(0, 4, 6, 7, 10, 11)); sheet("cgs_inventory", h, it, {"evidence": 50, "citation": 50}, shared=False)
wb.close()
print("done", OUT, os.path.getsize(OUT) // 1_000_000, "MB")
