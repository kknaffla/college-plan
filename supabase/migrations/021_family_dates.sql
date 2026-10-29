-- 021: family dates (birthdays and other yearly or one-time dates) for the Knaffla Family Daily Brief.
-- Idempotent. Data lives only in the database (seeded from a gitignored file), never in this public repo.
-- Every family member can read and change them (public.is_member()). Other tables are untouched.
create table if not exists public.family_dates (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,                 -- e.g. "Kevin's birthday"
  kind        text not null default 'Event' check (kind in ('Birthday','Anniversary','Event')),
  month       int check (month between 1 and 12),   -- yearly dates: month and day
  day         int check (day between 1 and 31),
  on_date     date,                          -- one-time dates
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  check ((month is not null and day is not null) or on_date is not null)
);
create unique index if not exists family_dates_title on public.family_dates (title);
alter table public.family_dates enable row level security;
drop policy if exists family_all on public.family_dates;
create policy family_all on public.family_dates for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists stamp_family_dates on public.family_dates;
create trigger stamp_family_dates before insert or update on public.family_dates for each row execute function public.stamp_row();
revoke all on public.family_dates from anon;
grant select, insert, update, delete on public.family_dates to authenticated;
