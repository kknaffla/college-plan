-- 011: settings for the 7 AM daily brief email (daily-brief Edge Function). Idempotent.
-- Recipients are family email addresses: set them in the SQL Editor, never in this public repo.
-- No policies and no grants: only the Edge Function (service role) and the SQL Editor can read or change it.
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
