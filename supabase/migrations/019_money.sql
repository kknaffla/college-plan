-- 019: family money section (accounts, balances, transactions, savings goals, budgets). Idempotent.
-- Access is per account: visible_to (who may read it) and editors (who may change it). No roles.
-- Kevin (money_settings.admins) is the only editor at first. Kevin and Janet (managers) see every budget.
-- A person reads a transaction if they can see its account OR the charge was purchased by them (Apple Card).
-- Lily's and Amy's tables, public.members and is_member() are untouched. Copilot ids are the dedupe key.
-- Never store full account numbers: mask holds the last 4 digits only.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- settings
create table if not exists public.money_settings (
  id         int primary key default 1 check (id = 1),
  admins     uuid[] not null default '{}',   -- may change everything (accounts, budgets, rules, imports)
  managers   uuid[] not null default '{}',   -- see every person's budget
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.money_settings (id) values (1) on conflict (id) do nothing;
-- First run only: the parent named Kevin administers; both parents manage budgets. Later changes in the app are kept.
update public.money_settings set admins = coalesce((select array_agg(user_id) from public.members where role = 'parent' and display_name ilike 'Kevin%'), '{}')
  where id = 1 and cardinality(admins) = 0;
update public.money_settings set managers = coalesce((select array_agg(user_id) from public.members where role = 'parent'), '{}')
  where id = 1 and cardinality(managers) = 0;

create or replace function public.money_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select auth.uid() = any(admins) from public.money_settings where id = 1), false);
$$;
create or replace function public.money_is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select auth.uid() = any(managers) or auth.uid() = any(admins) from public.money_settings where id = 1), false);
$$;

-- The sync key: the scheduled Claude job sends it with each push. Admins read it in the app; nobody else.
create table if not exists public.money_sync (
  id           int primary key default 1 check (id = 1),
  token        text not null default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  rotated_at   timestamptz not null default now(),
  last_sync_at timestamptz,
  last_result  text
);
insert into public.money_sync (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------- accounts
create table if not exists public.accounts (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  institution   text,
  type          text not null default 'other'
                check (type in ('checking','savings','credit','investment','loan','real_estate','cash','other')),
  mask          text check (mask is null or mask ~ '^[0-9]{4}$'),
  copilot_id    text unique,
  copilot_name  text,
  owner         uuid[] not null default '{}',   -- whose spending a charge counts as when purchased_by is empty
  visible_to    uuid[] not null default '{}',
  editors       uuid[] not null default '{}',
  is_setup      boolean not null default false, -- false = "new, not set up" (Kevin only until he sets it up)
  credit_limit  numeric(12,2),
  balance       numeric(14,2),
  balance_as_of date,
  sort          int not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

create table if not exists public.balances (
  account_id uuid not null references public.accounts(id) on delete cascade,
  as_of      date not null,
  balance    numeric(14,2) not null,
  primary key (account_id, as_of)
);

create table if not exists public.transactions (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references public.accounts(id) on delete cascade,
  copilot_id      text unique,
  date            date not null,
  name            text not null,
  merchant        text,
  amount          numeric(12,2) not null,            -- positive = money out, negative = money in (Copilot's sign)
  category        text,
  parent_category text,
  status          text not null default 'posted' check (status in ('posted','pending')),
  type            text not null default 'spending' check (type in ('spending','income','transfer')),
  note            text,
  excluded        boolean not null default false,
  recurring       text,
  purchased_by    uuid references auth.users(id) on delete set null,  -- Apple Card only, from the Apple CSV
  source          text not null default 'copilot' check (source in ('copilot','apple','manual')),
  updated_at      timestamptz not null default now(),
  updated_by      uuid
);
create index if not exists transactions_account_date on public.transactions (account_id, date desc);
create index if not exists transactions_purchaser_date on public.transactions (purchased_by, date desc);

create table if not exists public.savings_goals (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null unique references public.accounts(id) on delete cascade,
  target      numeric(12,2) not null check (target > 0),
  target_date date,
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);

-- ---------------------------------------------------------------- budgets
create table if not exists public.budget_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort       int not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create table if not exists public.category_rules (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('merchant','category')),  -- merchant text contains, or Copilot/Apple category equals
  pattern     text not null,
  category_id uuid not null references public.budget_categories(id) on delete cascade,
  sort        int not null default 0,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (kind, pattern)
);
create table if not exists public.budgets (
  id          uuid primary key default gen_random_uuid(),
  person      text not null,   -- a member's user id as text, or 'shared' for the Kevin & Janet budget
  category_id uuid not null references public.budget_categories(id) on delete cascade,
  amount      numeric(12,2) check (amount is null or amount >= 0),   -- null = no budget set
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique (person, category_id)
);

-- Default logical categories and rules. Merchant rules win over category rules; unmatched charges land in Other.
insert into public.budget_categories (name, sort)
select n, s from (values ('Coffee & drinks', 1), ('Eating out', 2), ('Gas', 3), ('Groceries', 4), ('Shopping', 5), ('Entertainment', 6),
  ('Subscriptions', 7), ('Health', 8), ('Travel', 9), ('Home & utilities', 10), ('Other', 99)) v(n, s)
where not exists (select 1 from public.budget_categories b where b.name = v.n);
insert into public.category_rules (kind, pattern, category_id, sort)
select v.k, v.p, b.id, v.s from (values
  ('merchant', 'Grind', 'Coffee & drinks', 1), ('merchant', 'Starbucks', 'Coffee & drinks', 2), ('merchant', 'Dunkin', 'Coffee & drinks', 3),
  ('merchant', 'Biggby', 'Coffee & drinks', 4), ('merchant', 'Coca-cola', 'Coffee & drinks', 5),
  ('category', 'Restaurants', 'Eating out', 10), ('category', 'Bars & Nightlife', 'Eating out', 11),
  ('category', 'Groceries', 'Groceries', 20), ('category', 'Grocery', 'Groceries', 21),
  ('category', 'Car', 'Gas', 30), ('category', 'Transportation', 'Gas', 31), ('category', 'Gas', 'Gas', 32),
  ('category', 'Shops', 'Shopping', 40), ('category', 'Clothing', 'Shopping', 41), ('category', 'Shopping', 'Shopping', 42),
  ('category', 'Entertainment', 'Entertainment', 50), ('category', 'Recreation', 'Entertainment', 51),
  ('category', 'Subscriptions', 'Subscriptions', 60),
  ('category', 'Healthcare', 'Health', 70), ('category', 'Personal Care', 'Health', 71), ('category', 'Medical', 'Health', 72),
  ('category', 'Travel & Vacation', 'Travel', 80), ('category', 'Travel', 'Travel', 81),
  ('category', 'Home', 'Home & utilities', 90), ('category', 'Utilities', 'Home & utilities', 91), ('category', 'Household', 'Home & utilities', 92),
  ('category', 'Mortgage', 'Home & utilities', 93), ('category', 'Insurance', 'Home & utilities', 94)
) v(k, p, c, s) join public.budget_categories b on b.name = v.c
where not exists (select 1 from public.category_rules r where r.kind = v.k and r.pattern = v.p);

-- ---------------------------------------------------------------- access helpers
create or replace function public.can_see(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.accounts where id = a and auth.uid() = any(visible_to));
$$;
create or replace function public.can_change(a uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.accounts where id = a and auth.uid() = any(editors));
$$;
-- Names of the accounts whose charges this person may read without seeing the account (their Apple Card charges).
create or replace function public.money_card_labels() returns table (id uuid, name text, type text, mask text)
language sql stable security definer set search_path = public as $$
  select distinct a.id, a.name, a.type, a.mask from public.accounts a
  join public.transactions t on t.account_id = a.id where t.purchased_by = auth.uid();
$$;
revoke all on function public.money_is_admin(), public.money_is_manager(), public.can_see(uuid), public.can_change(uuid), public.money_card_labels() from public, anon;
grant execute on function public.money_is_admin(), public.money_is_manager(), public.can_see(uuid), public.can_change(uuid), public.money_card_labels() to authenticated;

-- ---------------------------------------------------------------- row level security
do $$
declare t text;
begin
  foreach t in array array['money_settings','money_sync','accounts','balances','transactions','savings_goals','budget_categories','category_rules','budgets'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['money_settings','accounts','savings_goals','budget_categories','category_rules','budgets','transactions'] loop
    execute format('drop trigger if exists stamp_%1$s on public.%1$s', t);
    execute format('create trigger stamp_%1$s before insert or update on public.%1$s for each row execute function public.stamp_row()', t);
  end loop;
end $$;

drop policy if exists money_settings_read on public.money_settings;
create policy money_settings_read on public.money_settings for select to authenticated using (public.is_member());
drop policy if exists money_settings_write on public.money_settings;
create policy money_settings_write on public.money_settings for update to authenticated using (public.money_is_admin()) with check (public.money_is_admin());
grant select, update on public.money_settings to authenticated;

drop policy if exists money_sync_admin on public.money_sync;
create policy money_sync_admin on public.money_sync for select to authenticated using (public.money_is_admin());
grant select on public.money_sync to authenticated;

drop policy if exists accounts_read on public.accounts;
create policy accounts_read on public.accounts for select to authenticated using (public.is_member() and auth.uid() = any(visible_to));
drop policy if exists accounts_insert on public.accounts;
create policy accounts_insert on public.accounts for insert to authenticated with check (public.money_is_admin());
drop policy if exists accounts_update on public.accounts;
create policy accounts_update on public.accounts for update to authenticated using (public.money_is_admin() or auth.uid() = any(editors)) with check (public.money_is_admin() or auth.uid() = any(editors));
drop policy if exists accounts_delete on public.accounts;
create policy accounts_delete on public.accounts for delete to authenticated using (public.money_is_admin());
grant select, insert, update, delete on public.accounts to authenticated;

drop policy if exists balances_read on public.balances;
create policy balances_read on public.balances for select to authenticated using (public.can_see(account_id));
drop policy if exists balances_write on public.balances;
create policy balances_write on public.balances for all to authenticated using (public.can_change(account_id)) with check (public.can_change(account_id));
grant select, insert, update, delete on public.balances to authenticated;

drop policy if exists transactions_read on public.transactions;
create policy transactions_read on public.transactions for select to authenticated
  using (public.is_member() and (public.can_see(account_id) or purchased_by = auth.uid()));
drop policy if exists transactions_write on public.transactions;
create policy transactions_write on public.transactions for all to authenticated using (public.can_change(account_id)) with check (public.can_change(account_id));
grant select, insert, update, delete on public.transactions to authenticated;

drop policy if exists goals_read on public.savings_goals;
create policy goals_read on public.savings_goals for select to authenticated using (public.can_see(account_id));
drop policy if exists goals_write on public.savings_goals;
create policy goals_write on public.savings_goals for all to authenticated using (public.can_change(account_id)) with check (public.can_change(account_id));
grant select, insert, update, delete on public.savings_goals to authenticated;

drop policy if exists categories_read on public.budget_categories;
create policy categories_read on public.budget_categories for select to authenticated using (public.is_member());
drop policy if exists categories_write on public.budget_categories;
create policy categories_write on public.budget_categories for all to authenticated using (public.money_is_admin()) with check (public.money_is_admin());
grant select, insert, update, delete on public.budget_categories to authenticated;

drop policy if exists rules_read on public.category_rules;
create policy rules_read on public.category_rules for select to authenticated using (public.is_member());
drop policy if exists rules_write on public.category_rules;
create policy rules_write on public.category_rules for all to authenticated using (public.money_is_admin()) with check (public.money_is_admin());
grant select, insert, update, delete on public.category_rules to authenticated;

drop policy if exists budgets_read on public.budgets;
create policy budgets_read on public.budgets for select to authenticated
  using (public.is_member() and (public.money_is_manager() or person = auth.uid()::text));
drop policy if exists budgets_write on public.budgets;
create policy budgets_write on public.budgets for all to authenticated using (public.money_is_admin()) with check (public.money_is_admin());
grant select, insert, update, delete on public.budgets to authenticated;

-- ---------------------------------------------------------------- sync push (the only write path for the Claude job)
-- Called over the REST API: POST /rest/v1/rpc/money_sync_push with the public anon key; the body carries the
-- money_sync token and a payload. It upserts only accounts in the payload, so business accounts never arrive
-- unless they are sent. purchased_by is never overwritten. New accounts are visible to admins only
-- (unless the payload names visible_to_emails / owner_emails for that first insert).
-- payload: { window_from: 'YYYY-MM-DD',
--   accounts: [{copilot_id, name, institution, type, mask, credit_limit, balance, as_of, visible_to_emails?, owner_emails?}],
--   balances: [{copilot_id, as_of, balance}],
--   transactions: [{copilot_id, account_copilot_id, date, name, amount, category, parent_category, pending, type, note, excluded, recurring}] }
create or replace function public.money_sync_push(key text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  tok text; adm uuid[]; r jsonb; aid uuid; n_new int := 0; n_acc int := 0; n_bal int := 0; n_tx int := 0; n_gone int := 0;
  v_vis uuid[]; v_own uuid[]; wf date; ids text[];
begin
  select token into tok from public.money_sync where id = 1;
  if key is null or tok is null or key <> tok then raise exception 'Not found'; end if;
  select admins into adm from public.money_settings where id = 1;
  wf := nullif(payload->>'window_from', '')::date;

  for r in select * from jsonb_array_elements(coalesce(payload->'accounts', '[]'::jsonb)) loop
    select id into aid from public.accounts where copilot_id = r->>'copilot_id';
    if aid is null then
      v_vis := coalesce((select array_agg(u.id) from auth.users u where lower(u.email) in (select lower(e) from jsonb_array_elements_text(coalesce(r->'visible_to_emails', '[]'::jsonb)) e)), '{}');
      v_own := coalesce((select array_agg(u.id) from auth.users u where lower(u.email) in (select lower(e) from jsonb_array_elements_text(coalesce(r->'owner_emails', '[]'::jsonb)) e)), '{}');
      insert into public.accounts (name, institution, type, mask, copilot_id, copilot_name, credit_limit, balance, balance_as_of, visible_to, editors, owner, is_setup)
      values (r->>'name', r->>'institution', coalesce(r->>'type', 'other'), nullif(r->>'mask', ''), r->>'copilot_id', r->>'name', (r->>'credit_limit')::numeric,
              (r->>'balance')::numeric, (r->>'as_of')::date, adm || v_vis, adm, v_own, cardinality(v_vis) > 0 or cardinality(v_own) > 0)
      returning id into aid;
      n_new := n_new + 1;
    else
      update public.accounts set institution = coalesce(r->>'institution', institution), type = coalesce(r->>'type', type), mask = coalesce(nullif(r->>'mask', ''), mask),
        copilot_name = coalesce(r->>'name', copilot_name), credit_limit = (r->>'credit_limit')::numeric,
        balance = coalesce((r->>'balance')::numeric, balance), balance_as_of = coalesce((r->>'as_of')::date, balance_as_of)
      where id = aid;
    end if;
    n_acc := n_acc + 1;
    if r->>'balance' is not null and r->>'as_of' is not null then
      insert into public.balances (account_id, as_of, balance) values (aid, (r->>'as_of')::date, (r->>'balance')::numeric)
      on conflict (account_id, as_of) do update set balance = excluded.balance;
    end if;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(payload->'balances', '[]'::jsonb)) loop
    select id into aid from public.accounts where copilot_id = r->>'copilot_id';
    if aid is null then continue; end if;
    insert into public.balances (account_id, as_of, balance) values (aid, (r->>'as_of')::date, (r->>'balance')::numeric)
    on conflict (account_id, as_of) do update set balance = excluded.balance;
    n_bal := n_bal + 1;
  end loop;

  for r in select * from jsonb_array_elements(coalesce(payload->'transactions', '[]'::jsonb)) loop
    select id into aid from public.accounts where copilot_id = r->>'account_copilot_id';
    if aid is null then continue; end if;
    insert into public.transactions (account_id, copilot_id, date, name, merchant, amount, category, parent_category, status, type, note, excluded, recurring, source)
    values (aid, r->>'copilot_id', (r->>'date')::date, coalesce(r->>'name', ''), coalesce(r->>'merchant', r->>'name'), (r->>'amount')::numeric,
            r->>'category', r->>'parent_category', case when coalesce((r->>'pending')::boolean, false) then 'pending' else 'posted' end,
            case upper(coalesce(r->>'type', '')) when 'INCOME' then 'income' when 'INTERNAL_TRANSFER' then 'transfer' else 'spending' end,
            r->>'note', coalesce((r->>'excluded')::boolean, false), r->>'recurring', 'copilot')
    on conflict (copilot_id) do update set account_id = excluded.account_id, date = excluded.date, name = excluded.name, merchant = excluded.merchant,
      amount = excluded.amount, category = excluded.category, parent_category = excluded.parent_category, status = excluded.status,
      type = excluded.type, note = excluded.note, excluded = excluded.excluded, recurring = excluded.recurring;
    n_tx := n_tx + 1;
  end loop;

  -- Pending charges that Copilot no longer lists inside the window (dropped or re-issued) go away.
  if wf is not null and jsonb_typeof(payload->'transactions') = 'array' then
    ids := array(select e->>'copilot_id' from jsonb_array_elements(payload->'transactions') e);
    delete from public.transactions t using public.accounts a
      where t.account_id = a.id and a.copilot_id in (select e->>'copilot_id' from jsonb_array_elements(coalesce(payload->'accounts', '[]'::jsonb)) e)
        and t.status = 'pending' and t.source = 'copilot' and t.date >= wf and not (t.copilot_id = any(ids));
    get diagnostics n_gone = row_count;
  end if;

  update public.money_sync set last_sync_at = now(),
    last_result = format('%s accounts (%s new), %s balances, %s transactions, %s pending removed', n_acc, n_new, n_bal, n_tx, n_gone) where id = 1;
  return jsonb_build_object('accounts', n_acc, 'new_accounts', n_new, 'balances', n_bal, 'transactions', n_tx, 'pending_removed', n_gone);
end $$;
revoke all on function public.money_sync_push(text, jsonb) from public;
grant execute on function public.money_sync_push(text, jsonb) to anon, authenticated;

create or replace function public.rotate_money_sync_key() returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  if not public.money_is_admin() then raise exception 'not allowed'; end if;
  update public.money_sync set token = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), rotated_at = now() where id = 1 returning token into t;
  return t;
end $$;
revoke all on function public.rotate_money_sync_key() from public, anon;
grant execute on function public.rotate_money_sync_key() to authenticated;

-- ---------------------------------------------------------------- Apple Card CSV import (admins only)
-- rows: [{date:'YYYY-MM-DD', clearing:'YYYY-MM-DD', amount: 1.79, merchant:'Mcdonald''s F41205', by:'<user uuid>'}]
-- Matches each CSV row to one charge on the given account by amount, date (transaction date to clearing date,
-- one day of slack) and the start of the merchant name, then sets purchased_by. Returns counts and the unmatched rows.
create or replace function public.money_apply_purchasers(acct uuid, rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; tid uuid; used uuid[] := '{}'; n_ok int := 0; miss jsonb := '[]'::jsonb; m text; byid uuid;
begin
  if not public.money_is_admin() then raise exception 'not allowed'; end if;
  for r in select * from jsonb_array_elements(coalesce(rows, '[]'::jsonb)) loop
    byid := nullif(r->>'by', '')::uuid;
    m := lower(regexp_replace(coalesce(r->>'merchant', ''), '[^a-z0-9]+', ' ', 'gi'));
    m := split_part(trim(m), ' ', 1);
    if byid is null or m = '' then miss := miss || r; continue; end if;
    select t.id into tid from public.transactions t
      where t.account_id = acct and t.amount = (r->>'amount')::numeric
        and t.date between (r->>'date')::date - 1 and coalesce(nullif(r->>'clearing', '')::date, (r->>'date')::date) + 1
        and lower(regexp_replace(coalesce(t.merchant, t.name), '[^a-z0-9]+', ' ', 'gi')) like m || '%'
        and not (t.id = any(used))
      order by (t.purchased_by is null) desc, (t.purchased_by = byid) desc, abs(t.date - (r->>'date')::date), t.date limit 1;
    if tid is null then miss := miss || r; continue; end if;
    update public.transactions set purchased_by = byid where id = tid and purchased_by is distinct from byid;
    used := used || tid; n_ok := n_ok + 1;
  end loop;
  return jsonb_build_object('matched', n_ok, 'unmatched', jsonb_array_length(miss), 'missing', miss);
end $$;
revoke all on function public.money_apply_purchasers(uuid, jsonb) from public, anon;
grant execute on function public.money_apply_purchasers(uuid, jsonb) to authenticated;
