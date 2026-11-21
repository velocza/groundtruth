# Lamorinda flood score (real data only)

Built by `python3 scripts/13_flood_lamorinda.py` from `dataset/flood_raw/`:
- FEMA National Flood Hazard Layer, layer 28 Flood Hazard Zones (hazards.fema.gov, fetched 2026-11-21 through the browser; blocked from the cloud machine)
- USGS NHD flowlines, large scale (hydro.nationalmap.gov, same route); aqueducts and canals dropped
- NOAA NCEI Storm Events 1996-2026, Contra Costa / Alameda flood, flash flood, heavy rain and debris flow rows (checks only)
- the map grid's USGS 3DEP elevation and NOAA GHCN gauge rain

Not trained: weights are set by hand. Lamorinda has 18 NOAA flood records that mention Lafayette, Orinda or Moraga or fall in the map, 13 with a position in the map.
Checks (thin): 11 of 13 located reports fall on ground scored Elevated or High (best cell within about 100 m; NOAA positions are approximate and some repeat the same point);
a report spot outscores a random spot 7.4 times in 10. All 11 dated local floods since 2015 followed 22 to 73 mm of rain in 3 days (top 9% of days).
Site file: `site/data/flood_lamorinda.js`, read by `site/js/floodl.js` (address answer, Ask, map flood view).
