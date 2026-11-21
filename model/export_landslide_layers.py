"""Precompute the Lamorinda landslide model's map for every storm the site can set.

The trees only split the storm columns at a few thresholds (rain_72h_mm, api_mm, trigger_T), so the score of every
cell is constant inside each storm region those thresholds cut out. There are about 50 such regions over the
site's range (rain 0 to 400 mm, wetness 0 to 280 mm). This script scores every cell once per region and packs the
scores (0 to 100, stored as 0 to 255) three regions per RGB image, stacked into one PNG: site/data/landslide_layers.js.
The map, the stat chips and the backtest read the layer for the storm's region, so they show the model exactly
(to 0.4 score points). Ask still runs the trees directly.

Usage: python3 model/export_landslide_layers.py   (after model/export_landslide_site.py)
"""
import base64, io, json, sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model')); sys.path.insert(0, str(ROOT))
import handoff_common as C
from landslide_live import MODEL_DIR, TERRAIN, static

art = json.loads((MODEL_DIR / 'trees.json').read_text())
SC = len(TERRAIN); RI, AI, TI = SC, SC + 1, SC + 2


def raw(trees, X):
    s = np.zeros(len(X))
    for t in trees:
        f, th, nl, l, r, v = (np.array(t[k]) for k in ('feature', 'threshold', 'nan_left', 'left', 'right', 'value'))
        node = np.zeros(len(X), int); act = np.arange(len(X))
        while len(act):
            nd = node[act]; leaf = f[nd] < 0
            s[act[leaf]] += art['eta'] * v[nd[leaf]]; act = act[~leaf]
            if not len(act): break
            nd = node[act]; x = X[act, f[nd]]
            node[act] = np.where(np.where(np.isnan(x), nl[nd], x <= th[nd]), l[nd], r[nd])
    return s


cuts = {k: sorted({float(th) for t in art['trees'] for f, th in zip(t['feature'], t['threshold']) if f == i}) for k, i in (('r72', RI), ('api', AI), ('T', TI))}
trig = lambda r, a: .55 * min(1.5, r / 200) + .45 * min(1.3, a / 200)
side = lambda x, cs: sum(x > c for c in cs)          # trees go left when x <= threshold
regions = {}
for r in sorted(set(np.linspace(0, 400, 801)) | {c for c in cuts['r72']} | {np.nextafter(c, 1e9) for c in cuts['r72']}):
    for a in sorted(set(np.linspace(0, 280, 561)) | {c for c in cuts['api']} | {np.nextafter(c, 1e9) for c in cuts['api']}):
        if not (0 <= r <= 400 and 0 <= a <= 280): continue
        k = f"{side(r, cuts['r72'])},{side(a, cuts['api'])},{side(trig(r, a), cuts['T'])}"
        regions.setdefault(k, (float(r), float(a)))
keys = sorted(regions)
Xs = static().astype(float)
storm_trees = [t for t in art['trees'] if any(f >= SC for f in t['feature'])]
base = art['f0'] + raw([t for t in art['trees'] if all(f < SC for f in t['feature'])], np.column_stack([Xs, np.zeros((len(Xs), 3))]))
layers = []
for n, k in enumerate(keys):
    r, a = regions[k]
    z = base + raw(storm_trees, C.with_storm(Xs, r, a))
    layers.append(np.round(100 / (1 + np.exp(-np.clip(z, -35, 35))) * 2.55).astype(np.uint8))
    print(n + 1, '/', len(keys), k, r, a, end='\r', flush=True)
while len(layers) % 3: layers.append(np.zeros_like(layers[0]))
H, W = C.H, C.WD
frames = [np.stack([layers[i + j].reshape(H, W) for j in range(3)], -1) for i in range(0, len(layers), 3)]
buf = io.BytesIO(); Image.fromarray(np.concatenate(frames, 0), 'RGB').save(buf, 'PNG', optimize=True)
# spot check: the packed layers reproduce the trees
from local_simulation import predict
rng = np.random.default_rng(1)
for _ in range(5):
    r, a = rng.uniform(0, 400), rng.uniform(0, 280); k = f"{side(r, cuts['r72'])},{side(a, cuts['api'])},{side(trig(r, a), cuts['T'])}"
    ids = rng.choice(len(Xs), 2000, replace=False)
    err = np.abs(layers[keys.index(k)][ids] / 2.55 - predict(art, C.with_storm(Xs[ids], r, a))).max()
    assert err <= 0.2 + 1e-9, (k, err)
meta = dict(cuts=cuts, keys=keys, nx=W, ny=H, png='data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode(),
            model='local_model_landslide', scale=2.55)
(ROOT / 'site/data/landslide_layers.js').write_text('window.GT_LS_LAYERS=' + json.dumps(meta, separators=(',', ':')) + ';\n')
print('\nwrote site/data/landslide_layers.js:', len(keys), 'storm regions,', round(len(buf.getvalue()) / 1e6, 2), 'MB PNG')
