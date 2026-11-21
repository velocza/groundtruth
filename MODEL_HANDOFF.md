# Model handoff: how to build it and how to send it back

For the two people training the model. The plan document explains the math. This page is the contract: what
goes in, what comes out, how to check it, and how it gets back onto the site.

## The short version

1. Unzip the package. Work in `model/`. Python 3.10 or later with NumPy is all you need.
2. Make a labels file (step 2 below). This is most of the real work.
3. Run `python3 train_template.py --labels my_labels.csv`.
4. Run `python3 check_submission.py submission/predictions.npz`.
5. Send back the `submission/` folder, your labels file and any script you changed.

Try the pipeline first with `python3 train_template.py --demo`. It takes about five minutes and trains on the ten
reported slides only to prove the files flow. Its scores are inflated and the checker says so.

## Files

| File | Who edits it | What it is |
|---|---|---|
| `model/gbm.py` | model team, if you improve the algorithm | The gradient boosting model, written by hand in NumPy. `python3 gbm.py` runs its tests. |
| `model/handoff_common.py` | model team, to add features | The grid, the feature table, the rain record and the output format. One place for every shared definition. |
| `model/train_template.py` | model team | Builds rows, cross-validates, trains, calibrates, writes the submission. Two TODO blocks. |
| `model/check_submission.py` | nobody | Checks the format and scores the result against the real slides. |
| `model/real_label_experiment.py` | nobody | The first trial on ten real labels. It came out at chance. Read it as a warning about small label sets. |

## Step 1. Inputs: the feature table

One row is one 29 m cell on one morning. `handoff_common.static_features()` builds the per-cell part from
`dataset/grid_480x456_all_layers.npz` and `with_storm()` adds the storm.

| Feature | Meaning | Source |
|---|---|---|
| `slope_deg` | slope of the cell | real, USGS 3DEP |
| `slope_max_90m` | steepest slope within one cell | real |
| `relief_150m` | highest minus lowest ground within 150 m | real |
| `northness`, `eastness` | which way the slope faces, scaled by steepness | real |
| `plan_curv`, `prof_curv` | curvature across and down the slope | real |
| `twi` | topographic wetness index | real |
| `dist_stream_m` | distance to the nearest drainage line | real |
| `ndvi_2023`, `ndvi_change` | greenness in April 2023 and its change to November 2026 | real, Sentinel-2 |
| `insar_v_long`, `insar_v_recent`, `insar_accel`, `insar_coherence` | ground speed from radar | **yours to add**, see below |
| `rain_72h_mm` | rain in the 72 hours after that morning | real, NOAA gauges |
| `api_mm` | soil wetness index that morning | real, NOAA gauges |
| `trigger_T` | the site's rain trigger, which already times slides well | derived |

Elevation and distance to road are left out on purpose. Elevation lets the model memorise neighbourhoods, and
slides only get reported near roads.

**Real InSAR.** The grid file holds only simulated motion (`SIM_` layers). Do not train on it. When you have the
real OPERA DISP-S1 data, resample it to this grid and save `insar_grid.npz` with three arrays shaped `(456, 480)`:
`v_long` (mm per year, long-term), `v_recent` (mm per year, last 12 months) and `coherence` (0 to 1). Use NaN where
there is no reading. Then pass `--insar insar_grid.npz`. Row 0 is the north edge, column 0 is the west edge, and
the box is west -122.215, east -122.055, south 37.805, north 37.925.

To add any other feature, add one line to the `f = {...}` dictionary in `static_features()`. Nothing else changes.

## Step 2. Labels

A CSV with one row per mapped slide:

```
date,lon,lat,radius_m,source
2017-02-07,-122.1712,37.8914,60,state inventory
```

- `date`, `lon`, `lat` are required. `radius_m` is how far the label spreads (default 150 m; use 30 to 60 m when the
  position is a mapped source area and not a street name). `source` is for your own records.
- Slides before 2022-10-01 are for training. Slides from 2022-10-01 on are the test and are never trained on.
  The script enforces this.
- Sources: the USGS January 2023 reconnaissance inventory (doi 10.5066/P9NJ3KMG) for the test winter, and the
  California Geological Survey landslide inventory plus older USGS Bay Area maps for training.
- Aim for hundreds of training slides. Ten trained to chance.

## Step 3. Output: what the site reads

`submission/predictions.npz`, written by the template:

| Array | Shape and type | Meaning |
|---|---|---|
| `p` | `(8, 6, 456, 480)`, float16 or float32, values 0 to 1 | probability of a slide in the next 72 hours, for each rain level, each soil wetness level, each row (north to south), each column (west to east) |
| `r72_levels` | `[0, 25, 50, 75, 100, 150, 200, 300]` | the rain levels, mm in 72 hours |
| `api_levels` | `[0, 50, 100, 150, 200, 280]` | the soil wetness levels, mm |
| `feature_names` | strings | the columns you trained on |
| `meta` | JSON string | run details: holdout date, parameters, cross-validation scores |

Why a lookup and not the trees: the site redraws 218,880 cells every time someone drags the rain slider, on a
phone. It cannot run hundreds of trees per cell per frame, but it can blend between 48 precomputed maps.
`trees.json` is still wanted, for the per-street explanations.

If you swap in a different model (a neural net, a library), that is fine. Only this output file has to match.

## Step 4. Check it

`python3 check_submission.py submission/predictions.npz` prints:

- PASS or FAIL for the format. Any FAIL means the site cannot load it.
- A warning if more rain lowers the average probability.
- The score against the dated slides, done the same way as the site's backtest, with the numbers to beat:

| | Beats a random street spot | Slides caught at 2.6% / 7.6% / 17% of the map flagged |
|---|---|---|
| Slope alone | 5.8 in 10 | 3 / 3 / 10 of 10 |
| Placeholder on the site (real inputs) | 6.6 in 10 | 2 / 3 / 8 of 10, at its own 1.6% / 5.2% / 13% |
| Your model | ? | ? |

Storms before a slide count only rain logged up to the report date (`Rain.storm_before`), for training labels and
for scoring alike. The checker also scores the four slides from other winters as a separate line.

The honest test is the winter 2023 slides with a model that never saw them. Report that number, whatever it is.

## Step 5. Send it back

Either way works:

- **Upload to the project chat**: `predictions.npz` (about 11 MB), `trees.json`, `report.json`, your labels CSV and
  any script you changed. Say which run it is.
- **GitHub**: put the `model/` folder and the `submission/` folder in a repository and share the link in the project
  chat. Better if you expect several rounds.

On arrival the file gets checked again, converted to the site's map format, and swapped in for the placeholder.
The backtest, the alert-days table and the plan document are then rerun with the trained model's numbers.

## Rules that keep the result honest

1. Never train on anything dated 2022-10-01 or later.
2. Never report a score from a run that used `--demo` or `--sim-motion`.
3. Keep the spatial cross-validation (1.2 km blocks). Random splits leak, because neighbouring cells look alike.
4. Do not tune on the ten test slides. Pick settings on the cross-validation score, then run the test once.
5. If the model does not beat slope alone, say so. That is a result too.
