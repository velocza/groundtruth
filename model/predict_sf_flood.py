"""Score every San Francisco street with the trained SF flood model for a given storm.

Street score = mean of the top 10% cell scores within 150 m of the street centroid (same top-10% rule as Lamorinda).
Usage: python3 model/predict_sf_flood.py [--date 2026-11-18 | --morning YYYY-MM-DD]
"""
import argparse, csv, gzip, json, math, sys
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT)); sys.path.insert(0, str(ROOT / 'model'))
from local_simulation import predict
import handoff_common_sf as C

OUT = ROOT / 'local_model_sf'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--morning', help='storm morning (rain in the following 72 h is used)')
    ap.add_argument('--date', default='2026-11-18', help='flood day; uses its storm morning from flood_days')
    args = ap.parse_args()
    art = json.loads((OUT / 'trees.json').read_text())
    fs = art['features']
    rain = C.Rain()
    if args.morning:
        morning = args.morning; r72, api = rain.storm_at(rain.idx[morning])
    else:
        days = {r['date']: r for r in csv.DictReader(gzip.open(ROOT / 'dataset_sf/training/flood_days.csv.gz', 'rt'))}
        d = days[args.date]; morning = d['storm_morning']; r72, api = float(d['storm_rain_72h_mm']), float(d['storm_api_mm'])
    T = float(C.trigger_T(r72, api))
    storm = {'rain_72h_mm': r72, 'api_mm': api, 'trigger_T': T}
    rows = list(csv.DictReader(gzip.open(ROOT / 'dataset_sf/training/cells.csv.gz', 'rt')))
    num = lambda v: float(v) if v not in ('', None) else np.nan
    X = np.array([[storm[c] if c in storm else num(r[c]) for c in fs] for r in rows])
    land = np.array([r['is_land'] in ('1', '1.0', 'True') for r in rows])
    s = predict(art, X)
    s[~land] = np.nan
    grid = np.full((C.H, C.WD), np.nan)
    grid[[int(r['row']) for r in rows], [int(r['col']) for r in rows]] = s
    out = []
    for st in csv.DictReader(open(ROOT / 'dataset_sf/streets_san_francisco.csv')):
        r0, c0 = C.cell_of(float(st['centroid_lon']), float(st['centroid_lat']))
        if not (0 <= r0 < C.H and 0 <= c0 < C.WD): continue
        v = grid[C.disk(r0, c0, 150)]; v = np.sort(v[~np.isnan(v)])
        if not len(v): continue
        n = min(len(v), max(3, math.ceil(len(v) * .1)))
        out.append(dict(street=st['street'], neighbourhood=st['town'], score=round(float(v[-n:].mean()), 2), cells=len(v)))
    out.sort(key=lambda p: -p['score'])
    tag = args.morning or args.date
    path = OUT / f'predictions_sf_streets_{tag}.csv'
    with path.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
    hoods = {}
    for p in out: hoods.setdefault(p['neighbourhood'], []).append(p['score'])
    hoods = sorted(((h, float(np.mean(v)), len(v)) for h, v in hoods.items() if len(v) >= 5), key=lambda t: -t[1])
    print(f'SF flood predictions, storm morning {morning}: rain72={r72:.1f} mm api={api:.1f} mm, {len(out)} streets -> {path.name}')
    print('Top streets:'); [print(f"  {p['score']:5.1f}  {p['street']} ({p['neighbourhood']})") for p in out[:15]]
    print('Top neighbourhoods (mean street score, >=5 streets):'); [print(f'  {m:5.1f}  {h} ({n} streets)') for h, m, n in hoods[:10]]
    print('Scores are uncalibrated rankings, not probabilities.')


if __name__ == '__main__':
    main()
