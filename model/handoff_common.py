"""Shared pieces for the model handoff: the grid, the feature table, the rain record and the output format.

Both train_template.py and check_submission.py import this, so the people training the model and the
person plugging it into the site agree on every definition. Change features here, nowhere else.
"""
import csv, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "..", "dataset")

# ----------------------------------------------------------------------------- grid
W, E, S, N = -122.215, -122.055, 37.805, 37.925       # bounding box, degrees
H, WD = 456, 480                                      # rows (north to south), columns (west to east)
CELL_M = 29.0                                         # about 29 m per cell


def cell_of(lon, lat):
    """lon, lat -> (row, col). Row 0 is the north edge."""
    return int((N - lat) / (N - S) * H), int((lon - W) / (E - W) * WD)


def disk(r0, c0, radius_m):
    rr, cc = np.mgrid[0:H, 0:WD]
    return (rr - r0) ** 2 + (cc - c0) ** 2 <= (radius_m / CELL_M) ** 2


# ----------------------------------------------------------------------------- output format the site reads
# The site lets the user set any storm, so one map is not enough. The model is asked for a probability map at
# every combination of these two dials, and the site blends between the nearest ones.
R72_LEVELS = np.array([0, 25, 50, 75, 100, 150, 200, 300], dtype=np.float32)   # rain in the next 72 hours, mm
API_LEVELS = np.array([0, 50, 100, 150, 200, 280], dtype=np.float32)           # soil wetness index, mm


# ----------------------------------------------------------------------------- features
def _window(a, k, fn):
    p = np.pad(a, k, mode="edge")
    return fn(np.stack([p[i:i + H, j:j + WD] for i in range(2 * k + 1) for j in range(2 * k + 1)]), axis=0)


def static_features(use_sim_motion=False, insar_npz=None):
    """Per-cell features that do not change with the storm. Returns (X [H*WD, d], names).

    use_sim_motion: include the SIMULATED ground motion layers. Only for plumbing tests. Never report results with it.
    insar_npz:      path to real InSAR layers on this same grid, an .npz with arrays shaped (456, 480):
                    v_long (mm/yr, long-term line-of-sight speed), v_recent (mm/yr, last 12 months), coherence (0..1).
                    NaN where the radar has no reading. The GBM handles NaN by sending it to the last bin.
    """
    z = np.load(os.path.join(DATA, "grid_480x456_all_layers.npz"))
    asp, slope, dem = np.deg2rad(z["aspect"]), z["slope"], z["dem"]
    f = {
        "slope_deg": slope,
        "slope_max_90m": _window(slope, 1, np.max),
        "relief_150m": _window(dem, 2, np.max) - _window(dem, 2, np.min),
        "northness": np.cos(asp) * np.sin(np.deg2rad(slope)),
        "eastness": np.sin(asp) * np.sin(np.deg2rad(slope)),
        "plan_curv": z["plan_curv"], "prof_curv": z["prof_curv"],
        "twi": z["twi"], "dist_stream_m": z["dist_stream"],
        "ndvi_2023": z["ndvi_2023"], "ndvi_change": z["ndvi_2026"] - z["ndvi_2023"],
    }
    if insar_npz:
        r = np.load(insar_npz)
        f["insar_v_long"] = r["v_long"]; f["insar_v_recent"] = r["v_recent"]
        f["insar_accel"] = r["v_recent"] - r["v_long"]; f["insar_coherence"] = r["coherence"]
    elif use_sim_motion:
        f["SIM_v_long"] = z["SIM_v_pre"]; f["SIM_v_recent"] = z["SIM_v_now"]; f["SIM_accel"] = z["SIM_v_now"] - z["SIM_v_pre"]
    names = list(f)
    return np.stack([f[k].ravel() for k in names], axis=1).astype(np.float64), names


STORM_NAMES = ["rain_72h_mm", "api_mm", "trigger_T"]


def trigger_T(r72, api):
    """The same rain trigger the site uses. Kept as a feature because it already times slides well."""
    return 0.55 * np.minimum(1.5, np.asarray(r72) / 200.0) + 0.45 * np.minimum(1.3, np.asarray(api) / 200.0)


def with_storm(Xs, r72, api):
    """Append the storm columns to static rows. r72 and api can be scalars or one value per row."""
    n = len(Xs); r = np.broadcast_to(np.asarray(r72, float), (n,)); a = np.broadcast_to(np.asarray(api, float), (n,))
    return np.column_stack([Xs, r, a, trigger_T(r, a)])


# ----------------------------------------------------------------------------- rain record
class Rain:
    """Daily gauge rain, 2015-10-01 on. storm(date) gives what a forecaster would have set that morning."""

    def __init__(self):
        rows = list(csv.DictReader(open(os.path.join(DATA, "rainfall_daily_lamorinda.csv"))))
        self.dates = [r["date"] for r in rows]; self.idx = {d: i for i, d in enumerate(self.dates)}
        self.mm = np.array([float(r["rain_mm_area_mean"] or 0) for r in rows])
        self.api = np.array([float(r["api_mm_k0.92"] or 0) for r in rows])
        self.n = len(rows) - 3

    def storm_at(self, i):
        """Day index -> (rain in the following 72 hours, soil wetness that day). Matches the site."""
        return float(self.mm[i + 1] + self.mm[i + 2] + self.mm[i + 3]), float(self.api[i])

    def storm_before(self, i, d):
        """Like storm_at(i), but for a slide reported on day d: rain logged after the report date is left out.
        Each gauge value covers the 24 hours up to that morning, so without the cap the morning before a report
        would be credited with up to two days of rain that fell after the slide was already reported."""
        return float(self.mm[i + 1:min(i + 3, d) + 1].sum()), float(self.api[i])

    def before_report(self, date):
        """For a slide reported on `date`: the wettest of the three mornings before it, as (day index, r72, api),
        counting only rain logged up to the report date."""
        d = self.idx[date]; best = max(range(max(0, d - 3), d), key=lambda i: trigger_T(*self.storm_before(i, d)))
        return (best,) + self.storm_before(best, d)


def read_labels(path):
    """labels CSV -> list of dicts. Required columns: date (YYYY-MM-DD), lon, lat. Optional: radius_m, source."""
    out = []
    for r in csv.DictReader(open(path)):
        row, col = cell_of(float(r["lon"]), float(r["lat"]))
        if 0 <= row < H and 0 <= col < WD:
            out.append({"date": r["date"], "row": row, "col": col, "radius_m": float(r.get("radius_m") or 150), "where": r.get("where", "")})
    return out


def interp_storm(P, r72, api):
    """Blend the lookup P[len(R72_LEVELS), len(API_LEVELS), H, WD] to one storm. This is what the site does."""
    def pos(levels, v):
        v = float(np.clip(v, levels[0], levels[-1])); j = int(np.clip(np.searchsorted(levels, v) - 1, 0, len(levels) - 2))
        return j, (v - levels[j]) / (levels[j + 1] - levels[j])
    i, u = pos(R72_LEVELS, r72); j, v = pos(API_LEVELS, api)
    P = P.astype(np.float32)
    return (1 - u) * (1 - v) * P[i, j] + u * (1 - v) * P[i + 1, j] + (1 - u) * v * P[i, j + 1] + u * v * P[i + 1, j + 1]
