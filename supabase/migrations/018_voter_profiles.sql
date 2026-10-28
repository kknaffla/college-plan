-- 018: family voter guide profiles (one row per person per election). Idempotent.
-- Every family member can read every profile; only the person themself can write theirs.
create table if not exists public.voter_profiles (
  user_id     uuid not null references auth.users(id) on delete cascade,
  election_id text not null,
  stances     jsonb not null default '{}'::jsonb,
  weights     jsonb not null default '{}'::jsonb,
  convictions text not null default '',
  picks       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  primary key (user_id, election_id)
);
alter table public.voter_profiles enable row level security;
drop policy if exists voter_read on public.voter_profiles;
create policy voter_read on public.voter_profiles for select to authenticated using (public.is_member());
drop policy if exists voter_write_own on public.voter_profiles;
create policy voter_write_own on public.voter_profiles for insert to authenticated with check (public.is_member() and user_id = auth.uid());
drop policy if exists voter_update_own on public.voter_profiles;
create policy voter_update_own on public.voter_profiles for update to authenticated using (public.is_member() and user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists voter_delete_own on public.voter_profiles;
create policy voter_delete_own on public.voter_profiles for delete to authenticated using (public.is_member() and user_id = auth.uid());
revoke all on public.voter_profiles from anon;
grant select, insert, update, delete on public.voter_profiles to authenticated;
drop trigger if exists stamp_voter_profiles on public.voter_profiles;
create trigger stamp_voter_profiles before insert or update on public.voter_profiles for each row execute function public.stamp_row();
