# Storm response: San Francisco, November 18, 2026

How fast fire and EMS units reached calls during the November 18, 2026 storm, against dry days matched on weekday,
local hour and call type. Feeds the **Storm response** view (San Francisco area only). Everything here is real public data.

Built by `scripts/sf/09_storm_response_sf.py <raw dir>`, which also writes `site/data_sf/storm_response.js`.
Checked by `tests/stormresp_verify.py <raw dir>` (a second implementation from the raw rows, plus the page's own arithmetic).
Reruns are byte-identical.

## Sources

| Data | Source | Dates |
|---|---|---|
| Fire and EMS dispatch | DataSF, Fire Department and Emergency Medical Services Dispatched Calls for Service, dataset `nuek-vuh3` (one row per unit per call) | received 2025-09-01 to 2026-11-21 03:23 local, pulled 2026-11-21 |
| Neighborhoods | DataSF Analysis Neighborhoods, dataset `j2bu-swwd` (41 polygons) | pulled 2026-11-21 |
| Rain | Downtown gauge and SFO airport, `dataset_sf/rainfall_daily_san_francisco.csv` and `rainfall_hourly_sfo_airport.csv` | already in the repo |
| Flood reports | SF 311 Sewer / Flooding, `dataset_sf/flood_reports_311_san_francisco.csv` | already in the repo |

The raw monthly files (`gtsr_fire_YYYY-MM.csv.gz`, 15 files, 19 MB, and `gtsr_analysis_neighborhoods.geojson`) are not in the
repository. A copy is in the project files under `groundtruth/sf/raw_downloads/dispatch/`. data.sfgov.org is blocked from the
cloud build machine, so they were fetched in a browser, one month per file, with:

```
https://data.sfgov.org/resource/nuek-vuh3.csv?$select=incident_number,call_number,unit_id,call_type,call_type_group,received_dttm,
  entry_dttm,dispatch_dttm,response_dttm,on_scene_dttm,transport_dttm,hospital_dttm,available_dttm,call_final_disposition,
  original_priority,priority,final_priority,als_unit,unit_type,unit_sequence_in_call_dispatch,station_area,battalion,
  neighborhoods_analysis_boundaries,case_location
  &$where=received_dttm>='2026-10-01' and received_dttm<'2026-11-01'&$order=rowid&$limit=50000&$offset=0   (page until fewer than 50,000 rows)
https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=100
```

## Rules

- **Time zone.** DataSF stores local clock time (America/Los_Angeles) with no zone. Everything here is local clock time. An
  incident whose times fall in an hour that does not exist or repeats at a daylight saving change is dropped (103 of 225,262; none in the storm).
- **Storm window.** 2026-11-18 00:00 to 2026-11-19 12:00 local. The SFO gauge shows rain from 03:00 on the 18th through a second burst
  ending about 08:00 on the 19th; the downtown gauge logged 67.1 mm on the 18th, a record for the date.
- **Incident.** One `incident_number`. All its unit rows are grouped and it counts once, however many units went. Its type,
  neighborhood and position come from the first dispatched unit's row.
- **Response time.** `received_dttm` (call receipt) to the earliest `on_scene_dttm` of any unit. It includes call handling and driving.
- **Missing data.** Left out of times but counted: no unit recorded on scene, negative time, over 120 minutes. In the storm window:
  868 incidents, 813 timed, 55 with no unit on scene.
- **Dry day.** Downtown gauge, SFO gauge and the area mean all 0 mm that day and the two days before, 2025-09-01 to 2026-10-31.
  Days with no gauge reading are not dry. 202 dry days, 58 of them Wednesdays or Thursdays (the storm's weekdays).
- **Matching.** Each storm call is matched to dry-day calls with the same weekday, local hour of receipt and `call_type`. Dry calls
  are weighted so their mix of those cells equals the storm's. A storm call whose cell holds fewer than 3 dry calls is left out and counted.
- **Too few calls.** Fewer than 20 matched storm calls or 60 matched dry calls. Such comparisons are shown but flagged.
- **Percentiles.** Nearest rank (weighted on the dry side). The page uses the same rule for the scrubber.
- **Intervals.** 90% bootstrap, 1,000 draws, fixed seed: storm calls resampled one by one, dry calls by whole day.
- **Priority.** All priorities are included (storm window: 543 final priority 3, 325 priority 2); matching is on call type only.

## Results

Whole city: median 7.8 minutes in the storm against 7.8 on matched dry days (change +0.1, interval -0.3 to +0.4); 90th percentile
21.9 against 22.3. Response times did not measurably change during the storm. 7 of 41 neighborhoods have enough calls to compare;
among them, more flood reports did not go with longer waits (rank correlation -0.50), an observation from a very small sample.

## Planning scenario: one extra ambulance

Shown only because the drive-time model passed its check on held-out real arrivals.

- Station positions are not published on DataSF. Each is estimated as the median position of the 5% quickest arrivals of that
  station's own engine (E07 is Station 7), September 2025 to August 2026. Good to a few hundred metres.
- Drive time = median en-route-to-on-scene time of engines answering calls in their own station area, by street-grid distance
  in 250 m bands, fitted on September 2025 to August 2026.
- Check on October 2026 (not fitted on), 6,374 arrivals: median absolute error 0.63 min, median signed error -0.03 min, 90% within
  2.15 min. In the storm window (354 arrivals): 0.65 min, -0.23 min. Pass rule: error at most 1.0 min and bias at most 0.5 min.
- The extra ambulance answers only medical calls in its own first-due area, rolls 1.3 minutes (median engine turnout) after the
  real first dispatch, counts only if it beats the first unit that really arrived, then stays busy 68 minutes (median ambulance
  on-scene to available) plus the drive back. Everything else happens as it really did. It ignores traffic, flooding on the
  road and how dispatchers would really use the unit, so read it as a rough ceiling.

## Files

| File | What it is |
|---|---|
| `summary.json` | Every rule, count and comparison, plus the scenario check. |
| `comparison_by_neighborhood.csv` | Storm vs matched dry days for the city and each of the 41 neighborhoods. |
| `comparison_by_type.csv` | The same by call type, whole city. |
| `incidents_nov17_20_2026.csv` | Every incident received 17 to 20 November 2026, one row each, with its response time and status. |
| `dry_days.csv` | The dry days and whether they fell on the storm's weekdays. |
