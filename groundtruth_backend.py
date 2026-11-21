"""Python inference API and durable prediction history with optional Supabase sync.

Only repository model/data are loaded. Secrets never leave this server except as
headers to the configured Supabase API. Offline writes are retried idempotently.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone

import numpy as np
from local_simulation import predict, street_cells, C
import sys
sys.path.insert(0, str(Path(__file__).resolve().parent/'model'))
from landslide_live import MODEL_DIR, static, TERRAIN

ROOT = Path(__file__).resolve().parent


def load_env(path):
    if not path.exists(): return
    for line in path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line: continue
        key, value = line.split('=', 1)
        if key.strip() in {'SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'SUPABASE_SERVICE_ROLE_KEY'}:
            os.environ.setdefault(key.strip(), value.strip().strip('\"\''))


class SupabaseStore:
    def __init__(self, url, key):
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != 'https' or not parsed.hostname or not parsed.hostname.endswith('.supabase.co') or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
            raise ValueError('SUPABASE_URL must be an HTTPS Supabase project URL.')
        self.url, self.key = url.rstrip('/'), key

    def upsert(self, table, rows, conflict):
        data = json.dumps(rows, allow_nan=False).encode()
        headers = {'apikey': self.key, 'Content-Type': 'application/json',
                   'Prefer': 'resolution=merge-duplicates,return=minimal'}
        if self.key.count('.') == 2: headers['Authorization'] = 'Bearer '+self.key
        request = urllib.request.Request(self.url+'/rest/v1/'+table+'?on_conflict='+conflict,
                                          data=data, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=5): pass
        except urllib.error.HTTPError as exc:
            # Do not expose provider response bodies, URLs with secrets, or headers.
            raise RuntimeError(f'Supabase returned HTTP {exc.code}; check migration and server credentials.') from None
        except OSError:
            raise RuntimeError('Supabase is unreachable; predictions remain queued locally.') from None


class Backend:
    def __init__(self, runtime=None, remote=None):
        self.runtime = Path(runtime) if runtime else ROOT/'runtime'
        self.runtime.mkdir(exist_ok=True)
        self.db = self.runtime/'predictions.sqlite3'
        with self.connect() as db:
            db.execute('create table if not exists runs (id text primary key, payload text not null, synced integer not null default 0)')
        raw = (MODEL_DIR/'trees.json').read_bytes()
        self.model_id = hashlib.sha256(raw).hexdigest()
        self.artifact = json.loads(raw)
        self.report = json.loads((MODEL_DIR/'report.json').read_text())
        text = (ROOT/'site/data/data.js').read_text(encoding='utf-8')
        self.streets = json.loads(text[text.index('{'):].strip().rstrip(';'))['streets']
        self.Xs = static()
        self.cells = {}
        self.cell_lock = threading.Lock()
        load_env(ROOT/'.env')
        url = os.environ.get('SUPABASE_URL', '')
        key = os.environ.get('SUPABASE_SECRET_KEY') or os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
        self.remote = remote if remote is not None else SupabaseStore(url, key) if url and key else None
        self.seeded = False
        self.last_error = None
        self.last_synced = None
        self.stop = threading.Event()
        self.thread = None

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=10)
        try:
            db.execute('pragma busy_timeout=10000')
            with db: yield db
        finally: db.close()

    def status(self):
        with self.connect() as db:
            pending = db.execute('select count(*) from runs where synced=0').fetchone()[0]
        return dict(inference='python', persistence='supabase' if self.remote and self.seeded else 'local',
                    supabase_configured=bool(self.remote), pending_sync=pending,
                    last_error=self.last_error, last_synced=self.last_synced,
                    model_id=self.model_id, calibrated=False)

    def find_streets(self, query):
        q = query.casefold().strip()
        return [dict(id=i, name=s['n'], town=s['t']) for i, s in enumerate(self.streets) if q in s['n'].casefold()][:20]

    def score(self, street_id, rain, api):
        if isinstance(street_id, bool) or not isinstance(street_id, int) or not 0 <= street_id < len(self.streets):
            raise ValueError('street_id must identify a street in the study area.')
        if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in (rain, api)):
            raise ValueError('Rain and wetness must be finite numbers.')
        if not 0 <= rain <= 400 or not 0 <= api <= 280:
            raise ValueError('Rain must be 0–400 mm and wetness 0–280 mm.')
        with self.cell_lock:
            if street_id not in self.cells: self.cells[street_id] = street_cells(self.streets[street_id])
            ids = self.cells[street_id]
        if not len(ids): raise ValueError('Street has no cells in the study grid.')
        def scores(r, a): return predict(self.artifact, C.with_storm(self.Xs[ids], r, a))
        v = scores(rain, api)
        n = min(len(v), max(3, math.ceil(len(v)*.1)))
        top = lambda vs: float(np.sort(vs)[-n:].mean())
        worst = int(ids[np.argmax(v)])
        x = C.with_storm(self.Xs[[worst]], rain, api)
        base = float(predict(self.artifact, x)[0])
        references = []
        # Same references as site/js/local-model.js, by feature name.
        for name, ref in (('terrain slope', dict(slope_deg=5, slope_max_90m=5, northness=0, eastness=0)), ('local relief', dict(relief_150m=5)),
                          ('terrain wetness index', dict(twi=5)), ('distance to a stream', dict(dist_stream_m=500))):
            a = x.copy()
            for col, val in ref.items(): a[0, TERRAIN.index(col)] = val
            references.append((name, a))
        references += [('storm rain', C.with_storm(self.Xs[[worst]], 0, api)),
                       ('antecedent wetness', C.with_storm(self.Xs[[worst]], rain, 0))]
        reasons = sorted([dict(name=name, change=base-float(predict(self.artifact, a)[0])) for name, a in references], key=lambda v: -v['change'])
        s = self.streets[street_id]
        return dict(street_id=street_id, street=s['n'], town=s['t'],
            score=top(v), worst=worst, cells=len(ids), r72=rain, api=api,
            half_rain_score=top(scores(rain*.5, api)), more_rain_score=top(scores(min(400, rain*1.5), api)),
            explanation=reasons, model_id=self.model_id, calibrated=False)

    def save(self, predictions, source, rain, api, scenario_date=None):
        run = dict(id=str(uuid.uuid4()), model_id=self.model_id, source=source,
            scenario_date=scenario_date, rain_72h_mm=rain, api_mm=api, calibrated=False,
            created_at=datetime.now(timezone.utc).isoformat())
        payload = dict(run=run, predictions=predictions)
        with self.connect() as db:
            db.execute('insert into runs(id,payload) values (?,?)', (run['id'], json.dumps(payload, allow_nan=False)))
        return run

    def history(self, street_id=None, limit=20):
        limit = min(100, max(1, int(limit)))
        with self.connect() as db:
            if street_id is None:
                rows = db.execute('select payload from runs order by rowid desc limit ?', (limit,)).fetchall()
            else:
                rows = db.execute('select payload from runs where exists (select 1 from json_each(json_extract(payload,\'$.predictions\')) p where json_extract(p.value,\'$.street_id\')=?) order by rowid desc limit ?', (street_id, limit)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def sync_once(self):
        if not self.remote: return
        try:
            if not self.seeded:
                self.remote.upsert('gt_model_versions', [dict(id=self.model_id, report=self.report)], 'id')
                for i in range(0, len(self.streets), 200):
                    self.remote.upsert('gt_streets', [dict(id=k, name=s['n'], town=s['t'], geometry=s['p']) for k, s in enumerate(self.streets[i:i+200], i)], 'id')
                self.seeded = True
            with self.connect() as db:
                rows = db.execute('select id,payload from runs where synced=0 order by rowid limit 50').fetchall()
            for run_id, raw in rows:
                item = json.loads(raw)
                self.remote.upsert('gt_prediction_runs', [item['run']], 'id')
                self.remote.upsert('gt_predictions', [dict(run_id=run_id, street_id=p['street_id'], score=p['score'], details=p) for p in item['predictions']], 'run_id,street_id')
                with self.connect() as db: db.execute('update runs set synced=1 where id=?', (run_id,))
            self.last_error = None
            self.last_synced = datetime.now(timezone.utc).isoformat()
        except RuntimeError as exc: self.last_error = str(exc)

    def start(self, simulation):
        def worker():
            previous = None
            while not self.stop.is_set():
                snapshot = simulation.snapshot()
                if snapshot['step'] != previous:
                    predictions = []
                    for row in snapshot['streets']:
                        k = next(i for i,s in enumerate(self.streets) if s['n']==row['street'] and s['t']==row['town'])
                        predictions.append(dict(street_id=k, street=row['street'], town=row['town'], score=row['score']))
                    self.save(predictions, 'simulation', snapshot['rain_72h_mm'], snapshot['api_mm'], snapshot['simulation_date'])
                    previous = snapshot['step']
                self.sync_once()
                self.stop.wait(5)
        self.thread = threading.Thread(target=worker, name='groundtruth-history', daemon=True)
        self.thread.start()

    def close(self):
        self.stop.set()
        if self.thread: self.thread.join(timeout=2)
