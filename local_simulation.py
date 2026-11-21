"""Offline inference playback: one winter-2023 day per ten seconds. No downloads."""
import json
import math
import sys
import threading
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT/'model'))
import handoff_common as C
from landslide_live import MODEL_DIR, static


def predict(artifact, X):
    score = np.full(len(X), artifact['f0'], dtype=float)
    for tree in artifact['trees']:
        node = np.zeros(len(X), dtype=int)
        active = np.arange(len(X))
        f, threshold = np.array(tree['feature']), np.array(tree['threshold'])
        left, right = np.array(tree['left']), np.array(tree['right'])
        value, nan_left = np.array(tree['value']), np.array(tree['nan_left'])
        while len(active):
            nd = node[active]
            leaf = f[nd] < 0
            score[active[leaf]] += artifact['eta']*value[nd[leaf]]
            active = active[~leaf]
            if not len(active): break
            nd = node[active]
            v = X[active, f[nd]]
            go_left = np.where(np.isnan(v), nan_left[nd], v <= threshold[nd])
            node[active] = np.where(go_left, left[nd], right[nd])
    return 100/(1+np.exp(-np.clip(score, -35, 35)))


def street_cells(street):
    cells = set()
    for lon, lat in street['p']:
        c = math.floor((lon-C.W)/(C.E-C.W)*C.WD)
        r = math.floor((C.N-lat)/(C.N-C.S)*C.H)
        if not (0 <= r < C.H and 0 <= c < C.WD): continue
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                rr, cc = r+dr, c+dc
                if dr*dr+dc*dc <= 5 and 0 <= rr < C.H and 0 <= cc < C.WD:
                    cells.add(rr*C.WD+cc)
    return np.array(sorted(cells), dtype=int)


class Simulation:
    def __init__(self, interval=10, runtime=None):
        self.interval = interval
        self.runtime = Path(runtime) if runtime else ROOT/'runtime'
        self.runtime.mkdir(exist_ok=True)
        self.artifact = json.loads((MODEL_DIR/'trees.json').read_text())
        self.Xs, self.rain = static(), C.Rain()
        text = (ROOT/'site/data/data.js').read_text(encoding='utf-8')
        g = json.loads(text[text.index('{'):].strip().rstrip(';'))
        names = {'Miner Road', 'El Toyonal', 'Rheem Boulevard'}
        self.streets = [(s, street_cells(s)) for s in g['streets'] if s['n'] in names]
        self.days = [i for i in range(self.rain.n) if '2022-12-26' <= self.rain.dates[i] <= '2023-03-31']
        self.position = 0
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.paused = False
        self.status = {}
        self.thread = None
        self.step()

    def step(self):
        with self.lock:
            day = self.days[self.position % len(self.days)]
            r72, api = self.rain.storm_at(day)
            scores = []
            for street, ids in self.streets:
                v = np.sort(predict(self.artifact, C.with_storm(self.Xs[ids], r72, api)))
                n = min(len(v), max(3, math.ceil(len(v)*.1)))
                scores.append(dict(street=street['n'], town=street['t'], score=float(v[-n:].mean())))
            self.position += 1
            self.status = dict(running=not self.paused, mode='offline historical simulation',
                simulation_date=self.rain.dates[day], rain_72h_mm=r72, api_mm=api,
                step=self.position, interval_seconds=self.interval, streets=scores,
                updated_utc=datetime.now(timezone.utc).isoformat(),
                forecast=False, calibrated=False, training=False,
                note='Observed future gauge rain is a scenario input, not a live forecast. Scores are uncalibrated.')
            self._persist()
            return dict(self.status)

    def _persist(self):
        temp = self.runtime/'simulation.tmp'
        temp.write_text(json.dumps(self.status, indent=2))
        temp.replace(self.runtime/'simulation.json')

    def snapshot(self):
        with self.lock: return dict(self.status)

    def set_paused(self, paused):
        with self.lock:
            self.paused = bool(paused)
            self.status['running'] = not self.paused
            self._persist()
            return dict(self.status)

    def start(self):
        if self.thread and self.thread.is_alive(): return
        def run():
            while not self.stop_event.wait(self.interval):
                if not self.paused: self.step()
        self.thread = threading.Thread(target=run, name='groundtruth-simulation', daemon=True)
        self.thread.start()

    def close(self):
        self.stop_event.set()
        if self.thread: self.thread.join(timeout=2)
