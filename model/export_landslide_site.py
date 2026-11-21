"""Write site/data/local-model.js from the trained Lamorinda landslide model, plus a Python/JS parity fixture.

Usage: python3 model/export_landslide_site.py   (after model/train_lamorinda_landslide.py)
"""
import base64, json, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model')); sys.path.insert(0, str(ROOT))
import handoff_common as C
from landslide_live import MODEL_DIR, TERRAIN, static
from local_simulation import predict

art = json.loads((MODEL_DIR / 'trees.json').read_text())
report = json.loads((MODEL_DIR / 'report.json').read_text())
assert art['features'] == TERRAIN + C.STORM_NAMES, art['features']
Xs = static()
art['report'] = report
art['static_f32_base64'] = base64.b64encode(Xs.tobytes()).decode()
art['static_count'] = len(TERRAIN)
(ROOT / 'site/data/local-model.js').write_text('window.GT_LOCAL_ARTIFACT = ' + json.dumps(art, separators=(',', ':')) + ';\n')
rng = np.random.default_rng(7)
ids = rng.choice(np.flatnonzero(~np.isnan(Xs).any(1)), 32, replace=False)
storms = rng.uniform([0, 0], [300, 280], (32, 2))
X = C.with_storm(Xs[ids].astype(float), storms[:, 0], storms[:, 1])
(MODEL_DIR / 'parity.json').write_text(json.dumps(dict(cells=ids.tolist(), X=X.tolist(), scores=predict(art, X).tolist())))
print('wrote site/data/local-model.js', len(art['trees']), 'trees,', Xs.shape)
