"""escape, San Francisco: the two per-address tables behind the address check.

1. Help arrival. For every 250 m square of the city: how long emergency calls (final priority 3, lights and sirens) took from the
   moment the call was received to the first fire or EMS unit on scene, using the real calls within 500 m of the square's centre,
   September 2025 to August 2026. Checked on October 2026 and on the November 18, 2026 storm window, which it was not built from:
   does about half of the held-out calls arrive within the square's typical time, and about 9 in 10 within its slow time?
2. Flood history. For every 100 m square: SF 311 flooding reports within 150 m on rain days (at least 5 mm that day or the day before,
   the same rain-linked rule as the training data), July 2008 to November 2026, and how much rain had fallen over 3 days when they came.

Real data only. Inputs: <raw>/gtsr_fire_YYYY-MM.csv.gz (DataSF nuek-vuh3, see 09_storm_response_sf.py), dataset_sf/flood_reports_311_san_francisco.csv,
dataset_sf/rainfall_daily_san_francisco.csv. Writes site/data_sf/address_help.js (window.GT_HELP) and dataset_sf/address_help/*.csv.
Run: python3 scripts/sf/12_address_answers_sf.py <raw dir>. Deterministic. Needs numpy and pandas."""
import glob, json, os, sys
import numpy as np, pandas as pd
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = sys.argv[1]
DS = os.path.join(ROOT, "dataset_sf"); OUT = os.path.join(DS, "address_help"); os.makedirs(OUT, exist_ok=True)
W, E, S, N = -122.520, -122.360, 37.705, 37.825
MX, MY = 88000.0, 111000.0                              # metres per degree here (same as 09)
FIT_FROM, FIT_TO, VAL_FROM, VAL_TO = "2025-09-01", "2026-09-01", "2026-10-01", "2026-11-01"
STORM_START, STORM_END = pd.Timestamp("2026-11-18 00:00"), pd.Timestamp("2026-11-19 12:00")
CELL_H, RAD_H, MIN_CALLS = 250.0, 500.0, 40             # help arrival: 250 m squares, calls within 500 m, at least 40 calls
CELL_F, RAD_F = 100.0, 150.0                            # flood history: 100 m squares, reports within 150 m
def q(x, p):                                            # nearest rank, the rule 09 and the page use
    x = np.sort(np.asarray(x, float)); x = x[~np.isnan(x)]
    return float(x[min(len(x) - 1, max(0, int(np.ceil(p * len(x))) - 1))]) if len(x) else float("nan")

# ------------------------------------------------------------------ help arrival
files = sorted(glob.glob(os.path.join(RAW, "gtsr_fire_*.csv.gz")))
raw = pd.concat([pd.read_csv(f, dtype=str, usecols=["incident_number", "received_dttm", "on_scene_dttm", "final_priority", "case_location"]) for f in files], ignore_index=True)
raw["rec"] = pd.to_datetime(raw["received_dttm"], format="ISO8601", errors="coerce"); raw["ons"] = pd.to_datetime(raw["on_scene_dttm"], format="ISO8601", errors="coerce")
xy = raw["case_location"].str.extract(r"POINT \(([-\d.]+) ([-\d.]+)\)").astype(float); raw["lon"], raw["lat"] = xy[0], xy[1]
inc = raw.groupby("incident_number").agg(rec=("rec", "min"), first_on=("ons", "min"), prio=("final_priority", "first"), lon=("lon", "first"), lat=("lat", "first")).reset_index()
inc["m"] = (inc["first_on"] - inc["rec"]).dt.total_seconds() / 60
inc = inc[(inc["prio"] == "3") & inc["m"].between(0, 120) & inc["lon"].between(W, E) & inc["lat"].between(S, N)]
fit = inc[(inc["rec"] >= FIT_FROM) & (inc["rec"] < FIT_TO)]
nx, ny = int(np.ceil((E - W) * MX / CELL_H)), int(np.ceil((N - S) * MY / CELL_H))
fx, fy, fm = ((fit["lon"] - W) * MX).to_numpy(), ((fit["lat"] - S) * MY).to_numpy(), fit["m"].to_numpy()
order = np.argsort(fx); fx, fy, fm = fx[order], fy[order], fm[order]
cells = {}
for j in range(ny):
    for i in range(nx):
        cx, cy = (i + .5) * CELL_H, (j + .5) * CELL_H
        a, b = np.searchsorted(fx, cx - RAD_H), np.searchsorted(fx, cx + RAD_H)
        sel = np.hypot(fx[a:b] - cx, fy[a:b] - cy) <= RAD_H
        v = fm[a:b][sel]
        if len(v) >= MIN_CALLS: cells[j * nx + i] = (len(v), q(v, .5), q(v, .9))
def cell_of(lon, lat):
    i = np.floor((np.asarray(lon) - W) * MX / CELL_H).astype(int); j = np.floor((np.asarray(lat) - S) * MY / CELL_H).astype(int)
    return np.where((i >= 0) & (i < nx) & (j >= 0) & (j < ny), j * nx + i, -1)
def check(df, label):
    c = cell_of(df["lon"].to_numpy(), df["lat"].to_numpy()); ok = np.array([k in cells for k in c])
    med = np.array([cells[k][1] for k in c[ok]]); p90 = np.array([cells[k][2] for k in c[ok]]); m = df["m"].to_numpy()[ok]
    return dict(label=label, n=int(ok.sum()), covered=round(float(ok.mean()), 3), within_typical=round(float((m <= med).mean()), 3), within_slow=round(float((m <= p90).mean()), 3),
                median_abs_err_min=round(q(np.abs(m - med), .5), 2), median_signed_err_min=round(q(med - m, .5), 2))
val = check(inc[(inc["rec"] >= VAL_FROM) & (inc["rec"] < VAL_TO)], "October 2026 (held out)")
val_storm = check(inc[(inc["rec"] >= STORM_START) & (inc["rec"] < STORM_END)], "November 18 storm window, Nov 18 00:00 to Nov 19 12:00")
city = dict(n=int(len(fit)), med=round(q(fm, .5), 2), p90=round(q(fm, .9), 2))
print("help cells", len(cells), "of", nx * ny, "check", val, val_storm, "city", city)
pd.DataFrame([dict(cell=k, col=k % nx, row=k // nx, lon=round(W + (k % nx + .5) * CELL_H / MX, 5), lat=round(S + (k // nx + .5) * CELL_H / MY, 5), calls=v[0], typical_min=v[1], slow_min_p90=v[2]) for k, v in sorted(cells.items())]).to_csv(os.path.join(OUT, "help_arrival_250m.csv"), index=False)

# ------------------------------------------------------------------ flood history
rain = pd.read_csv(os.path.join(DS, "rainfall_daily_san_francisco.csv"), dtype={"date": str}).set_index("date")
mm = rain["rain_mm_area_mean"].fillna(0); prev = mm.shift(1).fillna(0)
rainy = (mm >= 5) | (prev >= 5)
fl = pd.read_csv(os.path.join(DS, "flood_reports_311_san_francisco.csv"), dtype={"id": str, "date": str})
fl = fl[fl["lon"].between(W, E) & fl["lat"].between(S, N) & fl["date"].isin(rainy[rainy].index)].copy()
fl["r3"] = fl["date"].map(rain["rain_3d_mm"]).astype(float)
gx, gy = int(np.ceil((E - W) * MX / CELL_F)), int(np.ceil((N - S) * MY / CELL_F))
px, py = ((fl["lon"] - W) * MX).to_numpy(), ((fl["lat"] - S) * MY).to_numpy(); days = fl["date"].to_numpy(); r3 = fl["r3"].to_numpy()
order = np.argsort(px); px, py, days, r3 = px[order], py[order], days[order], r3[order]
fcells = {}
for j in range(gy):
    for i in range(gx):
        cx, cy = (i + .5) * CELL_F, (j + .5) * CELL_F
        a, b = np.searchsorted(px, cx - RAD_F), np.searchsorted(px, cx + RAD_F)
        sel = np.hypot(px[a:b] - cx, py[a:b] - cy) <= RAD_F
        if not sel.any(): continue
        d = days[a:b][sel]; r = r3[a:b][sel]; ud, ix = np.unique(d, return_index=True)
        dr = r[ix]                                       # one rain value per report day
        fcells[j * gx + i] = (int(sel.sum()), len(ud), round(q(dr, .5), 1), round(float(dr.min()), 1), str(ud.max()), int((d == "2026-11-18").sum()))
print("flood cells", len(fcells), "of", gx * gy, "reports used", len(fl))
pd.DataFrame([dict(cell=k, lon=round(W + (k % gx + .5) * CELL_F / MX, 5), lat=round(S + (k // gx + .5) * CELL_F / MY, 5), reports=v[0], report_days=v[1], typical_rain_3d_mm=v[2], lightest_rain_3d_mm=v[3], last_day=v[4], reports_nov18_2026=v[5]) for k, v in sorted(fcells.items())]).to_csv(os.path.join(OUT, "flood_history_100m.csv"), index=False)

meta = dict(help=dict(what="Minutes from call received to first fire or EMS unit on scene, emergency calls (final priority 3), real calls within %d m, %s to %s" % (RAD_H, FIT_FROM, "2026-08-31"),
                      source="DataSF Fire Department and Emergency Medical Services Dispatched Calls for Service (nuek-vuh3)", cell_m=CELL_H, radius_m=RAD_H, min_calls=MIN_CALLS, nx=nx, ny=ny, city=city, check=val, check_storm=val_storm),
            flood=dict(what="SF 311 Sewer / Flooding reports within %d m on rain days (5 mm or more that day or the day before), %s to %s" % (RAD_F, fl["date"].min(), fl["date"].max()),
                       source="SF 311 (vw6y-z8j6) via dataset_sf/flood_reports_311_san_francisco.csv; rain: dataset_sf/rainfall_daily_san_francisco.csv area mean", cell_m=CELL_F, radius_m=RAD_F, nx=gx, ny=gy, reports=int(len(fl)),
                       first=str(fl["date"].min()), last=str(fl["date"].max())),
            mpd=[MX, MY], origin=[W, S])
H = [[k, v[0], v[1], v[2]] for k, v in sorted(cells.items())]
F = [[k, *v] for k, v in sorted(fcells.items())]
js = "/* Generated by scripts/sf/12_address_answers_sf.py. Do not edit. */\nwindow.GT_HELP=" + json.dumps(dict(meta=meta, help=H, flood=F), separators=(",", ":")) + ";\n"
open(os.path.join(ROOT, "site", "data_sf", "address_help.js"), "w").write(js)
json.dump(meta, open(os.path.join(OUT, "summary.json"), "w"), indent=1)
print("js bytes", len(js))
