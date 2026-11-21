# escape

escape (the project folder and repo keep the old name, GroundTruth) is satellite landslide early warning for Lafayette, Orinda and Moraga, California.

## Local experimental model and simulation

The local server now also provides street scoring, saved prediction history and
optional Supabase synchronization. Ask prefers the Python API with browser-local
fallback. See [Supabase backend setup](supabase/README.md) for the database
migration, server-only configuration and API endpoints. Until Supabase is
configured, history is stored locally and the UI reports that connection state.

Run `python -m pip install -r requirements-local.txt`, then `python serve_local.py`
(or double-click `START_LOCAL.cmd` on Windows). Open http://127.0.0.1:8765/#ask.
The Ask section uses a trained 60-tree GBM locally without Claude or an API key.
The other dashboard views retain their original placeholder scores and metrics.

The server continuously replays Dec 26, 2022 through Mar 31, 2023, advancing one
historical day per ten seconds, and scores Miner Road, El Toyonal and Rheem
Boulevard. It continues with the browser closed while the process and laptop
remain running. Pause/resume controls are in Ask; closing the server stops it.
Observed future gauge rainfall is a scenario input, **not a live forecast**.
Runtime status is saved locally in `runtime/simulation.json` and excluded from Git.

Training uses only unchanged files supplied by this repository: terrain, gauge
rain, the four older news reports, and the bundled street geometry. No URLs in
source columns are fetched. `local_model/input_manifest.json` records the exact
source commit, Git blob IDs and input SHA-256 hashes; the trainer rejects changed
inputs. To rebuild, run `python model/train_local.py`. The 2023 events are held
out, simulated InSAR is excluded, and 2023/2026 vegetation is excluded.

**Experimental:** four reports represent only three approximate locations, with
unlabeled background negatives. Scores are classification scores, not calibrated
failure probabilities or validated warning tiers. Location holdouts performed
weakly; see `local_model/report.json` for all results, including the exploratory
2023 ranking test. This does not establish property safety.

Checks: `node tests/local_model_test.cjs` and
`python -m unittest discover -s tests -p "test_*.py"`.

## What is in this folder

| Folder | What it is |
|---|---|
| `site/` | The dashboard: a slim icon rail, a row of stat chips, a title row, then the 3D map with each view in a panel beside it. A data key, a hint and the layer toolbar float on the map. Surfaces are layered with shadows, no gradients. Dark and light themes. Open `site/index.html`, or run `python3 -m http.server` inside `site/` and open http://localhost:8000. No build step. |
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

`site/page.html` is the page body, `site/index.html` is the same page wrapped to open directly. The components follow the team's glass UI spec (one token block per theme at the top of the stylesheet, capsule controls, 31px panels) drawn flat with no gradients. The layout follows a logistics dashboard reference: rail, chips, title, layer toggles, big map with a compass and round map controls. three.js 0.160 and GSAP 3.12.5 are in `site/vendor/` so the site works offline. The street chat falls back to a written template answer when no language model is available.
