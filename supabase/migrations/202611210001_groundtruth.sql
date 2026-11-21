-- GroundTruth's Python backend owns writes. No keys or unrestricted tables in the browser.
create table public.gt_model_versions (
  id text primary key,
  report jsonb not null,
  created_at timestamptz not null default now()
);
create table public.gt_streets (
  id integer primary key,
  name text not null,
  town text not null,
  geometry jsonb not null
);
create index gt_streets_name_idx on public.gt_streets (lower(name));
create table public.gt_prediction_runs (
  id uuid primary key,
  model_id text not null references public.gt_model_versions(id),
  source text not null check (source in ('ask', 'simulation')),
  scenario_date date,
  rain_72h_mm double precision not null check (rain_72h_mm between 0 and 400),
  api_mm double precision not null check (api_mm between 0 and 280),
  calibrated boolean not null default false check (calibrated = false),
  created_at timestamptz not null
);
create table public.gt_predictions (
  run_id uuid not null references public.gt_prediction_runs(id) on delete cascade,
  street_id integer not null references public.gt_streets(id),
  score double precision not null check (score between 0 and 100),
  details jsonb not null,
  primary key (run_id, street_id)
);
create index gt_prediction_runs_recent_idx on public.gt_prediction_runs (created_at desc);
create index gt_predictions_street_idx on public.gt_predictions (street_id, run_id);
alter table public.gt_model_versions enable row level security;
alter table public.gt_streets enable row level security;
alter table public.gt_prediction_runs enable row level security;
alter table public.gt_predictions enable row level security;
revoke all on public.gt_model_versions, public.gt_streets, public.gt_prediction_runs, public.gt_predictions from anon, authenticated;
grant select, insert, update on public.gt_model_versions, public.gt_streets, public.gt_prediction_runs, public.gt_predictions to service_role;
