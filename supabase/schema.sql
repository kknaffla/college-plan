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
              check (category in ('Admissions','School materials','Essays','Scholarship','Financial aid','Research','Senior year','Other')),
  due_date    date,
  due_time    text,
  owner       text not null default 'Lily' check (owner in ('Lily','Parent','Both')),
  status      text not null default 'Not started'
              check (status in ('Not started','In progress','Waiting on others','Submitted','Done','Not needed')),
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

-- ===== from migrations/003_profile_builder.sql =====

create table if not exists public.student_profile (
  id             int primary key default 1 check (id = 1),
  student_name   text,
  high_school    text,
  city           text,
  grad_year      int,
  intended_major text,
  gpa_weighted   text,
  gpa_unweighted text,
  class_rank     text,
  sat            text,
  act            text,
  dual_credits   text,
  stats_verified boolean not null default false,
  headline       text,
  notes          text,
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);

create table if not exists public.activities (
  id               uuid primary key default gen_random_uuid(),
  sort             int  not null default 100,
  activity_type    text,
  position         text check (char_length(position) <= 50),
  organization     text check (char_length(organization) <= 100),
  description      text check (char_length(description) <= 150),
  grades           text,
  timing           text check (timing in ('School year','School breaks','All year')),
  hours_per_week   numeric(5,1),
  weeks_per_year   numeric(4,1),
  continue_college boolean,
  verified         boolean not null default false,
  notes            text,
  updated_at       timestamptz not null default now(),
  updated_by       uuid
);

create table if not exists public.honors (
  id         uuid primary key default gen_random_uuid(),
  sort       int  not null default 100,
  title      text not null check (char_length(title) <= 100),
  grades     text,
  level      text check (level in ('School','State/Regional','National','International')),
  verified   boolean not null default false,
  notes      text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

create table if not exists public.essays (
  id          uuid primary key default gen_random_uuid(),
  college_id  uuid references public.colleges(id) on delete set null,
  title       text not null,
  prompt      text,
  word_limit  int,
  word_count  int,
  status      text not null default 'Not started'
              check (status in ('Not started','Brainstorming','Drafting','Revising','Final','Submitted')),
  due_date    date,
  draft_url   text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists public.recommenders (
  id         uuid primary key default gen_random_uuid(),
  name       text,
  role       text not null default 'Teacher' check (role in ('Teacher','Counselor','Coach','Employer','Other')),
  subject    text,
  for_what   text,
  asked_on   date,
  status     text not null default 'To ask' check (status in ('To ask','Asked','Agreed','Submitted','Thanked')),
  notes      text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

do $$
declare t text;
begin
  foreach t in array array['student_profile','activities','honors','essays','recommenders'] loop
    execute format('drop trigger if exists stamp_%1$s on public.%1$s', t);
    execute format('create trigger stamp_%1$s before insert or update on public.%1$s
                    for each row execute function public.stamp_row()', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists family_all on public.%I', t);
    execute format('create policy family_all on public.%I for all to authenticated
                    using (public.is_member()) with check (public.is_member())', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ===== from migrations/004_documents.sql =====

create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    text not null default 'Other'
              check (category in ('Essays','Transcripts & scores','Resume & activities','Awards & certificates',
                                  'Recommendations','Application receipts','Admission letters','Scholarships',
                                  'Visits & photos','Other')),
  college_id  uuid references public.colleges(id) on delete set null,
  file_path   text,            -- object path in the 'documents' bucket, or null for a link
  link_url    text,            -- e.g. a Google Doc or OneDrive link instead of a file
  file_name   text,
  mime_type   text,
  size_bytes  bigint,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  check (file_path is not null or link_url is not null)
);

do $$
begin
  execute 'drop trigger if exists stamp_documents on public.documents';
  execute 'create trigger stamp_documents before insert or update on public.documents for each row execute function public.stamp_row()';
  execute 'alter table public.documents enable row level security';
  execute 'drop policy if exists family_all on public.documents';
  execute 'create policy family_all on public.documents for all to authenticated using (public.is_member()) with check (public.is_member())';
  execute 'revoke all on public.documents from anon';
  execute 'grant select, insert, update, delete on public.documents to authenticated';
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents') then
    execute 'alter publication supabase_realtime add table public.documents';
  end if;
end $$;

-- Private bucket, 25 MB per file, common document/image types only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 26214400,
        array['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists family_docs_select on storage.objects;
drop policy if exists family_docs_insert on storage.objects;
drop policy if exists family_docs_update on storage.objects;
drop policy if exists family_docs_delete on storage.objects;
create policy family_docs_select on storage.objects for select to authenticated using (bucket_id = 'documents' and public.is_member());
create policy family_docs_insert on storage.objects for insert to authenticated with check (bucket_id = 'documents' and public.is_member());
create policy family_docs_update on storage.objects for update to authenticated using (bucket_id = 'documents' and public.is_member()) with check (bucket_id = 'documents' and public.is_member());
create policy family_docs_delete on storage.objects for delete to authenticated using (bucket_id = 'documents' and public.is_member());

-- ===== from migrations/005_profile_tiles.sql =====
alter table public.student_profile add column if not exists tiles jsonb;

-- ===== from migrations/006_scholarship_scope.sql =====
alter table public.scholarships add column if not exists scope text;

-- ===== from migrations/007_application_parts.sql =====
alter table public.colleges add column if not exists app_parts jsonb;

-- ===== from migrations/008_college_facts.sql =====
alter table public.colleges add column if not exists facts jsonb;

-- Quick-add key (also in migrations/010_quick_add.sql)
create table if not exists public.quick_add (
  id         int primary key default 1 check (id = 1),
  token      text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  rotated_at timestamptz not null default now()
);
insert into public.quick_add (id) values (1) on conflict (id) do nothing;

alter table public.quick_add enable row level security;
drop policy if exists family_read on public.quick_add;
create policy family_read on public.quick_add for select to authenticated using (public.is_member());
revoke all on public.quick_add from anon, authenticated;
grant select on public.quick_add to authenticated;

create or replace function public.rotate_quick_add_key()
returns text language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not public.is_member() then raise exception 'not allowed'; end if;
  update public.quick_add
     set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), rotated_at = now()
   where id = 1
  returning token into t;
  return t;
end $$;
revoke all on function public.rotate_quick_add_key() from public, anon;
grant execute on function public.rotate_quick_add_key() to authenticated;

-- Daily brief settings (also in migrations/011_daily_brief.sql; schedule in 012)
create table if not exists public.daily_brief (
  id             int primary key default 1 check (id = 1),
  token          text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  recipients     text[] not null default '{}',
  test_recipient text,
  send_hour      int not null default 7 check (send_hour between 0 and 23),
  enabled        boolean not null default false,
  last_sent_on   date
);
insert into public.daily_brief (id) values (1) on conflict (id) do nothing;
alter table public.daily_brief enable row level security;
revoke all on public.daily_brief from anon, authenticated;

-- Senior year (also in migrations/013_senior_year.sql)
alter table public.student_profile add column if not exists grad_date  date;
alter table public.student_profile add column if not exists grad_time  text;
alter table public.student_profile add column if not exists grad_place text;

-- Events (also in migrations/014_task_events.sql)
alter table public.tasks add column if not exists is_event boolean not null default false;

-- 015: application fees
alter table public.colleges add column if not exists app_fee numeric;
alter table public.colleges add column if not exists fee_note text;

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
