-- Competitive Benchmarker: lead + result table (T031)
-- Lives in the existing online-report-card Supabase project (shared with T028/T030),
-- so SUPABASE_URL and SUPABASE_SERVICE_KEY are already valid. Already applied live.

create table if not exists benchmark_reports (
  id          bigint generated always as identity primary key,
  created_at  timestamptz default now(),
  full_name   text not null,
  email       text not null,
  sport       text,
  event_key   text,
  gender      text,
  metric_raw  text,
  grad_year   int,
  verdict     text,
  report      jsonb,          -- full card the page renders
  ip          text,           -- used only for rate limiting
  token       text unique     -- unguessable id for the shareable /report.html page
);

create index if not exists benchmark_created_idx on benchmark_reports (created_at desc);
create index if not exists benchmark_cache_idx   on benchmark_reports (email, sport, event_key, metric_raw, created_at desc);
create index if not exists benchmark_ip_idx      on benchmark_reports (ip, created_at desc);

-- Lock the table down. The server uses the service-role key, which bypasses RLS.
alter table benchmark_reports enable row level security;
