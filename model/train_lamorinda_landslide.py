"""Lamorinda landslide model trained on the USGS 2016-17 storm-season inventory (1,398 mapped slides).

Labels: dataset/usgs_landslides_2016_17.csv (USGS SIM 3503, doi 10.5066/P98MVEGI). Undated within the season, so each
slide is paired with the wettest storm mornings of winter 2016-17. Negatives are sampled ONLY inside the USGS mapped
boundary (site/data/usgs_inventory.js bound17), at least 90 m from any mapped slide.

Features: terrain only (no elevation, no distance to road, no NDVI: NDVI is from 2023/2026, after the test slides)
plus the storm columns. Selection: time-budgeted random search on 5-fold spatial-block CV.
Held-out test, scored once after selection: the ten placed winter 2022-23 slide reports and the USGS 2023 point,
compared with slope alone and the old 4-report model (local_model/trees.json).

Usage: python3 model/train_lamorinda_landslide.py --minutes 20 --workers 10
"""
import argparse, csv, json, math, sys, time, zlib, struct
import multiprocessing as mp
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model')); sys.path.insert(0, str(ROOT))
from gbm import GroundTruthGBM, auc, spatial_blocks
import handoff_common as C

OUT = ROOT / 'local_model_landslide'
TERRAIN = ['slope_deg', 'slope_max_90m', 'relief_150m', 'northness', 'eastness', 'plan_curv', 'prof_curv', 'twi', 'dist_stream_m']
NAMES = TERRAIN + C.STORM_NAMES
SEASON = ('2016-10-01', '2017-03-10')     # image date 2017-03-11
D = {}


def static():
    X, names = C.static_features()
    return X[:, [names.index(n) for n in TERRAIN]]


def inside_bound(rings):
    """Cell centres inside any USGS 2016-17 mapped boundary ring (even-odd rule)."""
    rr, cc = np.mgrid[0:C.H, 0:C.WD]
    lon = C.W + (cc + .5) / C.WD * (C.E - C.W); lat = C.N - (rr + .5) / C.H * (C.N - C.S)
    out = np.zeros(lon.shape, bool)
    for ring in rings:
        p = np.array(ring); x0, y0 = p[:, 0], p[:, 1]; x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
        ins = np.zeros(lon.shape, bool)
        for a, b, c, d in zip(x0, y0, x1, y1):
            if b == d: continue
            cross = ((b > lat) != (d > lat)) & (lon < (c - a) * (lat - b) / (d - b) + a)
            ins ^= cross
        out |= ins
    return out.ravel()


def slide_cells(rows):
    """Cells touched by each slide's long axis (sampled every 10 m) plus its centroid."""
    cells = set()
    for r in rows:
        pts = [(float(r['lon']), float(r['lat']))]
        a = (float(r['axis_lon0']), float(r['axis_lat0'])); b = (float(r['axis_lon1']), float(r['axis_lat1']))
        n = max(2, int(float(r['length_m'] or 0) / 10) + 1)
        pts += [(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t) for t in np.linspace(0, 1, n)]
        for lo, la in pts:
            rc = C.cell_of(lo, la)
            if 0 <= rc[0] < C.H and 0 <= rc[1] < C.WD: cells.add(rc[0] * C.WD + rc[1])
    return np.array(sorted(cells))


def build():
    rng = np.random.default_rng(42)
    Xs = static(); rain = C.Rain()
    t = (ROOT / 'site/data/usgs_inventory.js').read_text(); g = json.loads(t[t.index('{'):].rstrip().rstrip(';'))
    mapped = inside_bound([b['ring'] for b in g['bound17']])
    rows = list(csv.DictReader(open(ROOT / 'dataset/usgs_landslides_2016_17.csv')))
    pos = slide_cells(rows)
    near = np.zeros(C.H * C.WD, bool); near[pos] = True
    k = 3; nr = near.reshape(C.H, C.WD); p = np.pad(nr, k)
    near = np.any([p[i:i + C.H, j:j + C.WD] for i in range(2 * k + 1) for j in range(2 * k + 1)], axis=0).ravel()
    neg_pool = np.flatnonzero(mapped & ~near & ~np.isnan(Xs).any(1))
    days = [i for i in range(rain.n) if SEASON[0] <= rain.dates[i] <= SEASON[1]]
    storms = sorted(days, key=lambda i: -C.trigger_T(*rain.storm_at(i)))[:6]
    train_days = np.array([i for i in range(rain.n) if rain.dates[min(i + 3, len(rain.dates) - 1)] < '2022-10-01'])
    dry = [int(i) for i in train_days if rain.storm_at(int(i))[0] < 5]
    xs, ys, ids, st = [], [], [], []
    for d in storms:
        r72, api = rain.storm_at(d)
        neg = rng.choice(neg_pool, len(pos) * 4, replace=False)
        for cells, y, tag in ((pos, 1, 'positive'), (neg, 0, 'neg_same_morning')):
            xs.append(C.with_storm(Xs[cells], r72, api)); ys.append(np.full(len(cells), y)); ids.append(cells); st += [tag] * len(cells)
    dd = rng.choice(dry, len(pos) * 3)
    sv = np.array([rain.storm_at(int(i)) for i in dd]); pc = rng.choice(pos, len(dd))
    xs.append(C.with_storm(Xs[pc], sv[:, 0], sv[:, 1])); ys.append(np.zeros(len(pc))); ids.append(pc); st += ['neg_other_morning'] * len(pc)
    D.update(X=np.vstack(xs), y=np.concatenate(ys).astype(int), ids=np.concatenate(ids), stype=np.array(st))
    D['fold'] = spatial_blocks(D['ids'] // C.WD, D['ids'] % C.WD, block=40, k=5, seed=0)
    D['meta'] = dict(slides=len(rows), positive_cells=int(len(pos)), mapped_cells=int(mapped.sum()), neg_pool=int(len(neg_pool)),
                     storm_mornings=[(rain.dates[d], *[round(v, 1) for v in rain.storm_at(d)]) for d in storms])
    D['Xs'], D['rain'], D['mapped'] = Xs, rain, mapped


def ww(y, s, stype):
    out = dict(auc=auc(y, s))
    for k, t in (('where', 'neg_same_morning'), ('when', 'neg_other_morning')):
        m = (y == 1) | (stype == t); out[k] = auc(y[m], s[m])
    return out


def make(cfg):
    return GroundTruthGBM(n_trees=cfg['n_trees'], eta=cfg['eta'], max_depth=cfg['max_depth'], min_leaf=cfg['min_leaf'], lam=cfg['lam'],
                          subsample=cfg['subsample'], colsample=cfg['colsample'], max_bins=cfg['max_bins'], seed=42)


def cv_job(cfg):
    if not D: build()
    t0 = time.time(); res = []
    for k in range(5):
        tr, va = D['fold'] != k, D['fold'] == k
        m = make(cfg).fit(D['X'][tr], D['y'][tr])
        res.append(ww(D['y'][va], m.raw(D['X'][va]), D['stype'][va]))
    mean = lambda k: float(np.mean([r[k] for r in res]))
    return dict(cfg=cfg, cv_auc=mean('auc'), cv_where=mean('where'), cv_when=mean('when'), seconds=time.time() - t0)


BASELINE = dict(n_trees=120, eta=0.08, max_depth=4, min_leaf=20, lam=1.0, subsample=0.8, colsample=0.8, max_bins=64)


def sample(rng):
    return dict(n_trees=int(rng.choice([80, 120, 200, 300, 400])), eta=float(rng.choice([0.03, 0.05, 0.08, 0.12])),
                max_depth=int(rng.choice([2, 3, 4, 5, 6])), min_leaf=int(rng.choice([10, 20, 50, 100, 200])),
                lam=float(rng.choice([0.5, 1.0, 3.0, 10.0])), subsample=float(rng.choice([0.6, 0.8, 1.0])),
                colsample=float(rng.choice([0.5, 0.7, 0.8, 1.0])), max_bins=int(rng.choice([32, 64])))


def predict_tree(art, X):
    from local_simulation import predict
    return predict(art, X)


def holdout(score_fn, log, label):
    """Winter 2022-23 reports: rank of each slide's cell (max within 150 m) among 100 random street spots and
    among all land cells, under the storm before its report date."""
    rain, rng = D['rain'], np.random.default_rng(3)
    text = (ROOT / 'site/data/data.js').read_text(encoding='utf-8'); g = json.loads(text[text.index('{'):].strip().rstrip(';'))
    spots = np.array([p for s in g['streets'] for p in s['p']]); spots = spots[rng.choice(len(spots), 100, replace=False)]
    spot_ids = [np.flatnonzero(C.disk(*C.cell_of(*p), 150).ravel()) for p in spots]
    ev = list(csv.DictReader(open(ROOT / 'dataset/landslide_events_winter2023.csv')))
    ev += [dict(date='2022-12-31', where='USGS 2023 point ' + r['id'], lon=r['lon'], lat=r['lat']) for r in csv.DictReader(open(ROOT / 'dataset/usgs_landslides_2023.csv'))]
    out = []
    valid = ~np.isnan(D['Xs']).any(1)
    for e in ev:
        _, r72, api = rain.before_report(e['date'])
        s = score_fn(C.with_storm(D['Xs'], r72, api)); s[~valid] = -np.inf
        tgt = np.flatnonzero(C.disk(*C.cell_of(float(e['lon']), float(e['lat'])), 150).ravel())
        best = s[tgt].max(); others = np.array([s[i].max() for i in spot_ids])
        out.append(dict(where=e['where'][:60], date=e['date'], rain_72h_mm=round(r72, 1), api_mm=round(api, 1),
                        beats_street_spots=float(np.mean(others < best) + .5 * np.mean(others == best)),
                        land_percentile=float(np.mean(s[valid] < best))))
    m1 = float(np.mean([o['beats_street_spots'] for o in out])); m2 = float(np.mean([o['land_percentile'] for o in out]))
    log(f'HOLDOUT {label}: mean share of street spots beaten={m1:.3f}, mean land percentile={m2:.3f} over {len(out)} slides')
    return dict(mean_share_street_spots_beaten=m1, mean_land_percentile=m2, events=out)


def png(path, rgb):
    h, w, _ = rgb.shape; raw = b''.join(b'\x00' + rgb[i].astype(np.uint8).tobytes() for i in range(h))
    ch = lambda t, d: struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    Path(path).write_bytes(b'\x89PNG\r\n\x1a\n' + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + ch(b'IDAT', zlib.compress(raw, 9)) + ch(b'IEND', b''))


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--minutes', type=float, default=20); ap.add_argument('--workers', type=int, default=10)
    a = ap.parse_args(); OUT.mkdir(exist_ok=True)
    lf = (OUT / 'search_log.txt').open('a')
    def log(msg):
        line = f'[{time.strftime("%H:%M:%S")}] {msg}'; print(line, flush=True); lf.write(line + '\n'); lf.flush()
    build(); log(f"data: {D['meta']} rows={len(D['y'])} positives={int(D['y'].sum())}")
    deadline = time.time() + a.minutes * 60; rng = np.random.default_rng(11); results = []
    jl = (OUT / 'search_results.jsonl').open('w')
    with mp.get_context('spawn').Pool(a.workers, initializer=build) as pool:
        pending = [pool.apply_async(cv_job, (BASELINE,))]
        pending += [pool.apply_async(cv_job, (sample(rng),)) for _ in range(a.workers * 2 - 1)]
        while pending:
            done = [p for p in pending if p.ready()]
            if not done: time.sleep(0.5); continue
            for p in done:
                pending.remove(p); r = p.get(); results.append(r); jl.write(json.dumps(r) + '\n'); jl.flush()
                best = max(results, key=lambda x: x['cv_auc']); c = r['cfg']
                log(f"#{len(results):3d} cv_auc={r['cv_auc']:.4f} where={r['cv_where']:.3f} when={r['cv_when']:.3f} ({r['seconds']:.0f}s) "
                    f"trees={c['n_trees']} eta={c['eta']} depth={c['max_depth']} leaf={c['min_leaf']} | best {best['cv_auc']:.4f}")
                if time.time() < deadline: pending.append(pool.apply_async(cv_job, (sample(rng),)))
    best = max(results, key=lambda x: x['cv_auc']); base = next(r for r in results if r['cfg'] == BASELINE)
    log(f"search done: {len(results)} configs, best cv_auc={best['cv_auc']:.4f} where={best['cv_where']:.3f} (baseline {base['cv_auc']:.4f}) cfg={best['cfg']}")
    m = make(best['cfg']).fit(D['X'], D['y'], names=NAMES); m.export(str(OUT / 'trees.json'))
    tuned = holdout(m.raw, log, 'tuned USGS model')
    slope = holdout(lambda X: X[:, 0].copy(), log, 'slope alone')
    old_art = json.loads((ROOT / 'local_model/trees.json').read_text())
    old_cols = [0, 3, 4, 5, 7, 8]       # old model: slope, northness, eastness, plan_curv, twi, dist_stream + storm
    old = holdout(lambda X: predict_tree(old_art, np.column_stack([X[:, old_cols], X[:, -3:]])), log, 'old 4-report model')
    # map for the Dec 31 2022 storm
    _, r72, api = D['rain'].before_report('2022-12-31')
    s = m.predict_proba(C.with_storm(D['Xs'], r72, api)) * 100; valid = ~np.isnan(D['Xs']).any(1)
    v = np.clip((s - np.percentile(s[valid], 5)) / (np.percentile(s[valid], 99.5) - np.percentile(s[valid], 5)), 0, 1)
    ramp = np.array([[255, 255, 204], [254, 217, 118], [253, 141, 60], [227, 26, 28], [128, 0, 38]], float)
    t = v * 4; i = np.minimum(t.astype(int), 3); f = (t - i)[:, None]; col = ramp[i] * (1 - f) + ramp[i + 1] * f
    col[~valid] = 200; img = col.reshape(C.H, C.WD, 3).copy()
    for e in csv.DictReader(open(ROOT / 'dataset/landslide_events_winter2023.csv')):
        r0, c0 = C.cell_of(float(e['lon']), float(e['lat'])); img[max(0, r0 - 3):r0 + 4, max(0, c0 - 3):c0 + 4] = [0, 90, 200]
    png(OUT / 'lamorinda_landslide_map_2022-12-31.png', img)
    report = dict(area='Lamorinda (Lafayette, Orinda, Moraga)', hazard='landslide',
                  labels='USGS 2016-17 storm-season inventory (SIM 3503), 1,398 slides in the box; negatives only inside the mapped boundary',
                  status='experimental; uncalibrated ranking scores', data=D['meta'], features=NAMES,
                  excluded=['elevation (memorises areas)', 'distance to road (reporting proxy)', 'NDVI 2023/2026 (after the test slides)'],
                  search_minutes=a.minutes, configs_tried=len(results), best_cfg=best['cfg'],
                  best_cv=dict(auc=best['cv_auc'], where=best['cv_where'], when=best['cv_when']),
                  baseline_cv=dict(auc=base['cv_auc'], where=base['cv_where'], when=base['cv_when']),
                  holdout_winter2023=dict(tuned=tuned, slope_alone=slope, old_4_report_model=old),
                  feature_importance=m.importance(),
                  limitations=['2016-17 slides are undated within the season; storm columns are paired with the six wettest mornings.',
                               'Held-out test is 11 slides placed at street level, so a small, noisy check.',
                               'Slides under tree cover or already repaired by March 2017 can be missing from the inventory.'])
    (OUT / 'report.json').write_text(json.dumps(report, indent=2))
    log('wrote local_model_landslide/trees.json, report.json, lamorinda_landslide_map_2022-12-31.png')


if __name__ == '__main__':
    main()
