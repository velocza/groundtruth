# GroundTruth sample dataset

Box: 122.215 W to 122.055 W, 37.805 N to 37.925 N (about 14.1 by 13.3 km). Grid: 480 by 456 cells of about 29 m.
Two snapshots: winter 2022 to 2023 for backtesting, and autumn 2026 for the current view.

| File | Rows | Source | Real? |
|---|---|---|---|
| `rainfall_daily_lamorinda.csv` | one per day, 2015-10-01 to 2026-11-14 | NOAA GHCN-Daily, mean of 6 CoCoRaHS gauges (US1CACC0010, 0025, 0031, 0006, 0004, US1CAAL0001), with 3, 7, 30 day sums and an antecedent index (decay 0.92 per day) | real |
| `landslide_events_winter2023.csv` | 10 | Lamorinda Weekly, Patch and city reports, placed on the named street with Overture geometry | real, street-level accuracy only |
| `streets_lamorinda.csv` | 1,625 named streets | Overture Maps release 2026-11-18.0 | real |
| `cells_sample_20k.csv` | 20,000 random cells with every feature | derived from the layers below | real, except `SIM_` columns |
| `grid_480x456_all_layers.npz` | every layer, full grid | same | real, except `SIM_` arrays |
| `layer_height.png`, `layer_terrain.png`, `layer_hydro.png`, `layer_cover.png` | image-packed layers the site reads | elevation, slope, aspect, curvature, wetness index, distance to stream and road, NDVI 2023 and 2026 | real |
| `layer_motion.png` | image-packed line-of-sight speed, 3 periods | simulated | SIMULATED |
| `buildings_lamorinda.csv` | 41,494 building centroids with footprint area | Overture Maps release 2026-11-18.0, buildings theme | real |
| `layer_buildings.png` | buildings per grid cell, red channel | same | real |
| `SIM_insar_timeseries_points.csv` | 52 points, 12-day steps from 2016-07-04 | simulated: 46 creeping patches that speed up with the real wetness index, plus 6 stable points and noise | SIMULATED |
| `sentinel2_truecolor_2023.jpg`, `sentinel2_truecolor_2026.jpg` | true color | Sentinel-2 L2A tile 10SEG, 2023-04-19 and 2026-11-04, AWS open data | real |

Winter 2023 facts from the gauges: water year 2023 total 1,117 mm, wetness index peak 264 mm on 2023-01-16. Water year 2026 total 626 mm.

## Why ground motion is simulated

OPERA DISP-S1 is served from NASA Earthdata, which needs a login and was not reachable from the build machine. The simulation keeps the same shape as the real product (line-of-sight displacement in mm, 12-day steps, coherence) so the real stack drops into the same columns. Nothing in a `SIM_` column says anything about a real hillside.

## Rebuild

`python3 scripts/01_fetch_real.py work`, `02_fetch_roads.py work`, `03_build.py work site dataset`, `05_rain_history.py`, `06_fetch_buildings.py work`, `07_build_buildings.py`, then `04_wrap.py site`. Needs numpy, scipy, rasterio, pillow, pyarrow.

## Backtest result on this sample (placeholder score)

Ten reported slides, best score within 300 m in the three days before each report, gauge rain as a perfect forecast:

| Alert sensitivity | Slides caught | Map flagged | Buildings flagged at the January peak | Alert days in 12 winters | Of those, winter 2023 |
|---|---|---|---|---|---|
| Fewer alerts | 2 of 10 | 2.6% | 191 | 3 | 3 |
| Balanced | 3 of 10 | 7.6% | 880 | 26 | 20 |
| More alerts | 9 of 10 | 17% | 2,707 | 75 | 25 |

An alert day is a day in the gauge record (October 2015 on) with 100 or more buildings on Elevated or High ground. Slides from winters other than 2023 were not collected, so alert days outside 2023 cannot be checked.

First trial on real labels (`model/real_label_experiment.py`): the hand-built GBM, trained on nine of the ten slides with real static features and tested on the tenth, beats 51% of random street spots. Slope alone beats 59%, the placeholder 66%. Ten weak labels are not enough to train on.

Spot check outside the test winter (`landslide_events_other_winters.csv`, four dated slides from 2016, 2017 and 2019 found in local news after the formula was fixed, positions taken from the named street): 0 of 4 near Elevated or High ground at Fewer alerts, 1 of 4 at Balanced, 2 of 4 at More alerts. Scores at the default: Augusta Drive 5, Van Tassel Lane 27, Canyon Road bridge 13 (April 2017, 12 mm of rain that week) and 47 (February 2019).

Three of those four were reported within five days of one of the eight wettest storms in the gauge record, so the rain trigger gets the timing right more often than the map score gets the place.

Timing across all 14 dated slides: 12 were reported within three days after a day in the wettest 5% of the gauge record (trigger T at or above 0.28). Only 6% of all days are that close to one. The misses are the April 2017 Canyon bridge slide and 57 Tarry Lane (reported February 7, 2023).

A slide site outscores a random street point 6.5 times in 10. Ten events cannot validate a model. These are the numbers the trained model has to beat.
