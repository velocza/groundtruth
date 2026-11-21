"""Reproducible local experimental ranker. No downloaded data or ML libraries.

Uses the four supplied pre-2022 news reports (three approximate locations).
Outputs classification scores, NOT calibrated landslide probabilities.
Future observed rain is used only as a labeled perfect-rain scenario experiment.
"""
import base64
import csv
import json
import hashlib
import subprocess
from pathlib import Path
import numpy as np
from gbm import GroundTruthGBM, auc
import handoff_common as C

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'local_model'
NAMES = ['slope_deg', 'northness', 'eastness', 'plan_curv', 'twi', 'dist_stream_m']
PARAMS = dict(n_trees=60, max_depth=2, eta=0.05, min_leaf=25,
              subsample=1.0, colsample=1.0, lam=5.0, max_bins=32)

INPUTS = ['dataset/grid_480x456_all_layers.npz',
          'dataset/landslide_events_other_winters.csv',
          'dataset/rainfall_daily_lamorinda.csv', 'site/data/data.js']

def provenance():
    """Verify repository inputs, or the manifest in a portable copy. No downloads."""
    hashes = {p: hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in INPUTS}
    if (ROOT/'.git').exists():
        def git(*args):
            return subprocess.check_output(['git', *args], cwd=ROOT, text=True).strip()
        blobs = {}
        for path in INPUTS:
            expected = git('rev-parse', 'HEAD:'+path)
            original = subprocess.check_output(['git', 'show', 'HEAD:'+path], cwd=ROOT)
            current = (ROOT/path).read_bytes()
            if path.endswith(('.csv', '.js')):
                original = original.replace(b'\r\n', b'\n')
                current = current.replace(b'\r\n', b'\n')
            if current != original:
                raise RuntimeError('Repository input has local modifications: '+path)
            blobs[path] = expected
        result = dict(repository='https://github.com/velocza/groundtruth',
                      source_commit=git('rev-parse', 'HEAD'), git_blobs=blobs,
                      sha256=hashes, external_downloads=False)
    else:
        manifest = OUT/'input_manifest.json'
        if not manifest.exists():
            raise RuntimeError('First training must run in the repository checkout to verify inputs.')
        result = json.loads(manifest.read_text())
        if hashes != result['sha256']:
            raise RuntimeError('Input hashes do not match the repository-only manifest.')
    (OUT/'input_manifest.json').write_text(json.dumps(result, indent=2))
    return result

def static():
    z = np.load(ROOT / 'dataset/grid_480x456_all_layers.npz')
    a, s = np.deg2rad(z['aspect']), np.deg2rad(z['slope'])
    return np.stack([z['slope'], np.cos(a)*np.sin(s), np.sin(a)*np.sin(s),
                     z['plan_curv'], z['twi'], z['dist_stream']], -1).reshape(-1, 6).astype('<f4')

def main():
    OUT.mkdir(exist_ok=True)
    inputs = provenance()
    text = (ROOT / 'site/data/data.js').read_text(encoding='utf-8')
    g = json.loads(text[text.index('{'):].strip().rstrip(';'))
    streets = {s['n']: s for s in g['streets']}
    labels = []
    for item in csv.DictReader((ROOT / 'dataset/landslide_events_other_winters.csv').open()):
        name = item['where']
        if name == 'Canyon Road bridge':
            # Approximate landmark: Canyon point nearest the supplied Augusta geometry.
            p = np.array(streets['Canyon Road']['p'])
            q = np.array(streets['Augusta Drive']['p'])
            delta = (p[:, None] - q[None]) * [87800, 110950]
            lo, la = p[np.argmin(np.min(np.sum(delta**2, axis=2), axis=1))]
        else:
            p = np.array(streets[name]['p']); lo, la = np.median(p, axis=0)
        labels.append(dict(date=item['date'], lon=float(lo), lat=float(la),
                           radius_m=150, source=item['source'], location=name,
                           precision='approximate street geometry; not a mapped source'))
    with (OUT / 'labels.csv').open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(labels[0])); w.writeheader(); w.writerows(labels)
    assert all(x['date'] < '2022-10-01' for x in labels)
    Xs, rain, rng = static(), C.Rain(), np.random.default_rng(42)
    z = np.load(ROOT / 'dataset/grid_480x456_all_layers.npz')
    masks = [C.disk(*C.cell_of(x['lon'], x['lat']), x['radius_m']).ravel() for x in labels]
    near = np.logical_or.reduce([C.disk(*C.cell_of(x['lon'], x['lat']), 450).ravel() for x in labels])
    pool = np.flatnonzero((z['dist_road'].ravel() < 150) & ~near)
    # All negative days and their following 72 hours must finish before holdout.
    days = np.array([i for i in range(rain.n) if rain.dates[i+3] < '2022-10-01'])
    dry = days[np.array([rain.storm_at(int(i))[0] < 5 for i in days])]
    xs, ys, cells = [], [], []
    for label, mask in zip(labels, masks):
        pos = np.flatnonzero(mask)
        for day in range(rain.idx[label['date']] - 3, rain.idx[label['date']]):
            r, a = rain.storm_at(day)
            neg = rng.choice(pool, len(pos)*8, replace=True)
            ids = np.r_[pos, neg]
            xs.append(C.with_storm(Xs[ids], r, a)); ys.append(np.r_[np.ones(len(pos)), np.zeros(len(neg))]); cells.append(ids)
        ids = rng.choice(pos, len(pos)*3, replace=True)
        ds = rng.choice(dry[np.abs(dry-rain.idx[label['date']]) > 30], len(ids))
        storms = np.array([rain.storm_at(int(d)) for d in ds])
        xs.append(C.with_storm(Xs[ids], storms[:, 0], storms[:, 1])); ys.append(np.zeros(len(ids))); cells.append(ids)
    X, y, ids = np.vstack(xs), np.concatenate(ys), np.concatenate(cells)
    names = NAMES + C.STORM_NAMES
    weights = np.where(y == 1, 4.0, 1.0)
    folds = []
    # Hold out each unique location and remove all training cells within 1.2 km.
    for location in sorted(set(l['location'] for l in labels)):
        label = next(l for l in labels if l['location'] == location)
        rc = C.cell_of(label['lon'], label['lat'])
        va = C.disk(*rc, 180).ravel()[ids]
        tr = ~C.disk(*rc, 1200).ravel()[ids]
        if len(np.unique(y[tr])) < 2 or len(np.unique(y[va])) < 2: continue
        m = GroundTruthGBM(seed=42, **PARAMS).fit(X[tr], y[tr], weights[tr], names=names)
        folds.append(dict(location=location, roc_auc=auc(y[va], m.raw(X[va])),
                          slope_roc_auc=auc(y[va], X[va, 0]), train_rows=int(tr.sum()), test_rows=int(va.sum())))
    m = GroundTruthGBM(seed=42, **PARAMS).fit(X, y, weights, names=names)
    m.export(str(OUT / 'trees.json'))
    # Fixed random street spots; max over the same radius as each held-out event.
    spots = np.array([p for s in g['streets'] for p in s['p']])
    spots = spots[rng.choice(len(spots), 100, replace=False)]
    spot_ids = [np.flatnonzero(C.disk(*C.cell_of(*p), 300).ravel()) for p in spots]
    tests = []
    for ev in g['events']:
        _, r, a = rain.before_report(ev['date'])
        raw = m.raw(C.with_storm(Xs, r, a))
        target = np.flatnonzero(C.disk(*C.cell_of(*ev['lonlat']), 300).ravel())
        best = float(raw[target].max())
        others = np.array([raw[ix].max() for ix in spot_ids])
        tests.append(dict(location=ev['where'], date=ev['date'], share_random_street_spots_beaten=float(np.mean(others < best)+0.5*np.mean(others == best))))
    report = dict(status='experimental; uncalibrated; insufficient labels for real-world decisions',
        holdout_from='2022-10-01', training_events=len(labels), unique_training_locations=3,
        rows=len(y), positive_rows=int(y.sum()), params=PARAMS, features=names,
        inputs='real terrain and observed gauge rainfall; no simulated motion or post-event vegetation',
        rainfall_mode='perfect-rain scenario; not an archived-forecast evaluation',
        provenance=inputs, cv=folds, heldout_2023=tests,
        heldout_mean_share_random_street_spots_beaten=float(np.mean([t['share_random_street_spots_beaten'] for t in tests])),
        limitations=['Four weak reports at three approximate locations; two events share Canyon Road.',
                    'Background negatives are unlabeled, not confirmed absence.',
                    '0-100 classification score is not a calibrated probability or validated alert tier.',
                    'Terrain is treated as static; historical terrain changes are not reconstructed.',
                    '2023 reports were excluded from training; this is a small exploratory test, not validation.'])
    (OUT / 'report.json').write_text(json.dumps(report, indent=2))
    artifact = json.loads((OUT / 'trees.json').read_text())
    artifact['report'] = report
    artifact['static_f32_base64'] = base64.b64encode(Xs.tobytes()).decode()
    artifact['static_count'] = len(NAMES)
    (ROOT / 'site/data/local-model.js').write_text('window.GT_LOCAL_ARTIFACT = '+json.dumps(artifact, separators=(',', ':'))+';\n')
    sample = rng.choice(len(X), 32, replace=False)
    (OUT / 'parity.json').write_text(json.dumps(dict(X=X[sample].tolist(), scores=(m.predict_proba(X[sample])*100).tolist())))
    print(json.dumps({k: report[k] for k in ['training_events', 'rows', 'cv', 'heldout_mean_share_random_street_spots_beaten']}, indent=2))

if __name__ == '__main__': main()
