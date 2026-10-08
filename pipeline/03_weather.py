import datetime
import math
import csv
import io
import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "weather"
OUT.mkdir(parents=True, exist_ok=True)

STATION = "USW00094728"
summary = {"station": f"GHCND:{STATION}", "station_name": "NY City Central Park", "source": "NOAA NCEI GHCN-Daily via https://www.ncei.noaa.gov/access/services/data/v1", "units": "inches / degrees F", "windows": {}}

for year in (2016, 2026):
    r = requests.get(
        "https://www.ncei.noaa.gov/access/services/data/v1",
        params={
            "dataset": "daily-summaries",
            "stations": STATION,
            "startDate": f"{year}-01-01",
            "endDate": f"{year}-02-06",
            "dataTypes": "SNOW,SNWD,PRCP,TMAX,TMIN",
            "units": "standard",
            "includeAttributes": "true",
            "format": "csv",
        },
        timeout=120,
    )
    r.raise_for_status()

    days = list(csv.DictReader(io.StringIO(r.text)))
    if len(days) != 37 or any(d["SNOW"] == "" for d in days):
        raise SystemExit(f"[{year}] expected 37 complete days, got {len(days)}")

    expected_dates = [(datetime.date(year, 1, 1) + datetime.timedelta(days=i)).isoformat() for i in range(37)]
    if [d["DATE"] for d in days] != expected_dates or any(d["STATION"] != STATION for d in days):
        raise ValueError(f"[{year}] unexpected station or dates")
    for d in days:
        for field in ("SNOW", "SNWD", "TMAX", "TMIN"):
            flags = d[f"{field}_ATTRIBUTES"].split(",")
            if len(flags) < 3 or flags[1] or not math.isfinite(float(d[field])):
                raise ValueError(f"[{year}] missing or quality-flagged {field} on {d['DATE']}")
    (OUT / f"central_park_{year}.csv").write_text(r.text)
    snow = [float(d["SNOW"]) for d in days]
    depth = [float(d["SNWD"]) for d in days]
    tmax = [float(d["TMAX"]) for d in days]
    tmin = [float(d["TMIN"]) for d in days]
    biggest = max(range(len(days)), key=lambda i: snow[i])
    summary["windows"][str(year)] = {
        "start": f"{year}-01-01",
        "end_inclusive": f"{year}-02-06",
        "days": len(days),
        "total_snowfall_in": round(sum(snow), 1),
        "days_with_measurable_snowfall": sum(s >= 0.1 for s in snow),
        "largest_daily_snowfall_in": snow[biggest],
        "largest_daily_snowfall_date": days[biggest]["DATE"],
        "days_snow_depth_ge_1in": sum(s >= 1 for s in depth),
        "days_snow_depth_ge_6in": sum(s >= 6 for s in depth),
        "max_snow_depth_in": max(depth),
        "mean_daily_high_f": round(sum(tmax) / len(tmax), 1),
        "mean_daily_low_f": round(sum(tmin) / len(tmin), 1),
        "days_high_at_or_below_32f": sum(t <= 32 for t in tmax),
        "snow_source_flags": sorted({d["SNOW_ATTRIBUTES"].split(",")[2] for d in days}),
    }

(ROOT / "data" / "weather_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps(summary["windows"], indent=2))
