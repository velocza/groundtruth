# GroundTruth

Satellite landslide early warning for Lafayette, Orinda and Moraga, California.

## What is in this folder

| Folder | What it is |
|---|---|
| `site/` | The dashboard: a 3D terrain stage with a navigation rail, a KPI strip and one view panel, in dark and light themes. Open `site/index.html`, or run `python3 -m http.server` inside `site/` and open http://localhost:8000. No build step. |
| `dataset/` | The sample data the site runs on, as CSV, PNG and one NumPy archive. See `dataset/README.md`. |
| `model/real_label_experiment.py` | First run on real labels: leave-one-slide-out on the ten reported 2023 slides with real static features. Result in `model/real_label_experiment.json`: AUC 0.51 for the GBM, 0.59 for slope alone. Ten weak labels are not enough to train on. |
| `MODEL_HANDOFF.md` | **Start here if you are training the model.** Inputs, labels, the output file the site reads, how to check it and how to send it back. |
| `model/train_template.py`, `model/check_submission.py`, `model/handoff_common.py` | The training template, the submission checker and their shared definitions. |
| `model/gbm.py` | The gradient boosting model, written by hand in NumPy. `python3 model/gbm.py` runs three self tests and a smoke run. |
| `scripts/` | The scripts that pulled and built everything, in order `01` to `07`. |

The ML plan is a separate document: https://claude.ai/artifact/TfBUtdaM77hQaFJraNHKLW

## What the site can do

- **Storm sliders** for 72 hour rain and soil wetness, with presets from real gauge days, and three alert sensitivity levels.
- **Real data only switch** that drops the simulated ground motion from every number on the page.
- **Winter 2023 replay** driven day by day by the real gauge record.
- **Backtest scoreboard**: the ten reported slides against the score in the three days before each report, with a random street baseline and a table of slides caught, map flagged and alert days per winter for each sensitivity.
- **Slope inspector**: drivers of the score, tipping point rain, an eleven year hindcast against every day of real rain, and a debris runout trace that lists the streets and buildings in the way.
- **Building exposure**: 41,494 real footprints, counted and drawn where the ground scores Elevated or High.
- **Five day outlook**: type five daily rain totals and see each morning's exposure.
- **Storm briefing** as plain text, a **watch list** of streets, and a **CSV export** of every street's score.
- **Guided tour and reports**: a one minute tour that drives the real controls, and a downloadable street report with USGS warning signs and what to do.
- **Storm library, street finder, season rain**: load any of the eight wettest real storms since 2015, find a street on the free explore map, and see season rain to date against the average of the other years.
- **Spot check outside 2023**: four dated slides from 2016, 2017 and 2019 scored the same way (`dataset/landslide_events_other_winters.csv`).
- **Rain trigger timeline**: every day since October 2015 with all 14 dated slides marked. 12 of 14 follow a top 5% day within three days.
- **Street assistant**: template answers offline. When the page runs as a Claude artifact it calls six page functions (street report, street search, top streets, storm summary, debris path, backtest summary) so every number it says comes from the model.

## What is real and what is not

Real: elevation (USGS 3DEP via AWS Terrain Tiles), Sentinel-2 imagery (19 Apr 2023 and 4 Nov 2026), daily rain from six NOAA GHCN gauges (Oct 2015 to Nov 2026), streets and 41,494 building footprints (Overture Maps), ten slides reported in winter 2022 to 2023 (local news and city reports, placed at street level).

Simulated: the ground motion layer. It stands in for NASA OPERA DISP-S1 InSAR, which needs a free Earthdata login to download. Every file and column that carries it starts with `SIM_`.

Placeholder: the risk score on the site. It is a fixed formula (section 12 of the plan, `site/js/model.js`). The trained model replaces `GTModel.index()`.

Not trained yet: `model/gbm.py` passes its tests, and its only contact with real labels is the ten-slide trial above, which came out at chance. The smoke run only shows it can relearn the placeholder formula under spatial cross-validation.

## Next steps

1. Download OPERA DISP-S1 frames for the box from ASF Vertex and replace the `SIM_` layers in `scripts/03_build.py`.
2. Download the USGS January 2023 Bay Area landslide inventory (doi.org/10.5066/P9NJ3KMG) and the California Geological Survey inventory for labels.
3. Train with `GroundTruthGBM` on data up to 2022, backtest on winter 2023, calibrate with `platt_fit`.
4. `model.export("trees.json")` and walk the trees in `site/js/model.js`.

## Site files

`site/page.html` is the page body, `site/index.html` is the same page wrapped to open directly. The styles follow the team's glass UI spec: one token block per theme at the top of the stylesheet, capsule controls and one 31px radius for every panel. three.js 0.160 and GSAP 3.12.5 are in `site/vendor/` so the site works offline apart from web fonts. The street chat falls back to a written template answer when no language model is available.
