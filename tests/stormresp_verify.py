"""Check the Storm response numbers against the DataSF source rows with a second, independent implementation
(csv module and plain Python, no pandas), then check the page's own arithmetic in site/js/stormresp.js against it.

Run: python3 tests/stormresp_verify.py <raw dir with gtsr_fire_*.csv.gz>
"""
import csv, gzip, glob, json, os, subprocess, sys
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = sys.argv[1]
S = json.load(open(os.path.join(ROOT, "dataset_sf/storm_response/summary.json")))
fails = []
def check(name, got, want, tol=0.011):
    ok = (got == want) if not isinstance(want, float) else abs(got - want) <= tol
    print(("PASS " if ok else "FAIL ") + f"{name}: got {got}, want {want}")
    if not ok: fails.append(name)

def nearest_rank(xs, q):
    xs = sorted(xs); import math
    if not xs: return float("nan")
    k = 0; goal = q * len(xs) - 1e-9 * len(xs)
    while k + 1 < goal: k += 1
    return xs[min(k, len(xs) - 1)]

# one pass over the November file: group unit rows by incident by hand
inc = {}
rows_nov = 0
for f in sorted(glob.glob(os.path.join(RAW, "gtsr_fire_2026-11.csv.gz"))):
    for r in csv.DictReader(gzip.open(f, "rt")):
        rows_nov += 1
        i = inc.setdefault(r["incident_number"], dict(rec=r["received_dttm"], ons=[], nb=r["neighborhoods_analysis_boundaries"], seq=99, type=r["call_type"], units=set()))
        i["units"].add(r["unit_id"])
        seq = float(r["unit_sequence_in_call_dispatch"] or 99)
        if seq < i["seq"]: i["seq"], i["type"], i["nb"] = seq, r["call_type"], r["neighborhoods_analysis_boundaries"]
        if r["received_dttm"] < i["rec"]: i["rec"] = r["received_dttm"]
        if r["on_scene_dttm"]: i["ons"].append(r["on_scene_dttm"])
P = lambda s: datetime.fromisoformat(s[:19])
for i in inc.values():
    i["t"] = P(i["rec"])
    i["resp"] = (P(min(i["ons"])) - i["t"]).total_seconds() / 60 if i["ons"] else None
    if i["resp"] is not None and not (0 <= i["resp"] <= 120): i["resp"] = None

a, b = datetime(2026, 11, 18), datetime(2026, 11, 19, 12)
storm = [i for i in inc.values() if a <= i["t"] < b]
timed = [i["resp"] for i in storm if i["resp"] is not None]
check("storm window incidents (all statuses)", len(storm), sum(S["meta"]["status_storm"].values()))
check("storm window incidents with a valid time", len(timed), S["meta"]["status_storm"]["ok"])
check("storm window, no unit on scene", sum(1 for i in storm if not i["ons"]), S["meta"]["status_storm"].get("no_unit_on_scene", 0))
for nb in ["Mission", "Tenderloin", "South of Market"]:
    row = next(r for r in S["neighborhoods"] if r["label"] == nb)
    check(f"{nb}: storm incidents", sum(1 for i in storm if i["nb"] == nb), row["storm_calls"])
    check(f"{nb}: storm incidents with a valid time", sum(1 for i in storm if i["nb"] == nb and i["resp"] is not None), row["storm_valid"])

# a few source rows, by hand
print("\nThree storm incidents from the raw rows (receipt, first on scene, minutes, units):")
for k in sorted(k for k, i in inc.items() if a <= i["t"] < b and i["resp"] is not None and len(i["units"]) > 2)[:3]:
    i = inc[k]; print(f"  incident {k}: {i['type']}, {i['nb']}, received {i['rec']}, first on scene {min(i['ons'])}, {i['resp']:.2f} min, {len(i['units'])} units")

# the page's arithmetic on the bundle: window stats for the whole storm window must match the raw rows above
js = r"""
global.window = {}; require(process.argv[1] + '/site/data_sf/storm_response.js'); const A = require(process.argv[1] + '/site/js/stormresp.js') || window.GTStormResp;
const D = window.GT_STORM, R = window.GTStormResp, [s0, s1] = D.meta.storm_min;
const st = R.windowStats(D, s1, s1 - s0, -1);       // [s0, s1): received at or after s0 and before s1
const k = D.nb.findIndex(n => n.name === 'Mission'), m = R.windowStats(D, s1, s1 - s0, k);
const h = R.hourly(D, -1), hr = 34;                        // Nov 18, 10:00 to 10:59
console.log(JSON.stringify({ calls: st.calls, timed: st.timed, med: st.med, p90: st.p90, mCalls: m.calls, mMed: m.med, h34: h.calls[hr], f34: h.floods[hr], rain34: D.rain[hr], nbAt: R.nbAt(D, -122.4194, 37.7599) === k }));
"""
out = json.loads(subprocess.run(["node", "-e", js, ROOT], capture_output=True, text=True, check=True).stdout)
# the bundle stores receipt time in whole minutes, so compare with the raw rows the same way
win = [i for i in inc.values() if a <= i["t"] < b]
wt = [i["resp"] for i in win if i["resp"] is not None]
print()
check("page: storm window calls", out["calls"], len(win))
check("page: storm window timed calls", out["timed"], len(wt))
check("page: storm window median", out["med"], round(nearest_rank(wt, 0.5), 2))
check("page: storm window 90th percentile", out["p90"], round(nearest_rank(wt, 0.9), 2))
mw = [i for i in win if i["nb"] == "Mission"]
check("page: Mission calls", out["mCalls"], len(mw))
check("page: Mission median", out["mMed"], round(nearest_rank([i["resp"] for i in mw if i["resp"] is not None], 0.5), 2))
check("page: calls received Nov 18 10:00-10:59", out["h34"], sum(1 for i in inc.values() if datetime(2026, 11, 18, 10) <= i["t"] < datetime(2026, 11, 18, 11)))
fl = [r for r in csv.DictReader(open(os.path.join(ROOT, "dataset_sf/flood_reports_311_san_francisco.csv"))) if "2026-11-18T10:00:00" <= r["dt"] < "2026-11-18T11:00:00"]
check("page: flood reports Nov 18 10:00-10:59 (inside a neighborhood or not)", out["f34"], len(fl))
hr = [r for r in csv.DictReader(open(os.path.join(ROOT, "dataset_sf/rainfall_hourly_sfo_airport.csv"))) if r["local_time"].startswith("2026-11-18 10:")]
check("page: SFO rain Nov 18 10:00 hour", out["rain34"], round(sum(float(r["rain_mm"]) for r in hr), 2))
check("page: 16th and Valencia falls in Mission", out["nbAt"], True)
print(f"\n{len(fails)} failed" if fails else "\nall checks passed")
sys.exit(1 if fails else 0)
