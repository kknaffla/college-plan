-- 020: family trips (weekend events, spring break, summer vacations) — new tables only. Idempotent.
-- Every family member can read and change every trip (public.is_member()).
-- Lily's and Amy's tables, public.members and is_member() are untouched.
-- Options are hotels, restaurants and ideas still being weighed (title like "Hotel: …", "Dinner: …").
-- Bookings hold confirmation numbers only: never card numbers or passwords.

create table if not exists public.trips (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'Weekend' check (kind in ('Weekend','Spring break','Summer','Holiday','Other')),
  status      text not null default 'Planning' check (status in ('Idea','Planning','Booked','Done','Cancelled')),
  start_date  date,
  end_date    date,
  destination text,
  who         text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table if not exists public.trip_items (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references public.trips(id) on delete cascade,
  kind        text not null default 'Plan' check (kind in ('Plan','Option','Booking','To-do','Packing')),
  day         date,
  time_text   text,            -- "7:30 PM", "Morning", "Noon"
  title       text not null,
  place       text,
  confirmation text,           -- confirmation number only
  cost_est    numeric(10,2),
  cost_actual numeric(10,2),
  url         text,
  notes       text,
  done        boolean not null default false,  -- Booking: booked. To-do/Packing: done.
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
create index if not exists trip_items_trip on public.trip_items (trip_id);

do $$
declare t text;
begin
  foreach t in array array['trips','trip_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists family_all on public.%I', t);
    execute format('create policy family_all on public.%I for all to authenticated
                    using (public.is_member()) with check (public.is_member())', t);
    execute format('drop trigger if exists stamp_%1$s on public.%1$s', t);
    execute format('create trigger stamp_%1$s before insert or update on public.%1$s for each row execute function public.stamp_row()', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;
