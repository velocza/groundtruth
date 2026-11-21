"""First experiment on real labels: leave-one-slide-out with the hand-built GBM.

Labels are the ten slides reported in winter 2022 to 2023. Each report names a street,
not a spot, so every cell within 150 m of the reported point is a weak positive.
Negatives are random cells within 150 m of a road (reports only come from where roads
are) and more than 450 m from any reported slide. Features are real, static layers only:
no simulated ground motion, no elevation, no distance to road.

For each slide: train on the other nine, score the held-out site as the highest
predicted probability within 300 m, and compare with 300 random street spots scored
the same way. The mean share of random spots it beats is an AUC. Ten events cannot
validate a model; this shows the pipeline running end to end on real labels.

Run:  python3 real_label_experiment.py
"""
import csv, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gbm import GroundTruthGBM

HERE = os.path.dirname(os.path.abspath(__file__))
Z = np.load(os.path.join(HERE, "..", "dataset", "grid_480x456_all_layers.npz"))
W, E, S, N = -122.215, -122.055, 37.805, 37.925
H, Wd = Z["dem"].shape
CELL = 29.0


def cell(lon, lat):
    return int((N - lat) / (N - S) * H), int((lon - W) / (E - W) * Wd)


def window(a, k, fn):
    out = a.copy()
    p = np.pad(a, k, mode="edge")
    st = [p[i:i + H, j:j + Wd] for i in range(2 * k + 1) for j in range(2 * k + 1)]
    return fn(np.stack(st), axis=0)


def features():
    asp = np.deg2rad(Z["aspect"])
    dem = Z["dem"]
    f = {
        "slope": Z["slope"],
        "slope_max_90m": window(Z["slope"], 1, np.max),
        "relief_150m": window(dem, 2, np.max) - window(dem, 2, np.min),
        "northness": np.cos(asp) * np.sin(np.deg2rad(Z["slope"])),
        "eastness": np.sin(asp) * np.sin(np.deg2rad(Z["slope"])),
        "plan_curv": Z["plan_curv"], "prof_curv": Z["prof_curv"],
        "twi": Z["twi"], "dist_stream": Z["dist_stream"],
        "ndvi_2023": Z["ndvi_2023"], "ndvi_change": Z["ndvi_2026"] - Z["ndvi_2023"],
    }
    names = list(f)
    return np.stack([f[k].ravel() for k in names], axis=1).astype(np.float64), names


def disk(r0, c0, rad_cells):
    rr, cc = np.mgrid[0:H, 0:Wd]
    return ((rr - r0) ** 2 + (cc - c0) ** 2 <= rad_cells ** 2)


def main():
    X, names = features()
    ev = list(csv.DictReader(open(os.path.join(HERE, "..", "dataset", "landslide_events_winter2023.csv"))))
    pts = [cell(float(e["lon"]), float(e["lat"])) for e in ev]
    assert all(0 <= r < H and 0 <= c < Wd for r, c in pts)
    print("median distance to road at the 10 report points, m:", float(np.median([Z["dist_road"][r, c] for r, c in pts])))
    rng = np.random.default_rng(3)
    near_any = np.zeros((H, Wd), bool)
    for r, c in pts:
        near_any |= disk(r, c, 450 / CELL)
    road = Z["dist_road"] < 150
    neg_pool = np.flatnonzero((road & ~near_any).ravel())
    neg = rng.choice(neg_pool, 6000, replace=False)
    null = rng.choice(np.setdiff1d(np.flatnonzero(((Z["dist_road"] < 30) & ~near_any).ravel()), neg), 300, replace=False)
    null_masks = [np.flatnonzero(disk(i // Wd, i % Wd, 300 / CELL).ravel()) for i in null]

    def evaluate(score):                     # score: flat array over the grid
        nul = np.array([score[m].max() for m in null_masks])
        return nul

    rows, beats_g, beats_s = [], [], []
    slope_score = X[:, names.index("slope")]
    nul_s = evaluate(slope_score)
    imp_sum = {}
    for k, (r, c) in enumerate(pts):
        pos = np.concatenate([np.flatnonzero(disk(rr, cc, 150 / CELL).ravel()) for j, (rr, cc) in enumerate(pts) if j != k])
        far = np.flatnonzero(~disk(r, c, 1000 / CELL).ravel())
        ng = np.intersect1d(neg, far)
        Xi = np.vstack([X[pos], X[ng]]); yi = np.r_[np.ones(len(pos)), np.zeros(len(ng))]
        wi = np.r_[np.full(len(pos), len(ng) / len(pos) / 4), np.ones(len(ng))]
        m = GroundTruthGBM(n_trees=80, eta=0.08, max_depth=3, min_leaf=30, subsample=0.8, colsample=0.8, seed=k).fit(Xi, yi, wi, names=names)
        pr = m.predict_proba(X)
        held = np.flatnonzero(disk(r, c, 300 / CELL).ravel())
        g = float((evaluate(pr) < pr[held].max()).mean()); s = float((nul_s < slope_score[held].max()).mean())
        beats_g.append(g); beats_s.append(s)
        for n_, v in m.importance():
            imp_sum[n_] = imp_sum.get(n_, 0) + v / len(pts)
        rows.append({"where": ev[k]["where"], "gbm_beats_random": round(g, 3), "slope_only_beats_random": round(s, 3)})
        print(f"{ev[k]['where'][:44]:44s} GBM {g:.2f}  slope only {s:.2f}")
    out = {"events": rows, "auc_gbm_leave_one_slide_out": round(float(np.mean(beats_g)), 3), "auc_slope_only": round(float(np.mean(beats_s)), 3),
           "mean_importance": sorted(((k, round(v, 3)) for k, v in imp_sum.items()), key=lambda t: -t[1]),
           "note": "10 events, weak street-level labels, static real features only. Not a validation."}
    print(json.dumps({k: v for k, v in out.items() if k != "events"}, indent=1))
    json.dump(out, open(os.path.join(HERE, "real_label_experiment.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
