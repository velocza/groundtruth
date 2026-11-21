"""Training template for the GroundTruth model. Fill in the two TODO blocks, run, send back the outputs.

    python3 train_template.py --labels my_labels.csv                 # the real run
    python3 train_template.py --labels my_labels.csv --insar insar_grid.npz
    python3 train_template.py --demo                                 # plumbing test on the 10 reported slides

What it does
    1. Builds one row per (cell, morning): static terrain features + that morning's storm.
    2. Positives: cells within radius_m of a mapped slide, on the wettest of the three mornings before it.
       Negatives: random cells near roads, half on the same mornings (teaches WHERE), half on random
       mornings from the gauge record (teaches WHEN).
    3. Holds out everything from 2022-10-01 on (winter 2023 is the test, never train on it).
    4. Spatial 5-fold cross-validation on the training period, then one final fit.
    5. Calibrates with Platt scaling and writes the probability lookup the site reads.

Outputs, written to ./submission/
    predictions.npz   p[8, 6, 456, 480] float16 probability for each (rain, soil wetness) pair, plus the two level
                      arrays, feature names and a JSON string of run details. THIS is what the site needs.
    trees.json        the trained trees (for the per-street explanations later).
    report.json       cross-validation AUC per fold, feature importance, row counts.
Then run:  python3 check_submission.py submission/predictions.npz
"""
import argparse, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gbm import GroundTruthGBM, auc, platt_fit, sigmoid, spatial_blocks
import handoff_common as C

HOLDOUT_FROM = "2022-10-01"       # labels on or after this date are test only
NEG_PER_POS = 8                   # negatives per positive row
SEED = 0

# TODO 1 (model team): hyperparameters. Start here, then search as the plan's section 9 describes.
PARAMS = dict(n_trees=300, eta=0.06, max_depth=4, min_leaf=40, subsample=0.8, colsample=0.8, lam=1.0, early_stop=30)


def build_rows(labels, Xs, rain, rng, road_ok):
    """labels -> (X, y, w, cell_row, cell_col). See the module docstring for the sampling design."""
    rows, ys, cells = [], [], []
    near_any = np.zeros((C.H, C.WD), bool)
    for L in labels:
        near_any |= C.disk(L["row"], L["col"], 450)
    neg_pool = np.flatnonzero((road_ok & ~near_any).ravel())
    for L in labels:
        if L["date"] not in rain.idx:
            continue
        _, r72, api = rain.before_report(L["date"])
        pos = np.flatnonzero(C.disk(L["row"], L["col"], L["radius_m"]).ravel())
        rows.append(C.with_storm(Xs[pos], r72, api)); ys.append(np.ones(len(pos))); cells.append(pos)
        k = len(pos) * NEG_PER_POS // 2
        same = rng.choice(neg_pool, k)                                   # same morning, other places
        rows.append(C.with_storm(Xs[same], r72, api)); ys.append(np.zeros(k)); cells.append(same)
        other = rng.choice(np.r_[pos, rng.choice(neg_pool, k)], k)       # other mornings, same and other places
        days = rng.integers(0, rain.n, k); st = np.array([rain.storm_at(int(d)) for d in days])
        rows.append(C.with_storm(Xs[other], st[:, 0], st[:, 1])); ys.append(np.zeros(k)); cells.append(other)
    X, y, cell = np.vstack(rows), np.concatenate(ys), np.concatenate(cells)
    w = np.where(y == 1, (y == 0).sum() / max(1, (y == 1).sum()) / 4, 1.0)   # positives weigh a quarter of the negatives in total
    return X, y, w, cell // C.WD, cell % C.WD


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels"); ap.add_argument("--insar"); ap.add_argument("--demo", action="store_true")
    ap.add_argument("--sim-motion", action="store_true", help="include SIMULATED motion (plumbing only)")
    ap.add_argument("--out", default="submission")
    a = ap.parse_args()
    if not a.labels and not a.demo:
        ap.error("give --labels my_labels.csv, or --demo")
    rng = np.random.default_rng(SEED); rain = C.Rain()
    Xs, names = C.static_features(use_sim_motion=a.sim_motion, insar_npz=a.insar)
    names = names + C.STORM_NAMES
    road_ok = np.load(os.path.join(C.DATA, "grid_480x456_all_layers.npz"))["dist_road"] < 150

    # TODO 2 (model team): labels. One row per mapped slide: date, lon, lat, and optionally radius_m and source.
    # Build it from the USGS January 2023 inventory (doi 10.5066/P9NJ3KMG) for the TEST period and from the state
    # landslide inventory and older USGS maps for the TRAINING period. Dates matter: a slide with no date cannot
    # be paired with a storm, so give undated mapped slides the date of the wettest storm of their mapping season
    # and say so in the source column.
    path = a.labels or os.path.join(C.DATA, "landslide_events_winter2023.csv")
    labels = C.read_labels(path)
    train = [L for L in labels if L["date"] < HOLDOUT_FROM]; test = [L for L in labels if L["date"] >= HOLDOUT_FROM]
    if a.demo:
        print("DEMO: training on the 10 reported slides, all of them in the test winter. This only proves the files flow.\n"
              "      Any score the checker prints for this run is inflated and must not be reported.")
        train, test = labels, []
    if len(train) < 30 and not a.demo:
        print(f"WARNING: only {len(train)} training slides before {HOLDOUT_FROM}. Ten weak labels trained to chance in our trial; aim for hundreds.")
    if not train:
        sys.exit("No training labels before " + HOLDOUT_FROM + ". Add older slides, or use --demo for a plumbing test.")

    X, y, w, row, col = build_rows(train, Xs, rain, rng, road_ok)
    print(f"rows {len(y):,}  positives {int(y.sum()):,}  features {len(names)}  train slides {len(train)}  held-out slides {len(test)}")

    fold = spatial_blocks(row, col, block=40, k=5, seed=SEED); cv = []
    for k in range(5):
        tr, va = fold != k, fold == k
        if y[va].sum() == 0 or y[tr].sum() == 0:
            continue
        m = GroundTruthGBM(seed=k, **PARAMS).fit(X[tr], y[tr], w[tr], X[va], y[va], names=names)
        cv.append(round(float(auc(y[va], m.raw(X[va]))), 3))
    print("spatial cross-validation AUC per fold:", cv, " mean", round(float(np.mean(cv)), 3) if cv else "n/a")

    model = GroundTruthGBM(seed=SEED, **dict(PARAMS, early_stop=10 ** 9)).fit(X, y, w, names=names)
    # Calibrate against the unweighted rows, so the output is a probability for the sampled mix. The base rate in
    # the sample is far above the real one; section 11 of the plan covers correcting it once real counts exist.
    pa, pb = platt_fit(model.raw(X), y)

    P = np.zeros((len(C.R72_LEVELS), len(C.API_LEVELS), C.H, C.WD), np.float16)
    for i, r in enumerate(C.R72_LEVELS):
        for j, s in enumerate(C.API_LEVELS):
            P[i, j] = sigmoid(pa * model.raw(C.with_storm(Xs, float(r), float(s))) + pb).reshape(C.H, C.WD)
    os.makedirs(a.out, exist_ok=True)
    meta = dict(holdout_from=HOLDOUT_FROM, demo=bool(a.demo), sim_motion=bool(a.sim_motion), real_insar=bool(a.insar), params=PARAMS,
                train_slides=len(train), heldout_slides=len(test), rows=int(len(y)), cv_auc=cv, platt=[pa, pb], labels_file=os.path.basename(path))
    np.savez_compressed(os.path.join(a.out, "predictions.npz"), p=P, r72_levels=C.R72_LEVELS, api_levels=C.API_LEVELS,
                        feature_names=np.array(names), meta=json.dumps(meta))
    model.export(os.path.join(a.out, "trees.json"))
    json.dump(dict(meta, importance=model.importance()), open(os.path.join(a.out, "report.json"), "w"), indent=1)
    print("wrote", a.out + "/predictions.npz, trees.json, report.json")
    print("top features:", ", ".join(f"{n} {v:.2f}" for n, v in model.importance()[:6]))


if __name__ == "__main__":
    main()
