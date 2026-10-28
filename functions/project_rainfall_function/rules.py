"""Pure microgrid transition rules."""

STORAGE_MODE = "Renewable Storage Mode"
MAIN_GRID_MODE = "Main Grid Mode"


def evaluate_forecast(demand_kw, hour):
    """Return mode and overload state using the specified thresholds."""
    storage = demand_kw > 160 or 18 <= hour <= 22
    return {
        "grid_mode": STORAGE_MODE if storage else MAIN_GRID_MODE,
        "overload_alert": demand_kw >= 200,
    }
