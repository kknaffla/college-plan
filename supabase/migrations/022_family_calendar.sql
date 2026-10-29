-- 022: iCloud Family calendar copy for the family calendar page. Idempotent.
-- A sweep on Kevin's Mac reads the iCloud "Family" calendar (read only) and posts upcoming events here through
-- calendar_sync_push, gated by the same sync key as the money sync (public.money_sync.token).
-- Family members can only read these rows; adding or deleting events happens in the iPhone Family calendar.
create table if not exists public.calendar_events (
  uid        text primary key,              -- iCloud event id plus the occurrence start
  title      text not null,
  day        date not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz,
  all_day    boolean not null default false,
  location   text,
  source     text not null default 'iCloud Family',
  swept_at   timestamptz not null default now()
);
create index if not exists calendar_events_day on public.calendar_events (day);
alter table public.calendar_events enable row level security;
drop policy if exists family_read on public.calendar_events;
create policy family_read on public.calendar_events for select to authenticated using (public.is_member());
revoke all on public.calendar_events from anon, authenticated;
grant select on public.calendar_events to authenticated;

-- Replaces every event in the payload's window with the payload's events, so deletes on the iPhone drop off too.
create or replace function public.calendar_sync_push(key text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tok text; f date; t date; n_del int; n_ins int;
begin
  select token into tok from public.money_sync where id = 1;
  if key is null or tok is null or key <> tok then raise exception 'Not found'; end if;
  f := (payload->>'from')::date; t := (payload->>'to')::date;
  if f is null or t is null or t < f or t - f > 400 then raise exception 'Bad window'; end if;
  delete from public.calendar_events where source = 'iCloud Family' and day between f and t;
  get diagnostics n_del = row_count;
  insert into public.calendar_events (uid, title, day, starts_at, ends_at, all_day, location, source, swept_at)
  select e->>'uid', left(coalesce(nullif(e->>'title', ''), '(no title)'), 200), (e->>'day')::date, (e->>'starts_at')::timestamptz,
         nullif(e->>'ends_at', '')::timestamptz, coalesce((e->>'all_day')::boolean, false), left(nullif(e->>'location', ''), 200), 'iCloud Family', now()
  from jsonb_array_elements(coalesce(payload->'events', '[]'::jsonb)) e
  where (e->>'day')::date between f and t
  on conflict (uid) do update set title = excluded.title, day = excluded.day, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
    all_day = excluded.all_day, location = excluded.location, swept_at = now();
  get diagnostics n_ins = row_count;
  return jsonb_build_object('removed', n_del, 'saved', n_ins, 'window', f || ' to ' || t);
end $$;
revoke all on function public.calendar_sync_push(text, jsonb) from public;
grant execute on function public.calendar_sync_push(text, jsonb) to anon, authenticated;
select 'calendar ready' as status, (select count(*) from public.calendar_events) as events;
