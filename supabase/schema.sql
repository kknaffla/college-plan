-- =====================================================================
-- Lily's College Dashboard — database schema + security rules
-- Run once in Supabase: SQL Editor → New query → paste → Run.
-- Safe to re-run.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Family members: the ONLY accounts that can see or change any data.
-- Added by the parent in the SQL editor (README step 5). The app itself
-- cannot add or change members.
-- ---------------------------------------------------------------------
create table if not exists public.members (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  role         text not null check (role in ('parent','student')),
  created_at   timestamptz not null default now()
);

create or replace function public.is_member()
returns boolean
language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.members where user_id = auth.uid()); $$;

-- ---------------------------------------------------------------------
create table if not exists public.colleges (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  program       text,
  route         text,
  plan          text not null default 'Undecided'
                check (plan in ('EA','ED','RD','Rolling','Undecided')),
  deadline      date,
  deadline_time text,
  app_url       text,
  source_url    text,
  verified_on   date,
  status        text not null default 'Researching'
                check (status in ('Researching','Planning','In progress','Submitted','Complete','Admitted','Waitlisted','Denied','Not applying')),
  priority      int  not null default 5,
  submitted_on  date,
  receipt_note  text,
  notes         text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  college_id  uuid references public.colleges(id) on delete set null,
  category    text not null default 'Admissions'
              check (category in ('Admissions','School materials','Essays','Scholarship','Financial aid','Research','Other')),
  due_date    date,
  due_time    text,
  owner       text not null default 'Lily' check (owner in ('Lily','Parent','Both')),
  status      text not null default 'Not started'
              check (status in ('Not started','In progress','Waiting on others','Submitted','Done')),
  priority    int  not null default 3,
  checklist   jsonb not null default '[]'::jsonb,
  blocker     text,
  notes       text,
  source_url  text,
  verified_on date,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists public.scholarships (
  id            uuid primary key default gen_random_uuid(),
  sponsor       text,
  name          text not null,
  college_id    uuid references public.colleges(id) on delete set null,
  eligibility   text,
  amount        text,
  renewable     boolean,
  deadline      date,
  deadline_time text,
  requirements  text,
  link          text,
  verified_on   date,
  status        text not null default 'Researching'
                check (status in ('Researching','Planning','In progress','Submitted','Awarded','Not awarded','Not pursuing')),
  next_action   text,
  notes         text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

create table if not exists public.profile_facts (
  id          uuid primary key default gen_random_uuid(),
  section     text not null,
  fact        text not null,
  verified    boolean not null default false,
  notes       text,
  sort        int not null default 100,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- ---------------------------------------------------------------------
-- Server-side "who changed it, when" stamp
-- ---------------------------------------------------------------------
create table if not exists public.visits (
  id          uuid primary key default gen_random_uuid(),
  college_id  uuid references public.colleges(id) on delete set null,
  visit_date  date,
  kind        text not null default 'Campus tour'
              check (kind in ('Campus tour','Admitted-student day','Info session','Virtual','Interview','Other')),
  who         text,
  rating      int check (rating between 1 and 5),
  impressions text,
  pros        text,
  cons        text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists public.aid_offers (
  id                 uuid primary key default gen_random_uuid(),
  college_id         uuid not null references public.colleges(id) on delete cascade,
  kind               text not null default 'Estimate' check (kind in ('Estimate','Offer')),
  academic_year      text not null default '2027-28',
  cost_of_attendance numeric(10,2),
  grants             numeric(10,2),
  scholarships       numeric(10,2),
  loans              numeric(10,2),
  work_study         numeric(10,2),
  received_on        date,
  renewable_note     text,
  notes              text,
  updated_at         timestamptz not null default now(),
  updated_by         uuid,
  unique (college_id, kind)
);

create or replace function public.stamp_row()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['colleges','tasks','scholarships','profile_facts','visits','aid_offers'] loop
    execute format('drop trigger if exists stamp_%1$s on public.%1$s', t);
    execute format('create trigger stamp_%1$s before insert or update on public.%1$s
                    for each row execute function public.stamp_row()', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- Row Level Security — enforced by the database, not the UI.
-- Signed-in accounts that are NOT in members see nothing, change nothing.
-- ---------------------------------------------------------------------
alter table public.members       enable row level security;
alter table public.colleges      enable row level security;
alter table public.tasks         enable row level security;
alter table public.scholarships  enable row level security;
alter table public.profile_facts enable row level security;
alter table public.visits        enable row level security;
alter table public.aid_offers    enable row level security;

drop policy if exists members_read on public.members;
create policy members_read on public.members
  for select to authenticated using (public.is_member());

do $$
declare t text;
begin
  foreach t in array array['colleges','tasks','scholarships','profile_facts','visits','aid_offers'] loop
    execute format('drop policy if exists family_all on public.%I', t);
    execute format('create policy family_all on public.%I for all to authenticated
                    using (public.is_member()) with check (public.is_member())', t);
  end loop;
end $$;

revoke all on public.members, public.colleges, public.tasks, public.scholarships, public.profile_facts, public.visits, public.aid_offers from anon;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.colleges, public.tasks, public.scholarships, public.profile_facts, public.visits, public.aid_offers to authenticated;

-- ---------------------------------------------------------------------
-- Live sync between devices
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['colleges','tasks','scholarships','profile_facts','visits','aid_offers'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

-- Calendar feed key (also in migrations/002_calendar_feed.sql)
create table if not exists public.calendar_feed (
  id         int primary key default 1 check (id = 1),
  token      text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  rotated_at timestamptz not null default now()
);
insert into public.calendar_feed (id) values (1) on conflict (id) do nothing;
alter table public.calendar_feed enable row level security;
drop policy if exists family_read on public.calendar_feed;
create policy family_read on public.calendar_feed for select to authenticated using (public.is_member());
revoke all on public.calendar_feed from anon, authenticated;
grant select on public.calendar_feed to authenticated;
create or replace function public.rotate_calendar_token()
returns text language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  update public.calendar_feed
     set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), rotated_at = now()
   where id = 1
  returning token into t;
  return t;
end $$;
revoke all on function public.rotate_calendar_token() from public, anon;
grant execute on function public.rotate_calendar_token() to authenticated;
