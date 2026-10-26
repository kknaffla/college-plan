-- 010: private key for adding tasks from the iPhone Share sheet (quick-add Edge Function). Idempotent.
-- Separate from the calendar feed key: the feed link only reads, this one can add tasks.
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
