"""Storm Response: how fast fire and EMS units reached San Francisco calls during the November 18, 2026 storm,
against dry days matched on weekday, local hour and incident type. Also packs the bundle for the Storm Response view.

Real data only. Inputs:
  <raw>/gtsr_fire_YYYY-MM.csv.gz          DataSF "Fire Department and Emergency Medical Services Dispatched Calls for Service"
                                          (data.sfgov.org dataset nuek-vuh3), one row per unit per call. Fetched month by month
                                          through the SODA API; the query is in dataset_sf/storm_response/README.md.
  <raw>/gtsr_analysis_neighborhoods.geojson   DataSF "Analysis Neighborhoods" (j2bu-swwd), 41 polygons.
  dataset_sf/rainfall_daily_san_francisco.csv, rainfall_hourly_sfo_airport.csv, flood_reports_311_san_francisco.csv (already in the repo).

Writes:
  dataset_sf/storm_response/*.csv, summary.json     tables a person can open
  site/data_sf/storm_response.js                    window.GT_STORM, the compact bundle the static site reads

Run: python3 scripts/sf/09_storm_response_sf.py <raw dir>
Deterministic: no clocks, no unseeded randomness. Bootstrap intervals use numpy's PCG64 with a fixed seed.
Needs only numpy and pandas (already used by the repo's scripts).
"""
import glob, json, math, os, sys
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "raw_dispatch")
DS = os.path.join(ROOT, "dataset_sf")
OUT_DS = os.path.join(DS, "storm_response")
OUT_JS = os.path.join(ROOT, "site", "data_sf", "storm_response.js")
os.makedirs(OUT_DS, exist_ok=True)

TZ = "America/Los_Angeles"
# The storm. Downtown gauge 67.1 mm on Nov 18, 2026 (a record for the date); SFO's hourly gauge shows rain from 03:00 on the 18th
# through a second burst that ended about 08:00 on the 19th. The window covers both bursts.
STORM_START, STORM_END = pd.Timestamp("2026-11-18 00:00"), pd.Timestamp("2026-11-19 12:00")     # local clock time, [start, end)
TL_START, TL_HOURS = pd.Timestamp("2026-11-17 00:00"), 96                                     # the scrubber: Nov 17 00:00 to Nov 21 00:00
DRY_FROM, DRY_TO = "2025-09-01", "2026-10-31"            # dry comparison days are picked from this span
DRY_LOOKBACK = 2                                         # a dry day has no rain that day or on the two days before
MIN_STRATUM_DRY = 3                                      # a storm call is matched only if its weekday + hour + type cell holds at least this many dry calls
FEW_STORM, FEW_DRY = 20, 60                              # comparisons with fewer matched storm calls or dry calls than this are flagged
MAX_RESP_MIN = 120                                       # receipt to first on scene over two hours is treated as a data error
BOOT, SEED = 1000, 20261118
W, E, S, N = -122.520, -122.360, 37.705, 37.825          # the SF map box (scripts/sf/region.py)

# ------------------------------------------------------------------ percentiles: one rule everywhere (the page uses the same)
def wq(x, w, q):
    """Weighted nearest-rank quantile: the smallest value whose cumulative weight reaches q of the total."""
    x = np.asarray(x, float); w = np.asarray(w, float)
    if len(x) == 0: return float("nan")
    o = np.argsort(x, kind="stable"); x, w = x[o], w[o]
    c = np.cumsum(w); k = int(np.searchsorted(c, q * c[-1] - 1e-9 * c[-1]))
    return float(x[min(k, len(x) - 1)])
def q(x, p): return wq(x, np.ones(len(x)), p)

# ------------------------------------------------------------------ dispatch rows -> incidents
files = sorted(glob.glob(os.path.join(RAW, "gtsr_fire_*.csv.gz")))
assert files, f"no gtsr_fire_*.csv.gz in {RAW}"
raw = pd.concat([pd.read_csv(f, dtype=str) for f in files], ignore_index=True)
n_rows = len(raw)
raw = raw.drop_duplicates(subset=["incident_number", "call_number", "unit_id"])     # the monthly pulls do not overlap; this is a guard
def ts(col):
    """DataSF stores local clock time with no zone. Times that do not exist or repeat at a daylight saving change become NaT."""
    t = pd.to_datetime(raw[col], format="ISO8601", errors="coerce")
    return t.dt.tz_localize(TZ, ambiguous="NaT", nonexistent="NaT")
raw["rec_local"] = pd.to_datetime(raw["received_dttm"], format="ISO8601", errors="coerce")
raw["rec"], raw["ons"], raw["dis"] = ts("received_dttm"), ts("on_scene_dttm"), ts("dispatch_dttm")
raw["useq"] = pd.to_numeric(raw["unit_sequence_in_call_dispatch"], errors="coerce").fillna(99)
xy = raw["case_location"].str.extract(r"POINT \(([-\d.]+) ([-\d.]+)\)").astype(float)
raw["lon"], raw["lat"] = xy[0], xy[1]

raw = raw.sort_values(["incident_number", "useq", "unit_id"], kind="stable")
g = raw.groupby("incident_number", sort=True)
inc = g.agg(rec_local=("rec_local", "min"), rec=("rec", "min"), first_on=("ons", "min"), first_dis=("dis", "min"),
            call_type=("call_type", "first"), nb=("neighborhoods_analysis_boundaries", "first"), lon=("lon", "first"), lat=("lat", "first"),
            units=("unit_id", "nunique"), prio=("final_priority", "first"), station=("station_area", "first")).reset_index()
any_dst_nat = g["rec"].apply(lambda s: s.isna().any())
inc["dst_drop"] = any_dst_nat.values & inc["rec_local"].notna().values
inc["resp_min"] = (inc["first_on"] - inc["rec"]).dt.total_seconds() / 60.0
inc["status"] = np.select(
    [inc["rec_local"].isna(), inc["dst_drop"], inc["first_on"].isna(), inc["resp_min"] < 0, inc["resp_min"] > MAX_RESP_MIN],
    ["no_receipt_time", "daylight_saving_change", "no_unit_on_scene", "negative_time", "over_120_min"], "ok")
inc.loc[inc["status"] != "ok", "resp_min"] = np.nan
inc["wd"] = inc["rec_local"].dt.dayofweek          # Monday 0
inc["hr"] = inc["rec_local"].dt.hour
inc["day"] = inc["rec_local"].dt.strftime("%Y-%m-%d")
inc["nb"] = inc["nb"].fillna("(no neighborhood)")
print(f"{n_rows:,} unit rows, {len(inc):,} incidents; status: {inc['status'].value_counts().to_dict()}")

# ------------------------------------------------------------------ rain: dry days, timeline gauge
daily = pd.read_csv(os.path.join(DS, "rainfall_daily_san_francisco.csv"), dtype={"date": str}).set_index("date")
wet = (daily["downtown_gauge_mm"].fillna(0) > 0) | (daily["sfo_airport_mm"].fillna(0) > 0) | (daily["rain_mm_area_mean"].fillna(0) > 0)
missing_gauge = daily["downtown_gauge_mm"].isna() & daily["sfo_airport_mm"].isna()
dry_days = []
for d in pd.date_range(DRY_FROM, DRY_TO, freq="D"):
    look = [(d - pd.Timedelta(days=k)).strftime("%Y-%m-%d") for k in range(DRY_LOOKBACK + 1)]
    if all(x in daily.index and not wet[x] and not missing_gauge[x] for x in look): dry_days.append(d.strftime("%Y-%m-%d"))
dry_set = set(dry_days)
hourly = pd.read_csv(os.path.join(DS, "rainfall_hourly_sfo_airport.csv"))
hourly["t"] = pd.to_datetime(hourly["local_time"]).dt.floor("h")
hourly = hourly.groupby("t")["rain_mm"].sum()
tl_hours = [TL_START + pd.Timedelta(hours=h) for h in range(TL_HOURS)]
rain_h = [round(float(hourly.get(t, np.nan)), 2) if t in hourly.index else None for t in tl_hours]

# ------------------------------------------------------------------ neighborhoods
gj = json.load(open(os.path.join(RAW, "gtsr_analysis_neighborhoods.geojson")))
NB = sorted(f["properties"]["nhood"] for f in gj["features"])
geom = {f["properties"]["nhood"]: f["geometry"]["coordinates"] for f in gj["features"]}
def rings_of(name): return [np.array(r, float) for poly in geom[name] for r in poly]
def polys_of(name): return [[np.array(r, float) for r in poly] for poly in geom[name]]
def inside_ring(px, py, r):
    x0, y0, x1, y1 = r[:-1, 0], r[:-1, 1], r[1:, 0], r[1:, 1]
    c = ((y0[None] > py[:, None]) != (y1[None] > py[:, None])) & (px[:, None] < (x1 - x0)[None] * (py[:, None] - y0[None]) / ((y1 - y0)[None] + 1e-15) + x0[None])
    return (c.sum(1) % 2) == 1
def which_nb(lon, lat):
    out = np.full(len(lon), -1)
    for k, name in enumerate(NB):
        for poly in polys_of(name):
            bx = poly[0]; sel = (out < 0) & (lon >= bx[:, 0].min()) & (lon <= bx[:, 0].max()) & (lat >= bx[:, 1].min()) & (lat <= bx[:, 1].max())
            if not sel.any(): continue
            idx = np.where(sel)[0]; hit = inside_ring(lon[idx], lat[idx], poly[0])
            for hole in poly[1:]: hit &= ~inside_ring(lon[idx], lat[idx], hole)
            out[idx[hit]] = k
    return out
def area_km2(name):
    a = 0.0
    for poly in polys_of(name):
        for j, r in enumerate(poly):
            x = r[:, 0] * 111.32 * math.cos(math.radians(37.76)); y = r[:, 1] * 110.95
            s = 0.5 * abs(np.dot(x[:-1], y[1:]) - np.dot(x[1:], y[:-1])); a += -s if j else s
    return a
def simplify(r, tol):
    """Douglas-Peucker on one ring (degrees), deterministic."""
    keep = np.zeros(len(r), bool); keep[0] = keep[-1] = True; st = [(0, len(r) - 1)]
    while st:
        a, b = st.pop()
        if b <= a + 1: continue
        p, q_ = r[a], r[b]; d = r[a + 1:b] - p; L = float(np.hypot(*(q_ - p)))
        dist = np.hypot(d[:, 0], d[:, 1]) if L < 1e-12 else np.abs(d[:, 0] * (q_ - p)[1] - d[:, 1] * (q_ - p)[0]) / L   # a closed ring starts and ends on one point
        k = int(np.argmax(dist))
        if dist[k] > tol: m = a + 1 + k; keep[m] = True; st += [(a, m), (m, b)]
    return r[keep]

# ------------------------------------------------------------------ flood reports (SF 311 Sewer / Flooding, already in the repo)
fl = pd.read_csv(os.path.join(DS, "flood_reports_311_san_francisco.csv"), dtype={"id": str})
fl["t"] = pd.to_datetime(fl["dt"])
fl = fl[(fl["t"] >= TL_START) & (fl["t"] < TL_START + pd.Timedelta(hours=TL_HOURS))].copy()
fl["nbk"] = which_nb(fl["lon"].to_numpy(float), fl["lat"].to_numpy(float))
fl_storm = fl[(fl["t"] >= STORM_START) & (fl["t"] < STORM_END)]

# ------------------------------------------------------------------ storm vs matched dry
NBK = {n: k for k, n in enumerate(NB)}
inc["nbk"] = inc["nb"].map(NBK).fillna(-1).astype(int)
in_storm = (inc["rec_local"] >= STORM_START) & (inc["rec_local"] < STORM_END)
storm_all = inc[in_storm].copy()
storm = storm_all[storm_all["status"] == "ok"].copy()
dry = inc[inc["day"].isin(dry_set) & (inc["status"] == "ok")].copy()
storm_keys = set(zip(storm["wd"], storm["hr"]))
dry = dry[[k in storm_keys for k in zip(dry["wd"], dry["hr"])]]          # only the weekdays and hours the storm window covers
dry_days_used = sorted(dry["day"].unique())
print(f"storm window: {len(storm_all):,} incidents, {len(storm):,} with a valid time; dry pool: {len(dry):,} incidents on {len(dry_days_used)} days")

def compare(st, dr, label):
    """Reweight dry calls so their weekday x hour x type mix equals the storm calls'. Storm calls whose cell has too few dry calls are left out and counted."""
    key = lambda df: list(zip(df["wd"], df["hr"], df["call_type"]))
    dk = pd.Series(key(dr), index=dr.index) if len(dr) else pd.Series([], dtype=object)
    ncell = dk.value_counts() if len(dr) else pd.Series(dtype=int)
    sk = key(st); ok = np.array([ncell.get(k, 0) >= MIN_STRATUM_DRY for k in sk], bool)
    sm = st[ok]; scount = pd.Series([k for k, o in zip(sk, ok) if o]).value_counts()
    wt = dk.map(lambda k: scount.get(k, 0) / ncell.get(k, 1)) if len(dr) else pd.Series([], dtype=float)
    dm = dr[wt.to_numpy() > 0] if len(dr) else dr; w = wt[wt > 0].to_numpy() if len(dr) else np.array([])
    r = dict(label=label, storm_valid=int(len(st)), storm_matched=int(len(sm)), storm_unmatched=int((~ok).sum()), dry_matched=int(len(dm)),
             dry_days=int(dm["day"].nunique()) if len(dm) else 0)
    if len(sm):
        r.update(storm_med=wq(sm["resp_min"], np.ones(len(sm)), .5), storm_p90=wq(sm["resp_min"], np.ones(len(sm)), .9),
                 dry_med=wq(dm["resp_min"], w, .5), dry_p90=wq(dm["resp_min"], w, .9))
        r["d_med"], r["d_p90"] = r["storm_med"] - r["dry_med"], r["storm_p90"] - r["dry_p90"]
        # bootstrap: resample storm calls, and resample dry days (calls on one day move together)
        rng = np.random.Generator(np.random.PCG64(SEED + sum(map(ord, label))))     # fixed per label, so reruns match
        sv = sm["resp_min"].to_numpy(); days = dm["day"].to_numpy(); udays = np.unique(days); idx = {d: np.where(days == d)[0] for d in udays}
        dv = dm["resp_min"].to_numpy(); bm, bp = [], []
        for _ in range(BOOT):
            s_ = sv[rng.integers(0, len(sv), len(sv))]
            pick = np.concatenate([idx[d] for d in udays[rng.integers(0, len(udays), len(udays))]])
            bm.append(q(s_, .5) - wq(dv[pick], w[pick], .5)); bp.append(q(s_, .9) - wq(dv[pick], w[pick], .9))
        r["d_med_ci"] = [q(bm, .05), q(bm, .95)]; r["d_p90_ci"] = [q(bp, .05), q(bp, .95)]
    r["few"] = bool(len(sm) < FEW_STORM or len(dm) < FEW_DRY)
    return r

rows = [compare(storm, dry, "All of San Francisco")]
for k, name in enumerate(NB): rows.append(compare(storm[storm["nbk"] == k], dry[dry["nbk"] == k], name))
rows[0]["storm_calls"] = int(len(storm_all))
for k, name in enumerate(NB): rows[k + 1]["storm_calls"] = int((storm_all["nbk"] == k).sum())
types = storm["call_type"].value_counts()
type_rows = [compare(storm[storm["call_type"] == t], dry[dry["call_type"] == t], t) for t in types.index if types[t] >= 5]

# flood overlap, an observation across neighborhoods
fl_nb = np.bincount(fl_storm["nbk"][fl_storm["nbk"] >= 0], minlength=len(NB))
for r in rows[1:]: r["flood_storm"] = int(fl_nb[NB.index(r["label"])])
rows[0]["flood_storm"] = int(len(fl_storm))
good = [r for r in rows[1:] if not r["few"] and "d_med" in r]
def spearman(a, b):
    a, b = pd.Series(a).rank(method="average"), pd.Series(b).rank(method="average"); return float(np.corrcoef(a, b)[0, 1]) if len(a) > 2 else float("nan")
obs = dict(n_neighborhoods=len(good), spearman_flood_vs_d_med=spearman([r["flood_storm"] for r in good], [r["d_med"] for r in good]),
           spearman_flood_vs_d_p90=spearman([r["flood_storm"] for r in good], [r["d_p90"] for r in good]))
top = sorted(good, key=lambda r: -r["flood_storm"])[:5]
obs["top_flood"] = [[r["label"], r["flood_storm"], round(r["d_med"], 1), round(r["d_p90"], 1)] for r in top]
rest = [r for r in good if r not in top]
obs["d_med_top5_flood_median"] = q([r["d_med"] for r in top], .5) if top else None
obs["d_med_other_median"] = q([r["d_med"] for r in rest], .5) if rest else None

# ------------------------------------------------------------------ planning scenario: one extra ambulance at one station, storm window
# Only shown if the travel model passes a check against real arrivals in a period it was not fitted on.
FIT_TO, VAL_FROM, VAL_TO = "2026-09-01", "2026-10-01", "2026-11-01"
VAL_MAE, VAL_BIAS = 1.0, 0.5                         # pass if held-out median absolute error <= 1.0 min and |median signed error| <= 0.5 min
loc_ = lambda c: pd.to_datetime(raw[c], format="ISO8601", errors="coerce")
u = pd.DataFrame(dict(unit=raw["unit_id"], typ=raw["unit_type"], inc=raw["incident_number"], area=raw["station_area"], lon=raw["lon"], lat=raw["lat"],
                      rec=raw["rec_local"], dis=loc_("dispatch_dttm"), enr=loc_("response_dttm"), ons=loc_("on_scene_dttm"), avl=loc_("available_dttm")))
u["trav"] = (u["ons"] - u["enr"]).dt.total_seconds() / 60
u["turn"] = (u["enr"] - u["dis"]).dt.total_seconds() / 60
eng = u[(u["typ"] == "ENGINE") & u["trav"].between(0.2, 30) & u["lon"].notna()].copy()
eng["st"] = eng["unit"].str[1:]
fit = eng[eng["rec"] < FIT_TO]
# Station positions are not published on DataSF, so each is estimated from the records: the median position of the 5% quickest
# arrivals of that station's engine (E07 lives at Station 7). Good to a few hundred metres.
ST_LOC = {}
for st_, g_ in fit.groupby("st", sort=True):
    if len(g_) < 200: continue
    qk = g_[g_["trav"] <= wq(g_["trav"], np.ones(len(g_)), 0.05)]
    ST_LOC[st_] = (float(qk["lon"].median()), float(qk["lat"].median()))
MX, MY = 88000.0, 111000.0                           # metres per degree here
def dist_m(st_list, lon, lat):
    sl = np.array([ST_LOC.get(x, (np.nan, np.nan)) for x in st_list]); return np.abs(lon - sl[:, 0]) * MX + np.abs(lat - sl[:, 1]) * MY   # street-grid (Manhattan) distance
BINS = np.arange(0, 8001, 250)
own = lambda df: df[(df["area"] == df["st"]) & df["st"].isin(list(ST_LOC))].assign(dm=lambda x: dist_m(x["st"].tolist(), x["lon"].to_numpy(), x["lat"].to_numpy()))
fo = own(fit); fo = fo.assign(b=np.digitize(fo["dm"], BINS))
CURVE = {int(b): q(g_["trav"].to_numpy(), .5) for b, g_ in fo.groupby("b") if len(g_) >= 30}
def travel(dm):
    b = np.digitize(dm, BINS); ks = np.array(sorted(CURVE)); out = []
    for x in np.atleast_1d(b): k = ks[np.argmin(np.abs(ks - x))]; out.append(CURVE[int(k)])
    return np.array(out)
def check(df, label):
    o = own(df); pred = travel(o["dm"].to_numpy()); err = pred - o["trav"].to_numpy()
    return dict(label=label, n=int(len(o)), mae=q(np.abs(err), .5), bias=q(err, .5), p90_abs=q(np.abs(err), .9))
val = check(eng[(eng["rec"] >= VAL_FROM) & (eng["rec"] < VAL_TO)], "October 2026 (held out)")
val_storm = check(eng[(eng["rec"] >= STORM_START) & (eng["rec"] < STORM_END)], "Storm window")
TURN = q(u.loc[(u["typ"] == "ENGINE") & (u["area"] == u["unit"].str[1:]) & u["turn"].between(0, 10) & (u["rec"] < FIT_TO), "turn"].to_numpy(), .5)   # leaving quarters: own-area engines
med_busy = u[(u["typ"] == "MEDIC") & (u["rec"] < FIT_TO)]; BUSY = q(((med_busy["avl"] - med_busy["ons"]).dt.total_seconds() / 60).dropna().clip(0, 600).to_numpy(), .5)
passed = val["mae"] <= VAL_MAE and abs(val["bias"]) <= VAL_BIAS
print(f"travel model check: held out {val}, storm {val_storm}, pass={passed}; turnout {TURN:.2f} min, on-scene to available {BUSY:.1f} min")

def simulate(st_):
    """Replay the storm's medical calls in order. The extra ambulance starts at the station, goes to a call when it is free and would beat the
    first unit that really arrived, stays busy for the median on-scene-to-available time plus the drive back, then waits at the station again."""
    m = storm[storm["call_type"] == "Medical Incident"].sort_values(["rec_local", "incident_number"]).copy()
    lon, lat = m["lon"].to_numpy(float), m["lat"].to_numpy(float)
    dm = np.abs(lon - ST_LOC[st_][0]) * MX + np.abs(lat - ST_LOC[st_][1]) * MY
    tr = travel(np.nan_to_num(dm, nan=1e9)); tr[np.isnan(dm)] = np.inf
    disp = ((m["first_dis"] - m["rec"]).dt.total_seconds() / 60).to_numpy(); base = m["resp_min"].to_numpy()
    own_area = (m["station"] == st_).to_numpy()
    t0 = m["rec_local"].map(lambda t: (t - STORM_START).total_seconds() / 60).to_numpy()
    free, new, hit = 0.0, base.copy(), np.zeros(len(m), bool)
    for i in range(len(m)):
        if not own_area[i] or np.isnan(disp[i]) or t0[i] + disp[i] < free: continue      # only its own first-due area, where the drive-time model was checked
        arr = disp[i] + TURN + tr[i]
        if arr < base[i]: new[i] = arr; hit[i] = True; free = t0[i] + arr + BUSY + tr[i]
    m["new"], m["hit"] = new, hit
    def agg(g_): return dict(n=int(len(g_)), base_med=q(g_["resp_min"].to_numpy(), .5), base_p90=q(g_["resp_min"].to_numpy(), .9),
                             new_med=q(g_["new"].to_numpy(), .5), new_p90=q(g_["new"].to_numpy(), .9), reached=int(g_["hit"].sum()))
    out = dict(city=agg(m), nb={})
    for k_, g_ in m.groupby("nbk"):
        if k_ >= 0: out["nb"][int(k_)] = agg(g_)
    return out
SCN = dict(passed=bool(passed), val=val, val_storm=val_storm, turn=TURN, busy=BUSY, curve={int(BINS[k - 1]): v for k, v in CURVE.items()},
           rules=dict(stations="Station positions are estimated from the records: the median position of the 5% quickest arrivals of each station's own engine, September 2025 to August 2026. Good to a few hundred metres.",
                      travel="Drive time from a station is the median en-route-to-on-scene time of engines answering calls in their own station area at that street-grid distance (250 m bands), fitted on September 2025 to August 2026.",
                      check=f"The drive-time model is checked on October 2026, which it was not fitted on. Scenario results are shown only if the median absolute error is at most {VAL_MAE} min and the median signed error at most {VAL_BIAS} min.",
                      sim="Medical calls in the storm window are replayed in order of receipt. The extra ambulance answers only calls in its own station's first-due area (the distances the drive-time model was checked on). It is dispatched when the real first dispatch happened and rolls after the median time engines take to leave quarters, and counts only if it would beat the first unit that really arrived. It is then busy for the median ambulance on-scene-to-available time plus the drive back. Every other unit does what it really did.",
                      limits="One unit, one station, one storm. It ignores traffic and flooding on the way, crews that were already out, and how dispatchers would really use the unit, so read it as a rough ceiling on the gain."),
           stations=[dict(id=k_, lon=round(v_[0], 5), lat=round(v_[1], 5)) for k_, v_ in sorted(ST_LOC.items())])
if passed: SCN["runs"] = {k_: simulate(k_) for k_ in sorted(ST_LOC)}

# ------------------------------------------------------------------ write tables
def rnd(v, k=2):
    if isinstance(v, float): return None if math.isnan(v) else round(v, k)
    if isinstance(v, list): return [rnd(x, k) for x in v]
    return v
cmp_df = pd.DataFrame([{k: rnd(v) for k, v in r.items()} for r in rows])
cmp_df.to_csv(os.path.join(OUT_DS, "comparison_by_neighborhood.csv"), index=False)
pd.DataFrame([{k: rnd(v) for k, v in r.items()} for r in type_rows]).to_csv(os.path.join(OUT_DS, "comparison_by_type.csv"), index=False)
cols = ["incident_number", "rec_local", "call_type", "prio", "nb", "lon", "lat", "units", "first_on", "resp_min", "status"]
tl_inc = inc[(inc["rec_local"] >= TL_START) & (inc["rec_local"] < TL_START + pd.Timedelta(hours=TL_HOURS))].sort_values(["rec_local", "incident_number"])
out_inc = tl_inc[cols].copy(); out_inc["first_on"] = out_inc["first_on"].dt.tz_convert(TZ).dt.strftime("%Y-%m-%dT%H:%M:%S"); out_inc["resp_min"] = out_inc["resp_min"].round(2)
out_inc.to_csv(os.path.join(OUT_DS, "incidents_nov17_20_2026.csv"), index=False)
pd.DataFrame({"date": dry_days, "used_in_comparison": [d in set(dry_days_used) for d in dry_days]}).to_csv(os.path.join(OUT_DS, "dry_days.csv"), index=False)

meta = dict(
    storm="San Francisco, November 18, 2026 (downtown gauge 67.1 mm, a record for the date; 776 flood reports that day, the most since 2008)",
    storm_window=[str(STORM_START), str(STORM_END)], timeline=[str(TL_START), str(TL_START + pd.Timedelta(hours=TL_HOURS))], time_zone=TZ,
    source=dict(dispatch="DataSF, Fire Department and Emergency Medical Services Dispatched Calls for Service, dataset nuek-vuh3",
                pulled="2026-11-21 (records through 2026-11-21 03:23 local; DataSF stamps data_as_of 2026-11-19/20)",
                span=[str(inc["rec_local"].min()), str(inc["rec_local"].max())], files=[os.path.basename(f) for f in files],
                neighborhoods="DataSF Analysis Neighborhoods, dataset j2bu-swwd (41)", rain="NOAA/NWS downtown gauge and SFO airport (dataset_sf/rainfall_*.csv)",
                floods="SF 311 Sewer / Flooding cases, dataset vw6y-z8j6 (dataset_sf/flood_reports_311_san_francisco.csv)"),
    rules=dict(
        incident="One incident = one incident_number. All its unit rows are grouped; it is counted once however many units went.",
        response="Minutes from received_dttm (call receipt) to the earliest on_scene_dttm of any unit on the incident.",
        dropped=f"Left out of times (still counted in the status table): no unit recorded on scene, negative time, over {MAX_RESP_MIN} minutes, or a receipt/arrival clock time that does not exist or repeats at a daylight saving change.",
        neighborhood="The incident's neighborhoods_analysis_boundaries field from DataSF (the 41 Analysis Neighborhoods). Flood reports are placed by point in polygon.",
        dry_day=f"Downtown gauge, SFO gauge and the area mean all 0 mm that day and the {DRY_LOOKBACK} days before, between {DRY_FROM} and {DRY_TO}. Days with no gauge reading are not dry days.",
        matching=f"Each storm call is matched to dry-day calls with the same weekday, local hour of receipt and call_type. Dry calls are weighted so the mix of those cells equals the storm's. A storm call whose cell holds fewer than {MIN_STRATUM_DRY} dry calls is left out of the comparison and counted.",
        few=f"A comparison is flagged as too few calls when it has fewer than {FEW_STORM} matched storm calls or {FEW_DRY} matched dry calls.",
        percentile="Nearest rank: the smallest time at or above the given share of calls (weighted for dry days). The page computes the scrubber stats with the same rule.",
        interval=f"90% bootstrap interval, {BOOT} draws, seed {SEED}: storm calls resampled one by one, dry calls resampled by whole day.",
        priority="All priorities are included. Matching is on call_type only, as asked; the final priority mix is in the status table."),
    status_all={k: int(v) for k, v in inc["status"].value_counts().items()},
    status_storm={k: int(v) for k, v in storm_all["status"].value_counts().items()},
    priority_storm={str(k): int(v) for k, v in storm_all["prio"].value_counts().items()},
    dry_days=len(dry_days), dry_days_used=len(dry_days_used), unit_rows=n_rows, incidents=int(len(inc)),
)
json.dump(dict(meta=meta, city=rows[0], neighborhoods=rows[1:], types=type_rows, observation=obs, scenario={k: v for k, v in SCN.items() if k != "runs"}), open(os.path.join(OUT_DS, "summary.json"), "w"), indent=1, default=lambda o: rnd(float(o)))

# ------------------------------------------------------------------ the site bundle
t0 = TL_START
def mins(t): return int((t - t0).total_seconds() // 60)        # whole minutes, rounded down, so a call stays in the hour it was received
polys = []
for name in NB:
    rs = []
    for poly in polys_of(name):
        r = simplify(poly[0], 0.00012)
        if len(r) >= 4: rs.append([[round(float(x), 5), round(float(y), 5)] for x, y in r])
    c = np.concatenate(rings_of(name)); polys.append(dict(name=name, rings=rs, c=[round(float(c[:, 0].mean()), 5), round(float(c[:, 1].mean()), 5)], km2=round(area_km2(name), 2)))
TY = sorted(tl_inc["call_type"].fillna("(none)").unique())
tyk = {t: k for k, t in enumerate(TY)}
ST = {"ok": 0, "no_unit_on_scene": 1, "negative_time": 2, "over_120_min": 3, "daylight_saving_change": 4, "no_receipt_time": 5}
I = dict(id=tl_inc["incident_number"].tolist(), t=[mins(t) for t in tl_inc["rec_local"]],
         r=[None if np.isnan(v) else round(float(v), 2) for v in tl_inc["resp_min"]], s=[ST[s] for s in tl_inc["status"]],
         nb=tl_inc["nbk"].tolist(), ty=[tyk[t] for t in tl_inc["call_type"].fillna("(none)")], u=tl_inc["units"].astype(int).tolist(),
         x=[None if np.isnan(v) else round(float(v), 5) for v in tl_inc["lon"]], y=[None if np.isnan(v) else round(float(v), 5) for v in tl_inc["lat"]])
F = dict(t=[mins(t) for t in fl["t"]], nb=fl["nbk"].astype(int).tolist(), x=[round(float(v), 5) for v in fl["lon"]], y=[round(float(v), 5) for v in fl["lat"]])
def slim(r): return {k: rnd(v, 2) for k, v in r.items()}
bundle = dict(meta=dict(meta, start=str(TL_START), hours=TL_HOURS, storm_min=[mins(STORM_START), mins(STORM_END)], status=list(ST), bbox=[W, S, E, N],
                        daily={d: dict(downtown=rnd(float(daily.loc[d, "downtown_gauge_mm"]), 1), sfo=rnd(float(daily.loc[d, "sfo_airport_mm"]), 1), floods=int(daily.loc[d, "flood_reports_311"]))
                               for d in ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"] if d in daily.index}),
              nb=polys, types=TY, rain=rain_h, inc=I, flood=F,
              cmp=dict(city=slim(rows[0]), nb=[slim(r) for r in rows[1:]], types=[slim(r) for r in type_rows], obs={k: rnd(v, 3) if not isinstance(v, list) else v for k, v in obs.items()}),
              scn=json.loads(json.dumps(SCN, default=lambda o: rnd(float(o)), allow_nan=True).replace("NaN", "null"), parse_float=lambda v: round(float(v), 2)))
js = "window.GT_STORM=" + json.dumps(bundle, separators=(",", ":"), default=lambda o: rnd(float(o))) + ";\n"
open(OUT_JS, "w").write(js)
print(f"wrote {OUT_JS} ({len(js)/1024:.0f} KB), {len(TY)} types, {len(I['t'])} timeline incidents, {len(F['t'])} flood reports")
c = rows[0]
print(f"city: storm median {c.get('storm_med'):.2f} p90 {c.get('storm_p90'):.2f} (n={c['storm_matched']}) vs dry median {c.get('dry_med'):.2f} p90 {c.get('dry_p90'):.2f} (n={c['dry_matched']}, {c['dry_days']} days)")
print("observation:", obs)
