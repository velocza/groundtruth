# GroundTruth dataset: San Francisco

Same grid shape (480 columns x 456 rows, about 29 m), same file layout and same feature definitions as `dataset/`
(Lamorinda). Box: west -122.520, east -122.360, south 37.705, north 37.825. Row 0 is the north edge, column 0 the west edge.

**Everything here is real.** There is no simulated ground motion for San Francisco. NASA OPERA DISP-S1 needs a NASA
Earthdata login to download, so it is left out.

Built 2026-11-21 by `scripts/sf/01_fetch_real.py`, `02_fetch_overture.py`, `03_build_sf.py`. To train with the existing
code, import `model/handoff_common_sf.py` in place of `handoff_common.py`: same functions, this box and this folder.

## Files

| File | What it is |
|---|---|
| `grid_480x456_all_layers.npz` | Every raster. The ten Lamorinda arrays under the same names (`dem`, `slope`, `aspect`, `plan_curv`, `prof_curv`, `twi`, `dist_stream`, `dist_road`, `ndvi_2023`, `ndvi_2026`), then extras: `land`, `relief`, flood terrain (`sink_depth`, `low_150`, `low_450`, `elev_above_min_300`, `log_flow_acc`, `dist_water`), buildings (`buildings_count`, `buildings_footprint_m2`, `built_frac`), `neighborhood_id`, and NDVI, NDMI and NDWI for more dates. |
| `meta.json` | Box, Sentinel-2 scene ids and dates, gauge names, neighbourhood names for `neighborhood_id`. |
| `rainfall_daily_san_francisco.csv` | Daily rain 2008-07-01 to 2026-11-20. First seven columns match `rainfall_daily_lamorinda.csv`. Then the downtown gauge, SFO airport, the wettest hour at SFO, ERA5 rain and soil moisture at three depths, and the number of city flood reports that day. |
| `rainfall_downtown_since_1921.csv` | The downtown gauge, every day since 1921. |
| `rainfall_hourly_sfo_airport.csv` | Hourly rain at SFO, October 2015 to 21 November 2026. |
| `storm_nov2026_hourly_model.csv` | Hourly rain, soil moisture and wind gusts, 7 October to 27 November 2026 (model analysis, forecast after 21 November noon). |
| `flood_reports_311_san_francisco.csv` | 31,478 flooding reports to the city (SF 311, Sewer / Flooding), July 2008 to 20 November 2026, with address, time, position and grid cell. |
| `landslide_events_san_francisco.csv` | 8 landslide records in the box: 6 from the USGS January 2023 reconnaissance inventory, 1 NWS storm report (2024), 1 dated state inventory point (1982). |
| `cgs_landslide_inventory_san_francisco.csv` | 12 mapped landslides from the California Geological Survey inventory (centroids, type, activity). |
| `nws_storm_reports_san_francisco.csv` | 382 NWS local storm reports in the city since 2008. |
| `nws_text_*.txt` | NWS text products for the November 2026 storm: record event reports, rainfall totals, storm reports, flood advisories, downtown climate reports. |
| `streets_san_francisco.csv`, `buildings_san_francisco.csv` | 1,817 named streets with neighbourhood, and 166,518 building footprints (centre, area, height where known). |
| `layer_*.png` | The rasters packed as images, same packing as Lamorinda. `layer_flood.png` is new: red = sink depth 0 to 5.1 m, green = dip against 450 m surroundings, blue = log drainage area. `layer_height.png` blue channel is the land mask. |
| `sentinel2_truecolor_<date>.jpg` | Nine cloud-free Sentinel-2 scenes: 2017-03-31, 2021-10-16, 2021-11-20, 2022-10-26, 2023-01-24, 2023-04-19, 2026-04-03, 2026-11-04, 2026-11-11. |

## The storm of November 2026

Downtown gauge: 24.6 mm on 13 November, 23.9 mm on 15 to 16 November, then 67.1 mm (2.64 in) on 18 November, a record
for the date (old record 2.24 in, 1918). 18 November drew 776 flood reports inside the box, the most of any day since
the record starts in 2008 (31 December 2022 is second: 560 filed, 333 of them with a position inside the box).
Every label from 1 November 2026 on is marked `test_nov2026_storm` in the workbook. The first Sentinel-2 pass after the
storm (19 November) was 95% cloud, so the latest clear image is 11 November.

No landslide inside the city was confirmed for this storm in the sources pulled (NWS storm reports through
19 November list flooding only).

## Sources

| Data | Source | Reachable from the cloud build machine? |
|---|---|---|
| Elevation | USGS 3DEP via AWS Terrain Tiles, zoom 13 | yes |
| Imagery | Sentinel-2 L2A cloud-optimised GeoTIFFs, tile 10SEG (AWS open data) | yes |
| Streets, buildings | Overture Maps release 2026-11-18.0 (AWS open data) | yes |
| Gauges | NOAA GHCN-Daily (AWS open data): downtown USW00023272, Oceanside USC00047767, seven CoCoRaHS gauges | yes |
| Downtown gauge 2008 on, SFO daily and hourly, NWS storm reports and text | Iowa Environmental Mesonet (mesonet.agron.iastate.edu) | no, fetched through a browser |
| Soil moisture, hourly model rain | ERA5 and ERA5-Land through Open-Meteo | no, browser |
| Flood reports | SF 311 cases, data.sfgov.org dataset vw6y-z8j6 | no, browser |
| Landslides 2023 | USGS, San Francisco Bay Area Reconnaissance Landslide Inventory, January 2023, doi.org/10.5066/P9NJ3KMG | no, browser |
| Mapped landslides | California Geological Survey Landslide Inventory (gis.conservation.ca.gov) | no, browser |

The four browser downloads are kept as `sf311_flooding.csv`, `gt_bundle_weather.json`, `gt_bundle_slides.json` and
`gt_bundle_usgs.json` (not in the repository: 53 MB). `03_build_sf.py` reads them from its second argument.

## Things to know before training

- San Francisco has almost no landslide labels (7 dated, none before October 2022). It cannot train a landslide model on
  its own. Use it to test one trained elsewhere. The six USGS points in the Lamorinda box and 158 more around the bay are
  in the same USGS file.
- Flooding is the hazard with labels here: 16,658 rain-day report cells. It is a different process from landsliding
  (low, flat, paved ground), so it wants its own model. `training_rows_flood` in the workbook is ready for that.
- 311 reports come from where people are and from people who choose to report. Absence of a report is not absence of water.
- After 14 November 2026 only the downtown gauge had reported at build time, so the area mean for the last six days is one gauge.
- The USGS inventory dates four Bernal Hill points 12/31/2023. The linked report is from 12/31/2022, so they are filed under 2022.

## Landslide training data (added 2026-11-21)

`scripts/sf/06_landslide_labels_sf.py` gathers every real landslide record found for the city and builds training rows in
the Lamorinda layout. Nothing is simulated.

| File | What it is |
|---|---|
| `dataset_sf/landslides/landslide_events_all_san_francisco.csv` | 18 records: 6 USGS (winter 2023), 4 NASA Global Landslide Catalog (2007, 2014, 2017 x2), 4 USGS map MF-2325-G (winter 1997-98, two with a day), 3 NWS storm reports (2023, 2024), 1 state inventory point (1982). |
| `dataset_sf/landslides/rainfall_daily_long_san_francisco.csv` | Daily rain since 1921 with the wetness index and trigger: downtown gauge alone before July 2008, city gauge mean after. |
| `dataset_sf/landslides/usgs1997_landslide_map_480x456.npz` | USGS Open-File Report 97-745 C landslide map on the grid (`lscat`: 8 mostly landslide, 6 few landslides, 3 surficial deposits, 2 water). 1,427 land cells are mostly landslide. Undated. |
| `dataset_sf/landslides/records_checked_and_left_out.csv` | Records and sources that were checked and not used, with the reason. |
| `dataset_sf/training/landslide_slides.csv.gz`, `landslide_training_rows.csv.gz`, `landslide_mapped_cells.csv.gz` | The workbook sheets: 18 slides, 11,358 rows (1,262 positive cells), and every land cell with its map class. |

Splits: 7 slides to train on (1982 to 2017), 7 in winter 2022-23 to test, 2 later, 2 with no exact day. Several positions
are good to 100 to 300 m only (see `precision` and `radius_m`). First check (gradient boosting from `model/gbm.py` fitted on
the train split, scored on the 9 later slides): AUC 0.86 overall, 0.76 where, 0.97 when; slope alone scores 0.77 on where.
The earlier `landslide_events_san_francisco.csv` and `training/slides.csv.gz` are kept unchanged because the site build reads them.

## Training tables in this repository

The full workbook (`groundtruth_sf_training_data.xlsx`, 100 MB) is over GitHub's file size limit, so its large sheets
are stored here as gzipped CSV files in `dataset_sf/training/`, with the same column names and order as the sheets:
`slides`, `training_rows`, `training_rows_flood`, `flood_days` and `cells` (all 218,880 cells). Read one with
`pandas.read_csv("dataset_sf/training/training_rows_flood.csv.gz")`. To rebuild the workbook, run
`python3 scripts/sf/04_export_training_data_sf.py . groundtruth_sf_training_data.xlsx`.
