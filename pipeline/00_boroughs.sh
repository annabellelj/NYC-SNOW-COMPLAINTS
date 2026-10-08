#!/bin/sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
TMP=$(mktemp -d)
curl -sS -m 120 "https://data.cityofnewyork.us/resource/gthc-hcne.geojson" -o "$TMP/boroughs_raw.geojson"
npx -y mapshaper@0.7.61 -i "$TMP/boroughs_raw.geojson" \
  -simplify 2% keep-shapes \
  -filter-fields boroname,borocode \
  -o precision=0.00001 format=geojson "$ROOT/public/data/boroughs.geojson"
rm -rf "$TMP"
