"""Catalyst AdvancedIO handler for hourly demand forecasting."""
import csv
import io
import json
import math
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from statistics import median

import requests
from flask import Request, make_response

from rules import evaluate_forecast

FEATURES = ("timestamp", "ambient_temp_c", "humidity_pct", "solar_irradiance_wm2")
HOURLY_MEAN = {0: 92.4, 1: 91.9, 2: 91.8, 3: 90.8, 4: 91.5, 5: 91.8, 6: 136.1,
               7: 177.3, 8: 181.1, 9: 186.5, 10: 159.4, 11: 163.7, 12: 165.3,
               13: 170.2, 14: 172.4, 15: 171.0, 16: 173.0, 17: 171.3,
               18: 220.6, 19: 217.8, 20: 215.0, 21: 209.4, 22: 204.7, 23: 114.8}
TOKEN_URL = "https://accounts.zoho.in/oauth/v2/token"
TIMEOUT = 20
WORKERS = 8
# Illustrative battery model: 100 kWh capacity, starts at 80%, moves 20 kW
# per forecast hour; storage mode discharges and main-grid mode charges.
BATTERY_CAPACITY_KWH = 100.0
BATTERY_START_PCT = 80.0
BATTERY_RATE_KW = 20.0
ENV_NAMES = ("QUICKML_ENDPOINT_URL", "QUICKML_ENDPOINT_KEY", "ZOHO_CLIENT_ID",
             "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN", "QML_ORG_ID", "QML_ENVIRONMENT")
_token = {"value": None}
_token_lock = threading.Lock()


class InputError(ValueError):
    pass


def _response(body, status=200):
    response = make_response(json.dumps(body), status)
    response.headers["Content-Type"] = "application/json"
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


def _parse_input(request):
    # Browsers skip the CORS pre-check for text/plain, so the dashboard sends JSON
    # as text/plain. Treat any body that starts with "{" as JSON, regardless of
    # the Content-Type header; everything else is parsed as CSV.
    raw_text = request.get_data().decode("utf-8-sig")
    is_json = ("json" in request.headers.get("Content-Type", "").lower()
               or raw_text.lstrip().startswith("{"))
    if is_json:
        try:
            body = json.loads(raw_text)
        except Exception as exc:
            raise InputError("Request body must be valid JSON.") from exc
        if not isinstance(body, dict) or not isinstance(body.get("rows"), list):
            raise InputError('JSON body must contain a "rows" array.')
        raw_rows = body["rows"]
    else:
        raw_rows = list(csv.DictReader(io.StringIO(raw_text)))
    if not raw_rows:
        raise InputError("At least one data row is required.")
    if len(raw_rows) > 48:
        raise InputError("A maximum of 48 rows is allowed.")
    if not isinstance(raw_rows[0], dict):
        raise InputError("Each row must be an object.")
    missing = [key for key in FEATURES if key not in raw_rows[0]]
    if missing:
        raise InputError("Missing required columns: " + ", ".join(missing))
    rows = []
    for index, item in enumerate(raw_rows, 1):
        if not isinstance(item, dict) or any(key not in item for key in FEATURES):
            raise InputError(f"Row {index} is missing one or more required columns.")
        try:
            timestamp = datetime.strptime(str(item["timestamp"]).strip(), "%Y-%m-%d %H:%M:%S")
        except (TypeError, ValueError) as exc:
            raise InputError(f"Row {index} has an invalid timestamp; expected YYYY-MM-DD HH:MM:SS.") from exc
        row = {"timestamp": timestamp}
        for key in FEATURES[1:]:
            value = item.get(key)
            if value is None or str(value).strip() == "":
                row[key] = None
                continue
            try:
                row[key] = float(value)
            except (TypeError, ValueError) as exc:
                raise InputError(f"Row {index} column {key} must be numeric or blank.") from exc
            if not math.isfinite(row[key]):
                raise InputError(f"Row {index} column {key} must be finite.")
        if row["humidity_pct"] is not None and not 0 <= row["humidity_pct"] <= 100:
            raise InputError(f"Row {index} humidity_pct must be between 0 and 100.")
        if row["solar_irradiance_wm2"] is not None and row["solar_irradiance_wm2"] < 0:
            raise InputError(f"Row {index} solar_irradiance_wm2 cannot be negative.")
        rows.append(row)
    rows.sort(key=lambda r: r["timestamp"])
    for key in FEATURES[1:]:
        known = [(i, row[key]) for i, row in enumerate(rows) if row[key] is not None]
        fill = median(value for _, value in known) if known else 0.0
        for i, row in enumerate(rows):
            if row[key] is not None:
                continue
            before = next(((j, v) for j, v in reversed(known) if j < i), None)
            after = next(((j, v) for j, v in known if j > i), None)
            if before and after:
                j, v = before
                k, w = after
                row[key] = v + (w - v) * (i - j) / (k - j)
            else:
                row[key] = before[1] if before else after[1] if after else fill
    return rows


def _access_token(force=False):
    with _token_lock:
        if _token["value"] and not force:
            return _token["value"]
        required = ("ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_REFRESH_TOKEN")
        missing = [key for key in required if not os.environ.get(key)]
        if missing:
            raise RuntimeError("Missing environment variables: " + ", ".join(missing))
        response = requests.post(TOKEN_URL, data={
            "grant_type": "refresh_token", "client_id": os.environ["ZOHO_CLIENT_ID"],
            "client_secret": os.environ["ZOHO_CLIENT_SECRET"],
            "refresh_token": os.environ["ZOHO_REFRESH_TOKEN"],
        }, timeout=TIMEOUT)
        response.raise_for_status()
        _token["value"] = response.json()["access_token"]
        return _token["value"]


def _predict_one(row, url):
    keys = ("QUICKML_ENDPOINT_KEY", "QML_ORG_ID", "QML_ENVIRONMENT")
    missing = [key for key in keys if not os.environ.get(key)]
    if missing:
        raise RuntimeError("Missing environment variables: " + ", ".join(missing))
    features = {"timestamp": row["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),
                **{key: row[key] for key in FEATURES[1:]}}
    last_error = None
    for _ in range(3):
        try:
            for auth_try in range(2):
                headers = {"Content-Type": "application/json",
                           "X-QUICKML-ENDPOINT-KEY": os.environ["QUICKML_ENDPOINT_KEY"],
                           "Authorization": "Zoho-oauthtoken " + _access_token(force=auth_try == 1),
                           "CATALYST-ORG": os.environ["QML_ORG_ID"],
                           "Environment": os.environ["QML_ENVIRONMENT"]}
                response = requests.post(url, json={"data": features}, headers=headers, timeout=TIMEOUT)
                if response.status_code == 401 and auth_try == 0:
                    continue
                response.raise_for_status()
                result = response.json().get("result")
                if not isinstance(result, list) or len(result) != 1:
                    raise ValueError("QuickML response must contain one numeric result.")
                value = float(result[0])
                if not math.isfinite(value):
                    raise ValueError("QuickML returned a non-finite prediction.")
                return value
            raise RuntimeError("QuickML authorization failed after token refresh.")
        except Exception as exc:
            last_error = exc
    raise RuntimeError(str(last_error))


def _forecast(rows):
    logs = []
    url = os.environ.get("QUICKML_ENDPOINT_URL", "").strip()
    predictions = None
    if url:
        try:
            with ThreadPoolExecutor(max_workers=min(WORKERS, len(rows))) as executor:
                predictions = list(executor.map(lambda row: _predict_one(row, url), rows))
            source = "quickml"
        except Exception as exc:
            logs.append(f"QuickML unavailable; using hourly mean fallback ({exc}).")
    else:
        logs.append("QUICKML_ENDPOINT_URL is not configured; using hourly mean fallback.")
    if predictions is None:
        source = "fallback"
        predictions = [HOURLY_MEAN[row["timestamp"].hour] for row in rows]
    battery = BATTERY_START_PCT
    results = []
    for row, demand in zip(rows, predictions):
        hour = row["timestamp"].hour
        rules = evaluate_forecast(demand, hour)
        battery += (BATTERY_RATE_KW / BATTERY_CAPACITY_KWH * 100) * (1 if rules["grid_mode"] == "Main Grid Mode" else -1)
        battery = min(100.0, max(0.0, battery))
        results.append({"timestamp": row["timestamp"].strftime("%Y-%m-%d %H:%M:%S"),
                        "predicted_demand_kw": demand, **rules, "battery_soc_pct": round(battery, 2)})
    return {"results": results,
            "summary": {"peak_demand_kw": max(predictions),
                        "hours_in_storage_mode": sum(r["grid_mode"] == "Renewable Storage Mode" for r in results),
                        "overload_hours": sum(r["overload_alert"] for r in results)},
            "source": source, "logs": logs}


def handler(request: Request):
    """Catalyst AdvancedIO handler entry point."""
    if request.method == "OPTIONS":
        return _response({}, 200)
    path = request.path.rstrip("/") or "/"
    if path.endswith("/health") and request.method == "GET":
        # Names only, never values: shows which variables the function can see.
        return _response({"status": "ok",
                          "env_configured": {name: bool(os.environ.get(name)) for name in ENV_NAMES}})
    if not path.endswith("/forecast"):
        return _response({"error": "Not found."}, 404)
    if request.method != "POST":
        return _response({"error": "Method not allowed."}, 405)
    try:
        return _response(_forecast(_parse_input(request)))
    except InputError as exc:
        return _response({"error": str(exc)}, 400)
    except Exception as exc:
        return _response({"error": f"Forecast failed: {exc}"}, 500)
