-- 024: school days off, half days and holidays in family_dates. Idempotent.
-- Adds an end date for ranges (e.g. Thanksgiving break) and the kinds 'No school', 'Half day', 'Holiday'.
-- Titles may now repeat on different dates, so the title-only unique index is replaced. Other tables are untouched.
alter table public.family_dates add column if not exists end_date date;
alter table public.family_dates add column if not exists source text;            -- e.g. 'MAS 2026-27', 'Kevin'
alter table public.family_dates drop constraint if exists family_dates_kind_check;
alter table public.family_dates add constraint family_dates_kind_check check (kind in ('Birthday','Anniversary','Event','No school','Half day','Holiday'));
alter table public.family_dates drop constraint if exists family_dates_end_check;
alter table public.family_dates add constraint family_dates_end_check check (end_date is null or (on_date is not null and end_date >= on_date));
drop index if exists public.family_dates_title;
create unique index if not exists family_dates_once on public.family_dates (title, coalesce(on_date, date '1900-01-01'), coalesce(month, 0), coalesce(day, 0));
select 'family_dates ready' as status, (select count(*) from public.family_dates) as rows;
