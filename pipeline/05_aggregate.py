import json
import re
from datetime import datetime
from zoneinfo import ZoneInfo
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
YEARS = (2016, 2026)
DAYS = pd.date_range("2016-01-01", "2016-02-06").strftime("%m-%d").tolist()
NEW_2026_DESCRIPTORS = ["Pedestrian Feature", "Snow Tracking", "Bike Lane"]
NYC_BBOX = {"lat": (40.47, 40.93), "lon": (-74.27, -73.68)}


def point_in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i]
        xj, yj = ring[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_boroughs(lon, lat, features):
    for f in features:
        geom = f["geometry"]
        polygons = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for rings in polygons:
            if point_in_ring(lon, lat, rings[0]) and not any(point_in_ring(lon, lat, h) for h in rings[1:]):
                return True
    return False


weather = json.loads((ROOT / "data" / "weather_summary.json").read_text())
totals_311 = json.loads((ROOT / "data" / "all_311_totals.json").read_text())
manifest = json.loads((ROOT / "data" / "pull_manifest.json").read_text())

frames, years = [], {}
for year in YEARS:
    d = pd.read_csv(ROOT / f"snow_complaints_{year}_clean.csv", dtype=str, keep_default_na=False)
    if not d.unique_key.is_unique or (d.unique_key.str.strip() == "").any():
        raise ValueError(f"[{year}] missing or repeated request ID")
    dates = pd.to_datetime(d.created_date, errors="raise")
    if not dates.between(f"{year}-01-01", f"{year}-02-07", inclusive="left").all():
        raise ValueError(f"[{year}] record outside reporting window")
    if not d.complaint_type.eq("Snow" if year == 2016 else "Snow or Ice").all():
        raise ValueError(f"[{year}] unexpected complaint category")
    d["zip"] = d.incident_zip.str.strip()
    if not (d.zip.eq("") | d.zip.str.fullmatch(r"\d{5}")).all():
        raise ValueError(f"[{year}] invalid ZIP format")
    d["day"] = d.created_date.str[5:10]
    missing_coords = (d.latitude == "") | (d.longitude == "")
    missing_zip = d.zip == ""
    ok = ~missing_coords & ~missing_zip

    m = d[ok].copy()
    m["lat"] = m.latitude.astype(float)
    m["lon"] = m.longitude.astype(float)
    m["year"] = year
    outside = ~(m.lat.between(*NYC_BBOX["lat"]) & m.lon.between(*NYC_BBOX["lon"]))
    print(f"[{year}] clean {len(d)} | missing coords {missing_coords.sum()} | missing zip {missing_zip.sum()} | "
          f"excluded (either) {(~ok).sum()} = {(~ok).mean():.2%} | mapped {ok.sum()} | outside NYC bbox {outside.sum()}")
    if outside.any():
        raise ValueError(f"[{year}] coordinates outside NYC bounding box; investigate before publishing")
    frames.append(m)

    w = pd.read_csv(ROOT / "data" / "weather" / f"central_park_{year}.csv", dtype={"DATE": str})
    if w.DATE.tolist() != [f"{year}-{day}" for day in DAYS]:
        raise ValueError(f"[{year}] missing, repeated or unordered weather dates")
    years[str(year)] = {
        "clean": len(d),
        "mapped": int(ok.sum()),
        "excluded_missing_zip_or_coordinates": int((~ok).sum()),
        "daily_total": d.day.value_counts().reindex(DAYS, fill_value=0).astype(int).tolist(),
        "snowfall_daily_in": [round(float(s), 1) for s in w.SNOW],
        "snowfall_total_in": weather["windows"][str(year)]["total_snowfall_in"],
        "days_snow_depth_ge_6in": weather["windows"][str(year)]["days_snow_depth_ge_6in"],
        "all_311_requests": totals_311[str(year)]["all_311_requests"],
    }
    assert sum(years[str(year)]["daily_total"]) == len(d)

pts = pd.concat(frames)
by_zip = pts.groupby("zip")
table = pd.DataFrame({"lat": by_zip.lat.median(), "lon": by_zip.lon.median(), "geocoded_points": by_zip.size()})
named = pts[pts.borough != "Unspecified"]
table["borough"] = named.groupby("zip").borough.agg(lambda s: s.value_counts().index[0])
table["borough"] = table.borough.fillna("Unspecified")
counts = pts.pivot_table(index="zip", columns="year", values="lat", aggfunc="size", fill_value=0)
for year in YEARS:
    table[f"complaints_{year}"] = counts[year].reindex(table.index, fill_value=0).astype(int)
max_count = int(table[[f"complaints_{y}" for y in YEARS]].to_numpy().max())
for year in YEARS:
    table[f"height_norm_{year}"] = (table[f"complaints_{year}"] / max_count).pow(0.5).round(4)

daily = {
    year: pts[pts.year == year]
    .pivot_table(index="zip", columns="day", values="lat", aggfunc="size", fill_value=0)
    .reindex(index=table.index, columns=DAYS, fill_value=0)
    .astype(int)
    for year in YEARS
}
for year in YEARS:
    assert (daily[year].sum(axis=1) == table[f"complaints_{year}"]).all()
    assert table[f"complaints_{year}"].sum() == years[str(year)]["mapped"]

boroughs = json.loads((ROOT / "public" / "data" / "boroughs.geojson").read_text())["features"]
table["inside_outline"] = [in_boroughs(lon, lat, boroughs) for lat, lon in zip(table.lat, table.lon)]

table = table.reset_index().sort_values("zip")
table["lat"] = table.lat.round(6)
table["lon"] = table.lon.round(6)
columns = ["zip", "borough", "lat", "lon", "geocoded_points", "complaints_2016", "complaints_2026", "height_norm_2016", "height_norm_2026"]
table[columns].to_csv(ROOT / "public/data/zip_complaint_counts.csv", index=False)

clean_2026 = pd.read_csv(ROOT / "snow_complaints_2026_clean.csv", usecols=["descriptor"], dtype=str, keep_default_na=False)
out = {
    "source": "pipeline/05_aggregate.py",
    "pulled_at_utc": manifest["pulled_at_utc"],
    "days": DAYS,
    "max_zip_count": max_count,
    "height": "PILE_MAX_HEIGHT * sqrt(count / max_zip_count)",
    "years": years,
    "new_2026_descriptors": {"names": NEW_2026_DESCRIPTORS, "complaints": int(clean_2026.descriptor.isin(NEW_2026_DESCRIPTORS).sum())},
    "zips": [
        {
            "zip": r.zip,
            "borough": r.borough,
            "lat": round(float(r.lat), 5),
            "lon": round(float(r.lon), 5),
            "n2016": int(r.complaints_2016),
            "n2026": int(r.complaints_2026),
            "d2016": daily[2016].loc[r.zip].tolist(),
            "d2026": daily[2026].loc[r.zip].tolist(),
        }
        for r in table.itertuples()
    ],
}
(ROOT / "public" / "data" / "zip_complaint_counts.json").write_text(json.dumps(out, separators=(",", ":")) + "\n")

AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."]
pulled = datetime.fromisoformat(manifest["pulled_at_utc"]).astimezone(ZoneInfo("America/New_York"))
a, b = years["2016"], years["2026"]
expected = {
    "t2016": f"{a['clean']:,}",
    "t2026": f"{b['clean']:,}",
    "ratio": f"{b['clean'] / a['clean']:.1f}",
    "p311": str(round((b["all_311_requests"] / a["all_311_requests"] - 1) * 100)),
    "d6_2016": str(a["days_snow_depth_ge_6in"]),
    "d6_2026": str(b["days_snow_depth_ge_6in"]),
    "newsub": f"{out['new_2026_descriptors']['complaints']:,}",
    "unmapped2016": f"{a['excluded_missing_zip_or_coordinates']:,}",
    "unmapped2026": f"{b['excluded_missing_zip_or_coordinates']:,}",
    "zips": f"{len(table):,}",
    "pulled": f"{AP_MONTHS[pulled.month - 1]} {pulled.day}, {pulled.year}",
}
html = (ROOT / "index.html").read_text()
stale = []
for match in re.finditer(r'data-text="([^"]+)"[^>]*>([^<]*)<', html):
    key, shown = match.group(1), match.group(2).strip()
    if key not in expected:
        stale.append(f"  data-text={key}: the data has no such value")
    elif shown != expected[key]:
        stale.append(f"  data-text={key}: page shows {shown!r}, data says {expected[key]!r}")
for year, panel in zip(YEARS, re.findall(r'class="count">([^<]*)<.*?class="snow">([^<]*)<', html, re.S)):
    want = (f"{years[str(year)]['clean']:,}", f"{years[str(year)]['snowfall_total_in']:.1f}")
    if panel != want:
        stale.append(f"  {year} panel label: page shows {panel}, data says {want}")
if stale:
    raise SystemExit("index.html is out of date:\n" + "\n".join(stale))
print("index.html static numbers match the data")

print(f"ZIP bins: {len(table)} | with 2016 complaints: {(table.complaints_2016 > 0).sum()} | with 2026 complaints: {(table.complaints_2026 > 0).sum()} | "
      f"only 2016: {((table.complaints_2016 > 0) & (table.complaints_2026 == 0)).sum()} | only 2026: {((table.complaints_2026 > 0) & (table.complaints_2016 == 0)).sum()}")
print(f"max_zip_count: {max_count}")
for year in YEARS:
    print(table.nlargest(3, f"complaints_{year}")[["zip", "borough", "complaints_2016", "complaints_2026"]].to_string(index=False))
print("new 2026 descriptors complaints:", out["new_2026_descriptors"])
print("ZIP points outside simplified borough outline:", int((~table.inside_outline).sum()))

from html import escape
rows = "\n".join(
    f"<tr><th scope='row'>{escape(r.zip)}</th><td>{escape(r.borough.title())}</td>"
    f"<td>{r.complaints_2016:,}</td><td>{r.complaints_2026:,}</td></tr>"
    for r in table.itertuples()
)
(ROOT / "public/data/zip-table.html").write_text(
    "<!doctype html><html lang='en'><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width, initial-scale=1'>"
    "<title>Snow complaints by ZIP code</title>"
    "<style>body{font:1rem system-ui;max-width:52rem;margin:2rem auto;padding:1rem}"
    "table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.5rem;border-bottom:1px solid #bbb}</style>"
    "<main><h1>Snow complaints by ZIP code</h1><p>Jan. 1–Feb. 6 in each year. "
    "Counts include only requests with a recorded ZIP code and coordinates. "
    "These are counts of reports, not unique hazards or population-adjusted rates. "
    "The complaint categories changed between years.</p><p>"
    "<a href='../'>Back to story</a> · <a href='zip_complaint_counts.csv' download>Download CSV</a></p>"
    "<table><caption>NYC 311 snow and ice requests with map locations</caption><thead>"
    "<tr><th scope='col'>ZIP</th><th scope='col'>Borough</th><th scope='col'>2016</th>"
    "<th scope='col'>2026</th></tr></thead><tbody>" + rows + "</tbody></table></main></html>\n"
)
