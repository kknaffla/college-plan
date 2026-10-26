-- 003: profile builder — snapshot, Common App activities, honors, essay tracker, recommenders.
-- Idempotent; safe to re-run. Stores no essay text, test logins, or financial data.

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
