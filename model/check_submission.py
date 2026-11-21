"""Check a model submission before sending it back, and score it the way the site scores the placeholder.

    python3 check_submission.py submission/predictions.npz

1. Format: array names, shape, value range, no NaN. Any FAIL here means the site cannot load the file.
2. Sanity: more rain should not lower the average probability (warning only).
3. Score against the dated slides, the same way as the site's backtest: for each slide, the highest probability
   within 300 m on the three mornings before the report, compared with 300 random street spots that morning.

Numbers to beat (placeholder formula on the site, real inputs only): a slide site outscores a random street spot
6.6 times in 10. At equal shares of the map flagged it catches 2 of 10 (2.6% flagged), 3 of 10 (7.6%) and
9 of 10 (17%) of the winter 2023 slides. Slope alone is printed below as a floor.
"""
import csv, json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import handoff_common as C

BUDGETS = [0.026, 0.076, 0.17]


def load_events():
    ev = []
    for f, tag in [("landslide_events_winter2023.csv", "2023"), ("landslide_events_other_winters.csv", "other")]:
        p = os.path.join(C.DATA, f)
        if not os.path.exists(p):
            continue
        for r in csv.DictReader(open(p)):
            if r.get("lon"):
                ev.append(dict(date=r["date"], where=r["where"], rc=C.cell_of(float(r["lon"]), float(r["lat"])), tag=tag))
    return ev


def score(field_for_day, events, rain, null_masks):
    """field_for_day(i) -> flat score array for day index i. Returns per-event rows."""
    rows = []
    for e in events:
        if e["date"] not in rain.idx:
            continue
        d = rain.idx[e["date"]]; held = np.flatnonzero(C.disk(e["rc"][0], e["rc"][1], 300).ravel())
        best, bi, bf = -1.0, None, None
        for i in range(max(0, d - 3), d):
            f = field_for_day(i); v = float(f[held].max())
            if v > best:
                best, bi, bf = v, i, f
        nul = np.array([bf[m].max() for m in null_masks])
        rows.append(dict(e, peak=best, beats=float((nul < best).mean()), top=float((bf >= best).mean()),
                         caught=[bool(best >= np.quantile(bf, 1 - b)) for b in BUDGETS]))
    return rows


def summarise(name, rows):
    r23 = [r for r in rows if r["tag"] == "2023"]; ro = [r for r in rows if r["tag"] == "other"]
    line = f"{name:22s} beats random {10 * np.mean([r['beats'] for r in r23]):.1f} in 10 | median rank top {100 * np.median([r['top'] for r in r23]):.1f}% | caught "
    line += ", ".join(f"{sum(r['caught'][k] for r in r23)}/{len(r23)} at {100 * b:.1f}%" for k, b in enumerate(BUDGETS))
    if ro:
        line += f" | other winters {sum(r['caught'][1] for r in ro)}/{len(ro)} at {100 * BUDGETS[1]:.1f}%"
    print(line)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    z = np.load(sys.argv[1], allow_pickle=False); ok = True

    def check(cond, msg):
        nonlocal ok
        print(("PASS  " if cond else "FAIL  ") + msg); ok = ok and bool(cond)

    check("p" in z.files, "has array 'p'")
    if "p" not in z.files:
        sys.exit(1)
    P = z["p"]; want = (len(C.R72_LEVELS), len(C.API_LEVELS), C.H, C.WD)
    check(P.shape == want, f"shape is {want} (got {P.shape}): rain levels x wetness levels x rows north to south x columns west to east")
    check("r72_levels" in z.files and np.allclose(z["r72_levels"], C.R72_LEVELS), f"r72_levels equal {C.R72_LEVELS.tolist()}")
    check("api_levels" in z.files and np.allclose(z["api_levels"], C.API_LEVELS), f"api_levels equal {C.API_LEVELS.tolist()}")
    Pf = P.astype(np.float32)
    check(np.isfinite(Pf).all(), "no NaN or infinity")
    check(float(Pf.min()) >= 0 and float(Pf.max()) <= 1, f"values are probabilities in 0..1 (min {Pf.min():.4f}, max {Pf.max():.4f})")
    check(float(Pf.std()) > 1e-4, "not a constant map")
    if not ok or P.shape != want:
        sys.exit("\nFix the FAIL lines first. The site cannot load this file.")
    meta = json.loads(str(z["meta"])) if "meta" in z.files else {}
    m = Pf.mean(axis=(1, 2, 3)); mono = bool(np.all(np.diff(m) >= -1e-4))
    print(("PASS  " if mono else "WARN  ") + "average probability by rain level: " + ", ".join(f"{v:.4f}" for v in m) + ("" if mono else "  <- falls as rain rises, look into it"))
    if meta.get("demo"):
        print("WARN  this file came from a --demo run. It was trained on the test slides. The scores below are inflated.")
    if meta.get("sim_motion"):
        print("WARN  this run used SIMULATED ground motion. Do not report its scores.")
    if meta.get("holdout_from", "0") > "2022-10-01":
        print("WARN  holdout_from is later than 2022-10-01, so winter 2023 slides may be in the training set.")

    rain = C.Rain(); events = load_events(); rng = np.random.default_rng(11)
    lay = np.load(os.path.join(C.DATA, "grid_480x456_all_layers.npz"))
    near = np.zeros((C.H, C.WD), bool)
    for e in events:
        near |= C.disk(e["rc"][0], e["rc"][1], 450)
    null = rng.choice(np.flatnonzero(((lay["dist_road"] < 30) & ~near).ravel()), 300, replace=False)
    null_masks = [np.flatnonzero(C.disk(i // C.WD, i % C.WD, 300).ravel()) for i in null]
    cache = {}

    def model_field(i):
        if i not in cache:
            cache[i] = C.interp_storm(Pf, *rain.storm_at(i)).ravel()
        return cache[i]
    slope = lay["slope"].ravel()
    print(f"\nScored on {len(events)} dated slides ({sum(e['tag'] == '2023' for e in events)} from winter 2023):")
    rows = score(model_field, events, rain, null_masks)
    summarise("your model", rows); summarise("slope alone (floor)", score(lambda i: slope, events, rain, null_masks))
    print("placeholder on the site  beats random 6.6 in 10 | caught 2/10 at 2.6%, 3/10 at 7.6%, 9/10 at 17.0%  (from the site, real inputs only)")
    print("\nPer slide:")
    for r in sorted(rows, key=lambda r: r["date"]):
        print(f"  {r['date']}  {r['where'][:42]:42s} p {r['peak']:.3f}  top {100 * r['top']:.1f}% of map  beats {100 * r['beats']:.0f}% of random spots")
    print("\nFormat OK. Send back the whole submission folder plus your labels file and any script you changed.")


if __name__ == "__main__":
    main()
