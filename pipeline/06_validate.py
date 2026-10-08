"""Reconcile the published aggregates against saved source records, without network access."""
import csv
import json
import math
from collections import Counter
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def read_csv(path):
    with path.open(newline='') as stream:
        return list(csv.DictReader(stream))

def check(condition, message):
    if not condition:
        raise ValueError(message)

payload = json.loads((ROOT / 'public/data/zip_complaint_counts.json').read_text())
weather_summary = json.loads((ROOT / 'data/weather_summary.json').read_text())
manifest = json.loads((ROOT / 'data/pull_manifest.json').read_text())
zip_csv = {r['zip']: r for r in read_csv(ROOT / 'public/data/zip_complaint_counts.csv')}
check(len(payload['zips']) == len(zip_csv), 'ZIP table size mismatch')
for year, kind in ((2016, 'Snow'), (2026, 'Snow or Ice')):
    raw = read_csv(ROOT / f'snow_complaints_{year}_raw.csv')
    clean = read_csv(ROOT / f'snow_complaints_{year}_clean.csv')
    ids = [r['unique_key'] for r in raw]
    check(all(ids) and len(set(ids)) == len(ids), f'{year}: invalid request IDs')
    check([r for r in raw if r['complaint_type'] == kind] == clean, f'{year}: cleaning lost or altered records')
    saved_pull = next(p for p in manifest['pulls'] if p['year'] == year)
    check(len(raw) == saved_pull['rows'], f'{year}: manifest row count')
    dates = [(date(year, 1, 1) + timedelta(days=i)).isoformat() for i in range(37)]
    check(all(r['created_date'][:10] in dates for r in clean), f'{year}: dates outside window')
    daily = Counter(r['created_date'][5:10] for r in clean)
    stats = payload['years'][str(year)]
    check(stats['clean'] == len(clean), f'{year}: citywide total')
    check(stats['daily_total'] == [daily[d[5:]] for d in dates], f'{year}: daily totals')
    mapped = [r for r in clean if r['incident_zip'].strip() and r['latitude'] and r['longitude']]
    counts = Counter(r['incident_zip'].strip() for r in mapped)
    zip_days = Counter((r['incident_zip'].strip(), r['created_date'][5:10]) for r in mapped)
    check(stats['mapped'] == len(mapped), f'{year}: mapped total')
    check(stats['excluded_missing_zip_or_coordinates'] == len(clean)-len(mapped), f'{year}: exclusions')
    for z in payload['zips']:
        check(z[f'n{year}'] == counts[z['zip']] == int(zip_csv[z['zip']][f'complaints_{year}']), f'{year}: ZIP total {z["zip"]}')
        check(z[f'd{year}'] == [zip_days[z['zip'], d[5:]] for d in dates], f'{year}: ZIP daily counts')
    w = read_csv(ROOT / f'data/weather/central_park_{year}.csv')
    check([r['DATE'] for r in w] == dates, f'{year}: weather date coverage')
    for r in w:
        check(r['STATION'] == 'USW00094728', 'Wrong weather station')
        for field in ('SNOW', 'SNWD', 'TMAX', 'TMIN'):
            check(math.isfinite(float(r[field])) and not r[field+'_ATTRIBUTES'].split(',')[1], f'{year}: weather missing or quality flag')
    snow = [float(r['SNOW']) for r in w]
    depth = [float(r['SNWD']) for r in w]
    high = [float(r['TMAX']) for r in w]
    low = [float(r['TMIN']) for r in w]
    summary = weather_summary['windows'][str(year)]
    biggest = max(range(37), key=snow.__getitem__)
    expected = dict(days=37, total_snowfall_in=round(sum(snow), 1),
        days_with_measurable_snowfall=sum(s >= .1 for s in snow),
        largest_daily_snowfall_in=max(snow), largest_daily_snowfall_date=dates[biggest],
        days_snow_depth_ge_1in=sum(s >= 1 for s in depth), days_snow_depth_ge_6in=sum(s >= 6 for s in depth),
        max_snow_depth_in=max(depth), mean_daily_high_f=round(sum(high)/37, 1),
        mean_daily_low_f=round(sum(low)/37, 1), days_high_at_or_below_32f=sum(t <= 32 for t in high))
    check(all(summary[k] == v for k, v in expected.items()), f'{year}: weather summary')
    check(stats['snowfall_daily_in'] == snow and stats['snowfall_total_in'] == expected['total_snowfall_in'], f'{year}: published snowfall')
    check(stats['days_snow_depth_ge_6in'] == expected['days_snow_depth_ge_6in'], f'{year}: published snow depth')
    totals = json.loads((ROOT / 'data/all_311_totals.json').read_text())
    check(stats['all_311_requests'] == totals[str(year)]['all_311_requests'], f'{year}: baseline')
check(payload['max_zip_count'] == max(z[f'n{year}'] for z in payload['zips'] for year in (2016, 2026)), 'Height scale maximum')
print('PASS: request IDs, raw-to-clean rows, manifest counts, dates, daily/ZIP totals, weather, baseline, scale')
