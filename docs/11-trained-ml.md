# Trained forecasting evidence

Open **Trained ML Evidence** (`/ml`) for plots, individual model metrics, ensemble weights, and a derived six-hour stockout confusion matrix. Risk & Forecast identifies the engine used for each live series.

The production forecaster is a scikit-learn RandomForestRegressor, ExtraTreesRegressor and GradientBoostingRegressor ensemble. Validation MAE determines weights. Python exports the fitted tree structures to JSON; Node performs inference locally. No Python process, model server, network request or additional runtime dependency is required. Export parity is checked against scikit-learn predictions.

Data comprises 48,384 synthetic rows from 144 distinct episodes: 96 training, 24 validation, 24 test. Episodes vary station profile, fuel, latent demand scale, random demand noise and demand surges. Forecast features use only origin history, the current multiplier, known future calendar and horizon. Future event boundaries are not given to the model. The model forecasts 24 steps directly. The dataset is synthetic; these are not measured results from the official simulator or real fuel operations.

Reproduce:

```bash
python3 -m venv .venv-ml
.venv-ml/bin/pip install -r scripts/ml/requirements.txt
.venv-ml/bin/python scripts/ml/train.py
pnpm --filter api test
```

Training outputs: `docs/evidence/ml/synthetic-dataset.csv.gz`, `evaluation.json`, `evaluation.png`, and `evaluation.pdf`. Model artifact: `apps/api/src/forecast/trained-model.json`. Training uses fixed seeds; the test set is never used for weight selection or residual calibration. See the JSON for exact metrics and package version.

Confusion matrix: the forecast's total six-hour demand is compared with independently sampled starting inventory. The ground truth uses realized held-out demand. This evaluates a no-new-delivery stockout decision derived from regression, not a separate classifier. Overlapping windows are correlated, so row counts must not be interpreted as independent operational trials.

The existing statistical forecast is used during the first 12 observations, unsupported inputs, or artifact errors. The existing model-offline drill still switches decisions to the heuristic fallback. The LP, manual acceptance and simulator dispatch validation remain in charge of action feasibility. Confidence uses validation relative error and is capped during drift; it is an indicative reliability score, not a calibrated correctness probability. Interval coverage is reported empirically.

Model methods: https://scikit-learn.org/stable/api/sklearn.ensemble.html
