-- 015: application fee per college, plus a note on waivers and free-application dates. Idempotent.
alter table public.colleges add column if not exists app_fee numeric;
alter table public.colleges add column if not exists fee_note text;
