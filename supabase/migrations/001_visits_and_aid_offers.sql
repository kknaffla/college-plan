-- 001: campus visit log + aid offer / net-price comparison. Idempotent; safe to re-run.
-- Holds no tax data: only totals the family chooses to enter.

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

do $$
declare t text;
begin
  foreach t in array array['visits','aid_offers'] loop
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
