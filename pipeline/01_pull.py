import csv
import datetime
import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent

SOURCES = {
    2016: ("76ig-c548", "311 Service Requests from 2010 to 2019", "Snow"),
    2026: ("erm2-nwe9", "311 Service Requests from 2020 to Present", "Snow or Ice"),
}

FIELDS = [
    "unique_key",
    "created_date",
    "complaint_type",
    "descriptor",
    "location_type",
    "incident_address",
    "street_name",
    "cross_street_1",
    "cross_street_2",
    "incident_zip",
    "city",
    "borough",
    "community_board",
    "latitude",
    "longitude",
]

PAGE = 50000
manifest = {"pulled_at_utc": datetime.datetime.now(datetime.UTC).isoformat(timespec="seconds"), "pulls": []}

for year, (rid, name, ctype) in SOURCES.items():
    url = f"https://data.cityofnewyork.us/resource/{rid}.json"
    where = (
        f"created_date >= '{year}-01-01T00:00:00' "
        f"AND created_date < '{year}-02-07T00:00:00' "
        f"AND complaint_type = '{ctype}'"
    )

    rows, offset = [], 0
    while True:
        r = requests.get(
            url,
            params={"$select": ",".join(FIELDS), "$where": where, "$order": "unique_key", "$limit": PAGE, "$offset": offset},
            timeout=180,
        )
        r.raise_for_status()
        batch = r.json()
        rows.extend(batch)
        if len(batch) < PAGE:
            break
        offset += PAGE

    r = requests.get(url, params={"$select": "count(*) as n", "$where": where}, timeout=180)
    r.raise_for_status()
    api_count = int(r.json()[0]["n"])
    if len(rows) != api_count:
        raise SystemExit(f"[{year}] pulled {len(rows)} rows but API count is {api_count}")

    out = ROOT / f"snow_complaints_{year}_raw.csv"
    with open(out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    manifest["pulls"].append({"year": year, "resource_id": rid, "dataset": name, "where": where, "rows": len(rows), "file": out.name})
    print(f"[{year}] {rid}: {len(rows)} rows (API count {api_count}) -> {out.name}")

(ROOT / "data").mkdir(exist_ok=True)
(ROOT / "data" / "pull_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
