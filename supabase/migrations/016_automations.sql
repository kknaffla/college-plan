-- 016: automations listed in More › Automations. Idempotent.
-- Mac jobs (Claude desktop scheduled tasks) write last_run_at/last_result when they finish, and the email sweep
-- applies any requested_cron (set from the app) to both Mac jobs on its next run.
-- The daily brief runs on Supabase: set_brief_hour() moves its two pg_cron calls (daylight and standard time).
create table if not exists public.automations (
  key            text primary key,
  label          text not null,
  runs_on        text not null check (runs_on in ('Server','Mac')),
  cron           text not null,
  requested_cron text check (requested_cron ~ '^0 [0-9]{1,2}(,[0-9]{1,2}){0,5} \* \* [0-6*]$'),
  requested_at   timestamptz,
  last_run_at    timestamptz,
  last_result    text,
  sort           int not null default 0,
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
alter table public.automations enable row level security;
drop policy if exists automations_read on public.automations;
create policy automations_read on public.automations for select to authenticated using (public.is_member());
drop policy if exists automations_request on public.automations;
create policy automations_request on public.automations for update to authenticated
  using (public.is_member() and runs_on = 'Mac') with check (public.is_member() and runs_on = 'Mac');
revoke all on public.automations from anon, authenticated;
grant select on public.automations to authenticated;
grant update (requested_cron, requested_at) on public.automations to authenticated;
drop trigger if exists stamp_automations on public.automations;
create trigger stamp_automations before insert or update on public.automations for each row execute function public.stamp_row();

insert into public.automations (key, label, runs_on, cron, sort) values
  ('daily-brief', 'Daily brief email', 'Server', '0 7 * * *', 1),
  ('college-email-sweep', 'Email sweep (emails to tasks, tidy-ups)', 'Mac', '0 6,12,17 * * *', 2),
  ('lily-scholarship-scan', 'Scholarship scan (report)', 'Mac', '0 7 * * 1', 3)
on conflict (key) do nothing;
update public.automations a set cron = format('0 %s * * *', d.send_hour), last_run_at = coalesce(a.last_run_at, d.last_sent_on::timestamptz + make_interval(hours => d.send_hour + 5)), last_result = coalesce(a.last_result, 'Sent')
  from public.daily_brief d where a.key = 'daily-brief' and d.id = 1;

-- The brief's own send records its run here.
create or replace function public.brief_sent() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.last_sent_on is distinct from old.last_sent_on then
    update public.automations set last_run_at = now(), last_result = 'Sent' where key = 'daily-brief';
  end if;
  return new;
end $$;
drop trigger if exists brief_sent on public.daily_brief;
create trigger brief_sent after update on public.daily_brief for each row execute function public.brief_sent();

-- Moves the brief to hour h (America/Detroit): one call for daylight time (UTC-4), one for standard time (UTC-5).
-- The function only sends when it is send_hour in Detroit, so the other call is a no-op.
create or replace function public.set_brief_hour(h int) returns void language plpgsql security definer set search_path = public as $$
declare cmd text;
begin
  if not public.is_member() and auth.uid() is not null then raise exception 'Not allowed'; end if;
  if h is null or h < 0 or h > 23 then raise exception 'Hour must be 0-23'; end if;
  select command into cmd from cron.job where jobname like 'daily-brief-%' order by jobid limit 1;
  if cmd is null then raise exception 'Daily brief job not found'; end if;
  perform cron.unschedule(jobid) from cron.job where jobname like 'daily-brief-%';
  perform cron.schedule('daily-brief-edt', format('0 %s * * *', (h + 4) % 24), cmd);
  perform cron.schedule('daily-brief-est', format('0 %s * * *', (h + 5) % 24), cmd);
  update public.daily_brief set send_hour = h where id = 1;
  update public.automations set cron = format('0 %s * * *', h) where key = 'daily-brief';
end $$;
revoke all on function public.set_brief_hour(int) from public, anon;
grant execute on function public.set_brief_hour(int) to authenticated;
-- Rename the existing 11/12 UTC jobs to the edt/est names (same times for 7 AM).
select public.set_brief_hour((select send_hour from public.daily_brief where id = 1));

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'automations') then
    alter publication supabase_realtime add table public.automations;
  end if;
end $$;
