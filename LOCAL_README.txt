GROUNDTRUTH LOCAL ML

Double-click START_LOCAL.cmd. Python 3 is required for the local server.
The program opens http://127.0.0.1:8765/#ask. Keep the server running.
Ask runs a trained NumPy gradient-boosted tree model in your browser.
No Claude, cloud inference, API key, or network data download is required.
The rest of the dashboard retains the original placeholder map and metrics.

The server runs a continuous historical simulation, one archived day per ten
seconds, looping Dec 26, 2022 to Mar 31, 2023. Ask shows the current simulation
date, rain and three street scores, with pause/resume controls. It keeps running
with the browser closed while the laptop is awake and the server process lives.
It does not run after shutdown or sleep, and does not retrain automatically.
Run STOP_LOCAL.cmd to stop the detached server started for this laptop.

EXPERIMENTAL: four weak pre-2022 reports at three approximate locations.
This is not a validated warning model. 0-100 scores are not probabilities.
The two Canyon Road events share a location; negative samples are unlabeled.
The 2023 events are excluded from training. Evaluation uses observed future
rain as a perfect-rain scenario, not archived forecasts. Results: local_model/report.json.

Install: python -m pip install -r requirements-local.txt
Rebuild:
Then: python model/train_local.py
Tests: node tests/local_model_test.cjs
Tests: python -m unittest discover -s tests -p "test_*.py"
Training features exclude simulated InSAR and 2023/2026 vegetation.
Input reports and approximated coordinates: local_model/labels.csv.
Full data provenance is in dataset/README.md.
Exact training inputs: local_model/input_manifest.json. No outside datasets.
