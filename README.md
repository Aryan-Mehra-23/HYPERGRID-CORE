# HackSphere 3.0: Smart Energy Microgrid & Demand Forecasting Engine

A web application on **Zoho Catalyst** that forecasts hourly energy demand for the next 24 hours with a model trained in **Catalyst QuickML**, then applies the microgrid transition rules (Main Grid vs Renewable Storage, plus critical overload alerts) and shows everything on a live dashboard.

- **Live app (Catalyst Slate):** https://static-ngeespll.onslate.in
- **Team:** `<TEAM NAME>`

## How it works

```
Weather rows (CSV upload or form)
        |
        v
Slate dashboard (static/)  --POST /forecast-->  Catalyst Advanced I/O function (functions/project_rainfall_function)
                                                  1. validate and clean the rows
                                                  2. call the published QuickML endpoint (one request per row)
                                                  3. apply the transition rules (rules.py)
                                                  4. simulate battery state of charge
        ^                                         |
        +------- JSON: forecast, modes, alerts ---+
```

| Part | Catalyst service | Folder |
|---|---|---|
| Forecasting model | QuickML (pipeline, model, published endpoint) | n/a (console) |
| Backend API and transition controller | Functions (Advanced I/O, Python 3.13) | `functions/project_rainfall_function/` |
| Dashboard | Slate (static HTML/CSS/JS) | `static/` |
| Evaluation script | local Python script | `predict.py` |

## The model

- **Pipeline:** Source dataset (`train_telemetry.csv`) -> Extract Data (hour of day from `timestamp`, as a new `hour` column) -> drop `timestamp` -> GB (gradient boosting) Regression -> model -> published endpoint.
- **Features:** `hour`, `ambient_temp_c`, `humidity_pct`, `solar_irradiance_wm2`. Target: `target_demand_kw`.
- **Settings changed from defaults:** learning rate 0.05, 300 estimators.
- **Why only `hour`:** it carries most of the signal (demand follows a clear daily pattern). Month and weekday were left out on purpose: the test period covers dates not seen in training, and weekday made no difference in our analysis.
- **Accuracy:** RMSE 8.92 and R2 0.9685 on QuickML's built-in evaluation split. On a chronological hold-out (training on the earlier 80% of the data, testing on the later 20%) our own check gave an RMSE of roughly 12, which is the more realistic estimate for the later, warmer test weeks.
- The published endpoint takes the four raw columns (`timestamp` plus the three weather values) and returns `{"result": [kW]}`; the hour feature is derived inside the pipeline.

## Transition controller rules

Evaluated per forecast hour, using the predicted demand and the hour of the timestamp:

| Condition | Result |
|---|---|
| demand > 160 kW **or** hour between 18 and 22 inclusive | Renewable Storage Mode |
| otherwise (demand <= 160 kW and outside 18:00-22:59) | Main Grid Mode |
| demand >= 200 kW | Critical Overload Alert (independent of the mode) |

The rules live in `functions/project_rainfall_function/rules.py` and are covered by unit tests (`tests/test_rules.py`).

## Battery state of charge (illustrative model)

The problem statement asks for a battery state of charge but does not define a battery model, so this is a simple, documented assumption:

- 100 kWh capacity, starts at 80%, moves 20% per forecast hour.
- Discharges in Renewable Storage Mode, charges in Main Grid Mode, clamped between 0% and 100%.
- Solar charging is **not** modelled; solar irradiance is only a forecast input.
- The controller decision always follows the transition rules above, even when the simulated battery is empty. The dashboard flags a depleted battery.

## API

Base URL: the function's invocation URL (`<FUNCTION_URL>`).

- `GET <FUNCTION_URL>/health` returns `{"status": "ok", "env_configured": {...}}` (names only, never values).
- `POST <FUNCTION_URL>/forecast` accepts either JSON `{"rows": [{timestamp, ambient_temp_c, humidity_pct, solar_irradiance_wm2}, ...]}` or CSV text with those columns (up to 48 rows). The dashboard sends the body as `text/plain` to avoid a browser CORS preflight. The response contains `results` (per hour: predicted demand, grid mode, overload flag, battery SOC), a `summary`, a `source` (`quickml` or `fallback`) and `logs`.
- Data cleaning: columns and timestamps are validated, missing weather values are interpolated (or filled with the median), and invalid values (humidity outside 0-100, negative solar) are rejected with a clear error.
- If the QuickML call fails, the function returns a hard-coded hourly-average estimate and sets `source` to `fallback`; the dashboard shows this as a visible warning.

## Environment variables (set in the function's Configuration page)

| Name | Purpose |
|---|---|
| `QUICKML_ENDPOINT_URL` | published QuickML endpoint URL |
| `QUICKML_ENDPOINT_KEY` | value for the `X-QUICKML-ENDPOINT-KEY` header |
| `ZOHO_CLIENT_ID` | Zoho OAuth Self Client ID |
| `ZOHO_CLIENT_SECRET` | Zoho OAuth Self Client secret |
| `ZOHO_REFRESH_TOKEN` | refresh token used to obtain short-lived access tokens |
| `QML_ORG_ID` | Catalyst org ID (sent as the `CATALYST-ORG` header) |
| `QML_ENVIRONMENT` | `Development` (sent as the `Environment` header) |

No credentials are stored in the code. **Do not commit real values.** (Catalyst rejects variable names starting with `CATALYST_`, which is why the last two use the `QML_` prefix.)

## `predict.py` (automated evaluation script)

```
python predict.py --input sample_test_input.csv --output predictions.csv
python test_eval.py
```

`predict(input_df)` returns one prediction per row by calling the published QuickML endpoint, and the CLI writes `timestamp,target_demand_kw`. Credentials are read from environment variables first (`QUICKML_ENDPOINT_KEY`, `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN`), and from the matching constants at the top of the file if those are filled in. The OAuth access token is refreshed automatically. If the endpoint cannot be reached, it prints a warning and falls back to an hourly average so it never crashes.

Install the Python packages with `pip install pandas numpy requests`.

## Setup and deployment

1. Install Node.js and the Catalyst CLI (`npm install -g zcatalyst-cli`), then `catalyst login`.
2. Python 3.13 must be installed; point the CLI at it with `catalyst config:set python3_13.bin="<path to python.exe>"`.
3. Train and publish the model in QuickML (see "The model"), then create the endpoint.
4. Create a Zoho API Console **Self Client** and generate a refresh token for the QuickML scope shown on the endpoint page.
5. Deploy the function: `catalyst deploy --only functions`, then add the environment variables above in the console.
6. Set `API_BASE` at the top of `static/app.js` to the function's invocation URL.
7. Deploy the dashboard: `catalyst deploy --only slate`.

> Note: a deploy that includes the function resets its environment variables. After any function deploy, re-add them and check that `/health` reports all seven as `true`.

Run the rule tests locally: `cd functions/project_rainfall_function && python -m unittest`.

## Project layout

```
catalyst.json
predict.py                 evaluation script (credentials blanked in this repo)
test_eval.py               pre-submission contract check
sample_test_input.csv
functions/project_rainfall_function/
    main.py                API handler, QuickML client, cleaning, battery model
    rules.py               transition rules
    tests/test_rules.py    unit tests for the rules
    requirements.txt
static/                    dashboard (index.html, style.css, app.js, background.js)
```

## Known limitations

- The battery model is illustrative (see above).
- The function sends one QuickML request per row, so very large batches are capped at 48 rows.
- The dashboard's hour stepping scrolls the page to the timeline; this is cosmetic.
