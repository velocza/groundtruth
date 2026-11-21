"""Pack the full real gauge record (Oct 2015 onward) for the site's hindcast: site/data/rainlong.js."""
import csv, json, sys, os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rows = list(csv.DictReader(open(f"{root}/dataset/rainfall_daily_lamorinda.csv")))
out = dict(start=rows[0]["date"], mm=[round(float(r["rain_mm_area_mean"]), 1) for r in rows], api=[round(float(r["api_mm_k0.92"]), 1) for r in rows])
open(f"{root}/site/data/rainlong.js", "w").write("window.GT_RAIN=" + json.dumps(out, separators=(",", ":")) + ";\n")
print(len(rows), "days from", out["start"], "to", rows[-1]["date"])
