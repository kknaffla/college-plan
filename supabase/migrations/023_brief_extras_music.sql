-- 023: Knaffla Brief extras (focus setting, weather places) and music follows. Idempotent.
-- Family members can read and change brief_settings; anyone can add an artist; each person follows or
-- unfollows only for themself. Other tables are untouched.
create table if not exists public.brief_settings (
  id          int primary key default 1 check (id = 1),
  lily_focus  text,                                   -- a college name, e.g. 'University of Michigan'
  places      jsonb not null default '[]'::jsonb,     -- fun weather places, one a day: [{name, lat, lon}]
  stars       jsonb not null default '[]'::jsonb,     -- celebrities for the "where the stars are" fun fact
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
insert into public.brief_settings (id, lily_focus, places, stars) values (1, 'University of Michigan',
  '[{"name":"Disney World, Orlando","lat":28.3852,"lon":-81.5639},{"name":"Rocky Mountain NP","lat":40.3772,"lon":-105.5217},{"name":"Yellowstone","lat":44.4605,"lon":-110.8281},{"name":"Oregon coast","lat":45.8918,"lon":-123.9615},{"name":"Big Sur, California","lat":36.2704,"lon":-121.8081},{"name":"Redwoods","lat":41.2132,"lon":-124.0046},{"name":"Destin, Florida","lat":30.3935,"lon":-86.4958}]'::jsonb,
  '["Taylor Swift","Noah Kahan"]'::jsonb)
on conflict (id) do nothing;
alter table public.brief_settings add column if not exists stars jsonb not null default '[]'::jsonb;

create table if not exists public.music_artists (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (char_length(name) between 1 and 80),
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create table if not exists public.music_follows (
  artist_id   uuid not null references public.music_artists(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (artist_id, user_id)
);
insert into public.music_artists (name) values ('Noah Kahan'), ('Rush'), ('Michael Franti'), ('John Denver'), ('Olivia Rodrigo')
on conflict (name) do nothing;

alter table public.brief_settings enable row level security;
alter table public.music_artists enable row level security;
alter table public.music_follows enable row level security;
drop policy if exists family_all on public.brief_settings;
create policy family_all on public.brief_settings for all to authenticated using (public.is_member()) with check (public.is_member());
drop policy if exists family_all on public.music_artists;
create policy family_all on public.music_artists for all to authenticated using (public.is_member()) with check (public.is_member());
drop policy if exists follows_read on public.music_follows;
create policy follows_read on public.music_follows for select to authenticated using (public.is_member());
drop policy if exists follows_own on public.music_follows;
create policy follows_own on public.music_follows for insert to authenticated with check (public.is_member() and user_id = auth.uid());
drop policy if exists follows_drop_own on public.music_follows;
create policy follows_drop_own on public.music_follows for delete to authenticated using (public.is_member() and user_id = auth.uid());
drop trigger if exists stamp_brief_settings on public.brief_settings;
create trigger stamp_brief_settings before insert or update on public.brief_settings for each row execute function public.stamp_row();
drop trigger if exists stamp_music_artists on public.music_artists;
create trigger stamp_music_artists before insert or update on public.music_artists for each row execute function public.stamp_row();
revoke all on public.brief_settings, public.music_artists, public.music_follows from anon;
grant select, insert, update, delete on public.brief_settings, public.music_artists to authenticated;
grant select, insert, delete on public.music_follows to authenticated;
select (select lily_focus from public.brief_settings where id = 1) as focus, (select count(*) from public.music_artists) as artists;
