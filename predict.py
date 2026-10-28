"""HackSphere 3.0 - demand forecasting predict.py

Usage:
    python predict.py --input sample_test_input.csv --output predictions.csv

predict(input_df) returns one prediction (kW) per input row, in order.
"""
import argparse
import os
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests

# Paste your published QuickML endpoint URL here (or set the QUICKML_ENDPOINT_URL
# environment variable, which takes priority).
QUICKML_ENDPOINT_URL = "https://api.catalyst.zoho.in/quickml/v1/project/102721000000013027/endpoints/predict"

# --- Auth (the endpoint requires these headers) -----------------------------
# Prefer environment variables. Values left as "" below are read from the env.
ENDPOINT_KEY = " "      # env QUICKML_ENDPOINT_KEY  (X-QUICKML-ENDPOINT-KEY header)
CATALYST_ORG = "60093086252"   # CATALYST-ORG header
ENVIRONMENT = "Development"    # Environment header
CLIENT_ID = " "         # env ZOHO_CLIENT_ID
CLIENT_SECRET = " "     # env ZOHO_CLIENT_SECRET
REFRESH_TOKEN = " "     # env ZOHO_REFRESH_TOKEN
TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token"   

FEATURES = ["timestamp", "ambient_temp_c", "humidity_pct", "solar_irradiance_wm2"]
TIMEOUT = 30
WORKERS = 8

# Emergency fallback only: mean training demand per hour of day.
HOURLY_MEAN = {
    0: 92.4, 1: 91.9, 2: 91.8, 3: 90.8, 4: 91.5, 5: 91.8, 6: 136.1, 7: 177.3,
    8: 181.1, 9: 186.5, 10: 159.4, 11: 163.7, 12: 165.3, 13: 170.2, 14: 172.4,
    15: 171.0, 16: 173.0, 17: 171.3, 18: 220.6, 19: 217.8, 20: 215.0,
    21: 209.4, 22: 204.7, 23: 114.8,
}


_token_cache = {"value": None}


def _cfg(env_name, default=""):
    return os.environ.get(env_name) or default


def _access_token(force=False):
    """Short-lived OAuth token. Use ZOHO_ACCESS_TOKEN if given, else refresh it."""
    if _token_cache["value"] and not force:
        return _token_cache["value"]
    fixed = os.environ.get("ZOHO_ACCESS_TOKEN")
    if fixed and not force:
        _token_cache["value"] = fixed
        return fixed
    resp = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "refresh_token",
            "client_id": _cfg("ZOHO_CLIENT_ID", CLIENT_ID),
            "client_secret": _cfg("ZOHO_CLIENT_SECRET", CLIENT_SECRET),
            "refresh_token": _cfg("ZOHO_REFRESH_TOKEN", REFRESH_TOKEN),
        },
        timeout=TIMEOUT,
    )
    resp.raise_for_status()
    token = resp.json()["access_token"]
    _token_cache["value"] = token
    return token


def _headers(force_token=False):
    return {
        "Content-Type": "application/json",
        "X-QUICKML-ENDPOINT-KEY": _cfg("QUICKML_ENDPOINT_KEY", ENDPOINT_KEY),
        "Authorization": f"Zoho-oauthtoken {_access_token(force_token)}",
        "CATALYST-ORG": _cfg("CATALYST_ORG", CATALYST_ORG),
        "Environment": _cfg("CATALYST_ENVIRONMENT", ENVIRONMENT),
    }


def _endpoint_url():
    return os.environ.get("QUICKML_ENDPOINT_URL", QUICKML_ENDPOINT_URL)


def _fallback(df: pd.DataFrame) -> np.ndarray:
    hours = pd.to_datetime(df["timestamp"], errors="coerce").dt.hour
    return hours.map(HOURLY_MEAN).fillna(float(np.mean(list(HOURLY_MEAN.values())))).to_numpy(dtype=float)


def _clean(df: pd.DataFrame) -> pd.DataFrame:
    """Keep the contract columns, fix types, fill missing weather values."""
    df = df[FEATURES].copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    for col in FEATURES[1:]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
        df[col] = df[col].interpolate(limit_direction="both")
        df[col] = df[col].fillna(df[col].median() if df[col].notna().any() else 0.0)
    # Missing timestamps: continue hourly from the previous row.
    if df["timestamp"].isna().any():
        df["timestamp"] = df["timestamp"].ffill() + pd.to_timedelta(
            df["timestamp"].isna().cumsum().where(df["timestamp"].isna(), 0), unit="h"
        )
        df["timestamp"] = df["timestamp"].fillna(pd.Timestamp("2015-01-01"))
    df["timestamp"] = df["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
    return df


def _extract(result):
    """Pull the numeric predictions out of the endpoint response."""
    if isinstance(result, dict):
        for key in ("result", "predictions", "prediction"):
            if key in result:
                result = result[key]
                break
    if not isinstance(result, (list, tuple)):
        result = [result]
    return [float(v) for v in result]


def _post(url, data):
    resp = requests.post(url, json={"data": data}, headers=_headers(), timeout=TIMEOUT)
    if resp.status_code == 401:  # token expired: refresh once and retry
        resp = requests.post(
            url, json={"data": data}, headers=_headers(force_token=True), timeout=TIMEOUT
        )
    resp.raise_for_status()
    return _extract(resp.json())


def _predict_row(url, row, retries=3):
    last = None
    for _ in range(retries):
        try:
            out = _post(url, row)
            if len(out) == 1:
                return out[0]
            last = ValueError(f"expected 1 value, got {len(out)}")
        except Exception as e:  # noqa: BLE001
            last = e
    raise last


def predict(input_df: pd.DataFrame):
    """input_df columns: timestamp, ambient_temp_c, humidity_pct, solar_irradiance_wm2.
    Returns a numpy array with one predicted demand (kW) per row."""
    df = _clean(input_df)
    rows = df.to_dict(orient="records")
    url = _endpoint_url()

    if url != "YOUR_PUBLISHED_QUICKML_ENDPOINT_URL_HERE":
        try:
            # One request per row (this is the format the endpoint's test box uses).
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                preds = list(pool.map(lambda r: _predict_row(url, r), rows))
            return np.array(preds, dtype=float)
        except Exception as e:  # noqa: BLE001
            print(f"WARNING: QuickML endpoint call failed ({e}). Using hourly-average fallback.")
    else:
        print("WARNING: QUICKML_ENDPOINT_URL not set. Using hourly-average fallback.")

    return _fallback(df)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", default="sample_test_input.csv")
    parser.add_argument("--output", default="predictions.csv")
    args = parser.parse_args()

    data = pd.read_csv(args.input)
    preds = predict(data)
    out = pd.DataFrame({"timestamp": data["timestamp"], "target_demand_kw": np.round(preds, 2)})
    out.to_csv(args.output, index=False)
    print(f"Wrote {len(out)} predictions to {args.output}. First 5:\n{out.head()}")
