import json
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
SOURCES = {2016: "76ig-c548", 2026: "erm2-nwe9"}

totals = {}
for year, rid in SOURCES.items():
    where = f"created_date >= '{year}-01-01T00:00:00' AND created_date < '{year}-02-07T00:00:00'"
    r = requests.get(
        f"https://data.cityofnewyork.us/resource/{rid}.json",
        params={"$select": "count(*) as n", "$where": where},
        timeout=300,
    )
    r.raise_for_status()
    totals[year] = {"resource_id": rid, "where": where, "all_311_requests": int(r.json()[0]["n"])}
    print(year, totals[year])

(ROOT / "data" / "all_311_totals.json").write_text(json.dumps(totals, indent=2) + "\n")
