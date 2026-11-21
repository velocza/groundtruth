"""The Lamorinda landslide model the site and the local server use (local_model_landslide, trained by
model/train_lamorinda_landslide.py on the USGS 2016-17 inventory). One place for its folder and its
terrain columns, so the browser artifact, the Python backend and the playback all score the same way."""
from pathlib import Path
import numpy as np
import handoff_common as C

ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = ROOT / 'local_model_landslide'
TERRAIN = ['slope_deg', 'slope_max_90m', 'relief_150m', 'northness', 'eastness', 'plan_curv', 'prof_curv', 'twi', 'dist_stream_m']


def static():
    """Per-cell terrain columns in the model's order, float32 like the browser artifact."""
    X, names = C.static_features()
    return X[:, [names.index(n) for n in TERRAIN]].astype('<f4')
