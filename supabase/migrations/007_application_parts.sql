-- 007: per-college application checklist for the Home tracker. Idempotent.
-- Keys: application, essays, recs, transcript, scores, fee. Values: missing | progress | done | na.
alter table public.colleges add column if not exists app_parts jsonb;

update public.colleges
   set app_parts = '{"application":"missing","essays":"missing","recs":"missing","transcript":"missing","scores":"missing","fee":"missing"}'::jsonb
 where app_parts is null and priority <= 4 and status <> 'Not applying';

-- What is already known: the U-M application and essays are underway (Ross is the priority).
update public.colleges set app_parts = app_parts || '{"application":"progress","essays":"progress"}'::jsonb
 where id = '00000000-0000-4000-a000-000000000001' and app_parts->>'application' = 'missing';
