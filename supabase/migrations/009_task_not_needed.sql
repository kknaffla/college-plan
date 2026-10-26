-- 009: allow tasks to be marked 'Not needed' (ignored but kept). Idempotent.
alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('Not started','In progress','Waiting on others','Submitted','Done','Not needed'));
