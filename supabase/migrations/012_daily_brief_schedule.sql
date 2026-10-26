-- 012: run the daily-brief Edge Function every morning. Idempotent.
-- pg_cron runs in UTC, so it calls at 11:00 and 12:00 UTC; the function only sends when it is
-- send_hour (7 AM) in America/Detroit and it hasn't sent today, which covers daylight saving time.
-- 30-second timeout: the first call after a deploy can take more than pg_net's 5-second default.
-- The anon key below is the same public key that is in site/config.js. The brief key never leaves the database.
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule(jobid) from cron.job where jobname in ('daily-brief-11utc', 'daily-brief-12utc');
select cron.schedule(j.name, j.spec, $job$
  select net.http_post(
    url := 'https://qienshgabtzngzerjkrl.supabase.co/functions/v1/daily-brief',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpZW5zaGdhYnR6bmd6ZXJqa3JsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI5NzEwMTcsImV4cCI6MjEwODU0NzAxN30.a9Zl9-mnnt05rianl0BIRynjwnsB_pw1veCFL_A5dpY',
      'x-brief-key', (select token from public.daily_brief where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000)
$job$)
from (values ('daily-brief-11utc', '0 11 * * *'), ('daily-brief-12utc', '0 12 * * *')) as j(name, spec);
