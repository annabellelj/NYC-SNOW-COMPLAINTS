from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
TYPES = {2016: "Snow", 2026: "Snow or Ice"}

for year, category in TYPES.items():
    raw = pd.read_csv(ROOT / f"snow_complaints_{year}_raw.csv", dtype=str, keep_default_na=False)
    if (raw.unique_key.str.strip() == "").any() or not raw.unique_key.is_unique:
        raise ValueError(f"[{year}] missing or repeated request ID")
    clean = raw[raw.complaint_type == category].copy()
    clean.to_csv(ROOT / f"snow_complaints_{year}_clean.csv", index=False)
    print(f"[{year}] {len(raw)} source records; {len(clean)} selected requests")
