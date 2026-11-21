# GroundTruth backend

Browser Ask → Python inference API → durable local outbox → Supabase Postgres.
The repository-only GBM runs on the laptop. Supabase stores model versions, street
geometry, scenario runs and prediction details. No new training data is added.

## Connect the cloud project

1. Create a Supabase project named `groundtruth` in the intended organization.
2. Apply `migrations/202611210001_groundtruth.sql` once using Supabase migrations
   or SQL editor. All four tables have RLS and no anonymous/authenticated grants.
3. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the server environment or the
   ignored root `.env` file (copy `.env.example`). Legacy
   `SUPABASE_SERVICE_ROLE_KEY` also works. Never put keys inside `site/`.
4. Restart `python serve_local.py`. It seeds the model hash and repository streets,
   then uploads queued predictions. `/api/backend` shows connection/queue status.

New secret keys use `apikey`; legacy JWT service-role keys also use Bearer.
See [Supabase keys](https://supabase.com/docs/guides/api/api-keys) and
[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

Without configuration the UI explicitly says Supabase is not connected. History
works locally; this is not a Supabase emulator. Failed writes remain in ignored
`runtime/predictions.sqlite3` and retry with the same UUID to avoid duplicates.
History is served from this laptop's local mirror; Supabase stores the cloud copy.

## Loopback API

POST requires the app's own Origin header. No cloud secrets reach the browser.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/backend` | Connection, queue, model status |
| `GET /api/model` | Model hash and evaluation report |
| `GET /api/streets?q=Miner` | Up to 20 street matches |
| `POST /api/predict` | Score one street and save its result |
| `GET /api/predictions?street_id=123&limit=20` | Recent locally mirrored runs |
| `GET /api/simulation` | Historical playback state |

Prediction JSON: `{"street_id":123,"rain_72h_mm":100,"api_mm":120}`.
Returns the score, two rain scenarios, counterfactual explanations, model hash and
run UUID. Ranking and terrain runout still run in-browser; individual street
reports prefer Python, with an explicit browser fallback when unavailable.

This is a laptop backend. Public hosting would need authenticated API access,
per-user authorization and request limits. No public database access is enabled.
Scores remain experimental and uncalibrated.
