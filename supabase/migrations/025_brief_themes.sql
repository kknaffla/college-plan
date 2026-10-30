-- 025: themes for the Knaffla Brief. Idempotent.
-- A theme covers a week (starts Monday) or a single day (start = end). The family sets a theme name on the calendar page;
-- a weekly Claude job fills the daily items, or picks a theme itself from the season and family dates.
-- Family members read and write rows; the job writes through brief_theme_push, gated by the money sync key.
create table if not exists public.brief_themes (
  id          uuid primary key default gen_random_uuid(),
  start_date  date not null,
  end_date    date not null,
  theme_name  text not null check (char_length(theme_name) between 1 and 80),
  notes       text,                                     -- what the family wants, e.g. "Picard week, Lily's idea"
  tagline     text,
  emoji       text,
  color1      text check (color1 is null or color1 ~ '^#[0-9a-fA-F]{6}$'),
  color2      text check (color2 is null or color2 ~ '^#[0-9a-fA-F]{6}$'),
  signoff     text,
  items       jsonb not null default '[]'::jsonb,       -- [{date, kind: quote|fact|challenge, text, by, link, link_label}]
  set_by      text not null default 'Family',           -- Family or Claude
  filled_at   timestamptz,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  check (end_date >= start_date and end_date - start_date <= 13)
);
create index if not exists brief_themes_dates on public.brief_themes (start_date, end_date);
alter table public.brief_themes enable row level security;
drop policy if exists family_all on public.brief_themes;
create policy family_all on public.brief_themes for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists stamp_brief_themes on public.brief_themes;
create trigger stamp_brief_themes before insert or update on public.brief_themes for each row execute function public.stamp_row();
revoke all on public.brief_themes from anon;
grant select, insert, update, delete on public.brief_themes to authenticated;

-- For the weekly job: read what's planned for a window (themes plus family dates and trips), keyed.
create or replace function public.brief_theme_get(key text, from_date date, to_date date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  select token into tok from public.money_sync where id = 1;
  if key is null or tok is null or key <> tok then raise exception 'Not found'; end if;
  return jsonb_build_object(
    'themes', coalesce((select jsonb_agg(to_jsonb(t) order by t.start_date) from public.brief_themes t where t.end_date >= from_date and t.start_date <= to_date), '[]'::jsonb),
    'dates', coalesce((select jsonb_agg(jsonb_build_object('title', d.title, 'kind', d.kind, 'on_date', d.on_date, 'end_date', d.end_date, 'month', d.month, 'day', d.day)) from public.family_dates d
                       where (d.on_date is not null and coalesce(d.end_date, d.on_date) >= from_date and d.on_date <= to_date) or d.kind = 'Birthday'), '[]'::jsonb),
    'trips', coalesce((select jsonb_agg(jsonb_build_object('name', p.name, 'destination', p.destination, 'start_date', p.start_date, 'end_date', p.end_date)) from public.trips p
                       where p.end_date >= from_date and p.start_date <= to_date and p.status not in ('Cancelled', 'Idea')), '[]'::jsonb));
end $$;
revoke all on function public.brief_theme_get(text, date, date) from public;
grant execute on function public.brief_theme_get(text, date, date) to anon, authenticated;

-- For the weekly job: fill a theme (by id) or create one Claude picked. Never deletes; never changes a family-set name.
create or replace function public.brief_theme_push(key text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tok text; rid uuid;
begin
  select token into tok from public.money_sync where id = 1;
  if key is null or tok is null or key <> tok then raise exception 'Not found'; end if;
  if jsonb_typeof(payload->'items') <> 'array' or jsonb_array_length(payload->'items') > 14 then raise exception 'Bad items'; end if;
  rid := nullif(payload->>'id', '')::uuid;
  if rid is not null then
    update public.brief_themes set tagline = left(payload->>'tagline', 140), emoji = left(payload->>'emoji', 8), color1 = payload->>'color1', color2 = payload->>'color2',
      signoff = left(payload->>'signoff', 120), items = payload->'items', filled_at = now() where id = rid;
  else
    insert into public.brief_themes (start_date, end_date, theme_name, notes, tagline, emoji, color1, color2, signoff, items, set_by, filled_at)
    values ((payload->>'start_date')::date, (payload->>'end_date')::date, left(payload->>'theme_name', 80), left(payload->>'notes', 300), left(payload->>'tagline', 140),
            left(payload->>'emoji', 8), payload->>'color1', payload->>'color2', left(payload->>'signoff', 120), payload->'items', 'Claude', now())
    returning id into rid;
  end if;
  return jsonb_build_object('id', rid, 'saved', true);
end $$;
revoke all on function public.brief_theme_push(text, jsonb) from public;
grant execute on function public.brief_theme_push(text, jsonb) to anon, authenticated;
select 'brief_themes ready' as status;
