#!/usr/bin/env python3
"""Add title-aware CustomRTCValue hex values to a startup-seed CSV."""
import csv
import json
import sys
from pathlib import Path

csv_path, mapping_path = map(Path, sys.argv[1:])
payload = json.loads(mapping_path.read_text())
rtc = {}
for row in payload["results"]:
    values = row.get("rtc_values", [])
    rtc[row["seed_hex"].lower()] = values[0]["hex"] if values else "N/A"

rows = list(csv.DictReader(csv_path.open(newline="")))
for row in rows:
    row.pop("custom_rtc", None)
    row["custom_rtc_hex"] = rtc.get(row["seed_hex"].lower(), "N/A")
with csv_path.open("w", newline="") as out:
    writer = csv.DictWriter(out, fieldnames=[*rows[0].keys()])
    writer.writeheader()
    writer.writerows(rows)
