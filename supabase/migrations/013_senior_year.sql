-- 013: Senior year. Adds a 'Senior year' task category and graduation details on the student profile. Idempotent.
alter table public.tasks drop constraint if exists tasks_category_check;
alter table public.tasks add constraint tasks_category_check
  check (category in ('Admissions','School materials','Essays','Scholarship','Financial aid','Research','Senior year','Other'));
alter table public.student_profile add column if not exists grad_date  date;
alter table public.student_profile add column if not exists grad_time  text;
alter table public.student_profile add column if not exists grad_place text;
