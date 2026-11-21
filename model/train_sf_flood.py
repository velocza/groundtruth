"""San Francisco flood model: time-budgeted hyperparameter search, then one final fit and one test.

Labels: SF 311 rain-linked flood reports (dataset_sf/training/training_rows_flood.csv.gz).
Model selection uses ONLY split == train (before 2022-10-01) with the precomputed spatial cv_fold.
Test splits (winter 2023, Nov 2026 storm) are scored once, after selection.
flood_reports_train is excluded (it contains the training positives themselves).

Usage: python3 model/train_sf_flood.py --minutes 65 --workers 8
"""
import argparse, csv, gzip, json, os, sys, time, zlib, struct
import multiprocessing as mp
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model'))
from gbm import GroundTruthGBM, auc

OUT = ROOT / 'local_model_sf'
TERRAIN = ['slope_deg', 'slope_max_90m', 'relief_150m', 'northness', 'eastness', 'plan_curv', 'prof_curv',
           'twi', 'dist_stream_m', 'ndvi_2023', 'ndvi_change']
STORM = ['rain_72h_mm', 'api_mm', 'trigger_T']
GEOGRAPHY = ['sink_depth_m', 'low_vs_150m_m', 'low_vs_450m_m', 'elev_above_min_300m_m',
             'log10_drain_area_m2', 'dist_open_water_m', 'built_frac_70m', 'buildings_count']
FEATURE_SETS = {
    'terrain+storm': TERRAIN + STORM,
    'terrain+storm+geography': TERRAIN + STORM + GEOGRAPHY,
    'terrain+storm+geography+elev_road': TERRAIN + STORM + GEOGRAPHY + ['elev_m', 'dist_road_m'],
}
BASELINE = dict(feature_set='terrain+storm+geography', n_trees=120, eta=0.08, max_depth=4, min_leaf=20,
                lam=1.0, subsample=0.8, colsample=0.8, max_bins=64, pos_weight=1.0)

D = {}


def load():
    rows = list(csv.DictReader(gzip.open(ROOT / 'dataset_sf/training/training_rows_flood.csv.gz', 'rt')))
    cols = sorted(set(sum(FEATURE_SETS.values(), [])))
    D['X'] = {c: np.array([float(r[c]) if r[c] != '' else np.nan for r in rows]) for c in cols}
    D['y'] = np.array([int(r['y']) for r in rows])
    D['w'] = np.array([float(r['weight']) for r in rows])
    D['split'] = np.array([r['split'] for r in rows])
    D['fold'] = np.array([int(r['cv_fold']) for r in rows])
    D['stype'] = np.array([r['sample_type'] for r in rows])
    D['morning'] = np.array([r['morning'] for r in rows])


def matrix(fs, mask=slice(None)):
    return np.column_stack([D['X'][c][mask] for c in FEATURE_SETS[fs]])


def where_when(y, s, stype, morning):
    """WHERE: positives vs same-morning negatives. WHEN: positives vs other-morning negatives."""
    pos = y == 1
    same = (~pos) & (stype == 'neg_same_morning')
    other = (~pos) & (stype == 'neg_other_morning')
    out = {}
    for k, neg in (('where', same), ('when', other)):
        m = pos | neg
        out[k] = auc(y[m], s[m]) if neg.any() else None
    return out


def make_model(cfg):
    return GroundTruthGBM(n_trees=cfg['n_trees'], eta=cfg['eta'], max_depth=cfg['max_depth'], min_leaf=cfg['min_leaf'],
                          lam=cfg['lam'], subsample=cfg['subsample'], colsample=cfg['colsample'],
                          max_bins=cfg['max_bins'], seed=42)


def weights(cfg, mask):
    return D['w'][mask] * np.where(D['y'][mask] == 1, cfg['pos_weight'], 1.0)


def cv_job(cfg):
    if not D: load()
    t0 = time.time(); tr_all = D['split'] == 'train'; res = []
    for k in range(5):
        tr, va = tr_all & (D['fold'] != k), tr_all & (D['fold'] == k)
        m = make_model(cfg).fit(matrix(cfg['feature_set'], tr), D['y'][tr], weights(cfg, tr))
        s = m.raw(matrix(cfg['feature_set'], va))
        ww = where_when(D['y'][va], s, D['stype'][va], D['morning'][va])
        res.append(dict(auc=auc(D['y'][va], s), **ww))
    mean = lambda k: float(np.mean([r[k] for r in res if r[k] is not None]))
    return dict(cfg=cfg, cv_auc=mean('auc'), cv_where=mean('where'), cv_when=mean('when'),
                cv_auc_folds=[r['auc'] for r in res], seconds=time.time() - t0)


def sample_cfg(rng):
    return dict(feature_set=str(rng.choice(list(FEATURE_SETS))),
                n_trees=int(rng.choice([80, 120, 200, 300, 400])),
                eta=float(rng.choice([0.03, 0.05, 0.08, 0.12])),
                max_depth=int(rng.choice([2, 3, 4, 5, 6])),
                min_leaf=int(rng.choice([10, 20, 50, 100, 200])),
                lam=float(rng.choice([0.5, 1.0, 3.0, 10.0])),
                subsample=float(rng.choice([0.6, 0.8, 1.0])),
                colsample=float(rng.choice([0.5, 0.7, 0.8, 1.0])),
                max_bins=int(rng.choice([32, 64])),
                pos_weight=float(rng.choice([1.0, 2.0])))


def write_png(path, rgb):
    h, w, _ = rgb.shape
    raw = b''.join(b'\x00' + rgb[i].astype(np.uint8).tobytes() for i in range(h))
    chunk = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    Path(path).write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
                           + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b''))


def geography_map(model, cfg, log):
    """Score every land cell for the Nov 18 2026 storm morning and draw the city."""
    fs = FEATURE_SETS[cfg['feature_set']]
    days = {r['date']: r for r in csv.DictReader(gzip.open(ROOT / 'dataset_sf/training/flood_days.csv.gz', 'rt'))}
    d = days['2026-11-18']; r72, api, T = float(d['storm_rain_72h_mm']), float(d['storm_api_mm']), float(d['storm_trigger_T'])
    rows = list(csv.DictReader(gzip.open(ROOT / 'dataset_sf/training/cells.csv.gz', 'rt')))
    storm = {'rain_72h_mm': r72, 'api_mm': api, 'trigger_T': T}
    num = lambda v: float(v) if v not in ('', None) else np.nan
    X = np.array([[storm[c] if c in storm else num(r[c]) for c in fs] for r in rows])
    land = np.array([r['is_land'] in ('1', '1.0', 'True') for r in rows])
    rr, cc = np.array([int(r['row']) for r in rows]), np.array([int(r['col']) for r in rows])
    hit = np.array([num(r['flood_reports_test_nov2026']) > 0 for r in rows])
    hood = np.array([r['neighborhood'] for r in rows])
    s = model.predict_proba(X) * 100
    map_auc = auc(hit[land].astype(int), s[land])
    H, W = rr.max() + 1, cc.max() + 1
    img = np.full((H, W, 3), 225, float)
    v = np.clip((s - np.percentile(s[land], 5)) / (np.percentile(s[land], 99.5) - np.percentile(s[land], 5)), 0, 1)
    ramp = np.array([[255, 255, 204], [254, 217, 118], [253, 141, 60], [227, 26, 28], [128, 0, 38]], float)
    t = v * (len(ramp) - 1); i = np.minimum(t.astype(int), len(ramp) - 2); f = (t - i)[:, None]
    col = ramp[i] * (1 - f) + ramp[i + 1] * f
    img[rr[land], cc[land]] = col[land]
    img[rr[~land], cc[~land]] = [170, 200, 225]
    write_png(OUT / 'sf_flood_map_2026-11-18.png', img)
    obs = img.copy(); obs[rr[land & hit], cc[land & hit]] = [0, 90, 200]
    write_png(OUT / 'sf_flood_map_2026-11-18_with_reports.png', obs)
    top = {}
    for h in np.unique(hood[land]):
        m = land & (hood == h)
        if h and m.sum() > 50: top[h] = float(np.mean(np.sort(s[m])[-max(1, int(m.sum() * .1)):]))
    top = sorted(top.items(), key=lambda kv: -kv[1])[:10]
    log(f'map: Nov 18 2026 storm (r72={r72} api={api}), land cells={land.sum()}, citywide map AUC vs reported cells={map_auc:.3f}')
    return dict(storm_morning=d['storm_morning'], rain_72h_mm=r72, api_mm=api, land_cells=int(land.sum()),
                reported_cells=int((land & hit).sum()), map_auc_reported_vs_not=map_auc,
                top_neighbourhoods_top10pct_mean_score=top)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--minutes', type=float, default=65)
    ap.add_argument('--workers', type=int, default=8)
    args = ap.parse_args()
    OUT.mkdir(exist_ok=True)
    logf = (OUT / 'search_log.txt').open('a')
    def log(msg):
        line = f'[{time.strftime("%H:%M:%S")}] {msg}'; print(line, flush=True); logf.write(line + '\n'); logf.flush()
    deadline = time.time() + args.minutes * 60
    load()
    log(f'rows={len(D["y"])} train={(D["split"]=="train").sum()} sample_types={sorted(set(D["stype"]))}')
    rng = np.random.default_rng(7)
    results = []
    jsonl = (OUT / 'search_results.jsonl').open('w')

    def configs():
        yield dict(BASELINE)
        while time.time() < deadline:
            yield sample_cfg(rng)

    with mp.get_context('spawn').Pool(args.workers, initializer=load) as pool:
        for r in pool.imap_unordered(cv_job, configs()):
            results.append(r); jsonl.write(json.dumps(r) + '\n'); jsonl.flush()
            best = max(results, key=lambda x: x['cv_auc'])
            c = r['cfg']
            log(f"#{len(results):3d} cv_auc={r['cv_auc']:.4f} where={r['cv_where']:.3f} when={r['cv_when']:.3f} "
                f"({r['seconds']:.0f}s) {c['feature_set']} trees={c['n_trees']} eta={c['eta']} depth={c['max_depth']} "
                f"| best {best['cv_auc']:.4f}")

    best = max(results, key=lambda x: x['cv_auc'])
    base = results[0] if results[0]['cfg'] == BASELINE else next(r for r in results if r['cfg'] == BASELINE)
    by_fs = {fs: max((r['cv_auc'] for r in results if r['cfg']['feature_set'] == fs), default=None) for fs in FEATURE_SETS}
    log(f'search done: {len(results)} configs. best cv_auc={best["cv_auc"]:.4f} (baseline {base["cv_auc"]:.4f}) cfg={best["cfg"]}')

    tr = D['split'] == 'train'
    def final(cfg):
        m = make_model(cfg).fit(matrix(cfg['feature_set'], tr), D['y'][tr], weights(cfg, tr), names=FEATURE_SETS[cfg['feature_set']])
        tests = {}
        for sp in ('test_winter2023', 'test_nov2026_storm', 'later_2023_2026'):
            mk = D['split'] == sp; s = m.raw(matrix(cfg['feature_set'], mk))
            tests[sp] = dict(auc=auc(D['y'][mk], s), **where_when(D['y'][mk], s, D['stype'][mk], D['morning'][mk]), rows=int(mk.sum()))
        return m, tests
    model, tests = final(best['cfg'])
    _, base_tests = final(BASELINE)
    for sp in tests:
        log(f"TEST {sp}: tuned auc={tests[sp]['auc']:.3f} where={tests[sp]['where']:.3f} when={tests[sp]['when']:.3f} | "
            f"baseline auc={base_tests[sp]['auc']:.3f} where={base_tests[sp]['where']:.3f} when={base_tests[sp]['when']:.3f}")
    model.export(str(OUT / 'trees.json'))
    geo = geography_map(model, best['cfg'], log)
    report = dict(city='San Francisco', hazard='street flooding (SF 311 rain-linked reports)',
                  status='experimental; uncalibrated scores; 311 reports reflect who reports, not all flooding',
                  selection='random search, 5-fold spatial CV on split=train (before 2022-10-01) only; tests scored once after',
                  search_minutes=args.minutes, configs_tried=len(results), best_cfg=best['cfg'],
                  best_cv=dict(auc=best['cv_auc'], where=best['cv_where'], when=best['cv_when']),
                  baseline_cfg=BASELINE, baseline_cv=dict(auc=base['cv_auc'], where=base['cv_where'], when=base['cv_when']),
                  best_cv_auc_by_feature_set=by_fs, tests_tuned=tests, tests_baseline=base_tests,
                  feature_importance=model.importance(), geography_map=geo,
                  excluded=['flood_reports_train (leaks training positives)', 'neighborhood_id (memorisation)'])
    (OUT / 'report.json').write_text(json.dumps(report, indent=2))
    log('wrote local_model_sf/trees.json, report.json, sf_flood_map_2026-11-18*.png')


if __name__ == '__main__':
    main()
