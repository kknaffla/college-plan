-- 017: Amy's college plan (class of 2029) — new tables only. Idempotent.
-- Lily's tables, policies and functions are untouched. Same access rule as the
-- college plan: only accounts on public.members can read or write.

create table if not exists public.amy_courses (
  id            uuid primary key default gen_random_uuid(),
  grade         int  not null check (grade between 9 and 12),
  term          text not null default 'Year' check (term in ('Year','Fall','Spring','Summer')),
  subject       text not null default 'Elective'
                check (subject in ('English','Math','Science','Social studies','World language','Arts','Business & tech','Health & PE','Personal finance','Elective')),
  title         text not null,
  level         text not null default 'Regular' check (level in ('Regular','Honors','AP','Dual enrollment','Online AP')),
  provider      text not null default 'Manistique High School',
  hs_credits    numeric(4,2) not null default 1,
  college_credits numeric(4,1) not null default 0,
  status        text not null default 'Planned' check (status in ('Idea','Planned','Enrolled','Done','Dropped')),
  final_grade   text,
  ap_score      int check (ap_score between 1 and 5),
  notes         text,
  sort          int not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

create table if not exists public.amy_tasks (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  grade       int  check (grade between 9 and 12),
  due_date    date,
  category    text not null default 'Other'
              check (category in ('Classes','Testing','Dual enrollment','Activities','Summer','College research','Scholarships','Other')),
  owner       text not null default 'Amy' check (owner in ('Amy','Parent','Both')),
  status      text not null default 'Not started' check (status in ('Not started','In progress','Done','Not needed')),
  notes       text,
  source_url  text,
  verified_on date,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists public.amy_colleges (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  program     text,
  interest    text not null default 'Interested' check (interest in ('Interested','Want to visit','Visited','Top choice','Not interested')),
  facts       jsonb not null default '{}'::jsonb,
  notes       text,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists public.amy_activities (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  kind        text not null default 'Activity' check (kind in ('Activity','Sport','Honor','Job','Volunteer','Summer program')),
  role        text,
  grades      text,
  hours_week  numeric(4,1),
  weeks_year  int,
  description text check (description is null or char_length(description) <= 150),
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

create table if not exists public.amy_tests (
  id          uuid primary key default gen_random_uuid(),
  test        text not null check (test in ('PSAT 8/9','PSAT 10','PSAT/NMSQT','SAT','ACT','AP exam','ACCUPLACER','Other')),
  taken_on    date,
  total       int,
  parts       text,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

do $$
declare t text;
begin
  foreach t in array array['amy_courses','amy_tasks','amy_colleges','amy_activities','amy_tests'] loop
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
