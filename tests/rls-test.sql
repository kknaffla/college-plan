-- Run after db-stub.sql, schema.sql, seed.sql on a throwaway local Postgres.
insert into auth.users values ('11111111-1111-1111-1111-111111111111','parent@test'),('22222222-2222-2222-2222-222222222222','lily@test'),('33333333-3333-3333-3333-333333333333','stranger@test') on conflict do nothing;
insert into members values ('11111111-1111-1111-1111-111111111111','Kevin','parent'),('22222222-2222-2222-2222-222222222222','Lily','student') on conflict do nothing;
\echo --- stranger: expect 0 rows, 0 updates, 0 members
set role authenticated; set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as stranger_tasks from tasks;
update tasks set status='Done';
select count(*) as stranger_members from members;
reset role;
\echo --- anon: expect permission denied
set role anon;
\set ON_ERROR_STOP 0
select count(*) from tasks;
\set ON_ERROR_STOP 1
reset role;
\echo --- lily: expect all rows, update stamped with her id, cannot add members
set role authenticated; set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select count(*) as lily_tasks from tasks;
update tasks set status='In progress' where title like 'Build Ross%' returning status, updated_by;
\set ON_ERROR_STOP 0
insert into members values ('33333333-3333-3333-3333-333333333333','x','parent');
\set ON_ERROR_STOP 1
reset role;
select count(*) as done_after_stranger_update from tasks where status='Done';
