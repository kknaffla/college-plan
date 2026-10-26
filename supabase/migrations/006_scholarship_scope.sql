-- 006: scholarship scope (Local / State & regional / National / College). Idempotent.
alter table public.scholarships add column if not exists scope text;
alter table public.scholarships drop constraint if exists scholarships_scope_check;
alter table public.scholarships add constraint scholarships_scope_check
  check (scope is null or scope in ('Local','State & regional','National','College'));

-- Backfill only rows not yet labeled.
update public.scholarships set scope = 'College' where scope is null and college_id is not null;
update public.scholarships set scope = 'Local' where scope is null and name in (
  'Prine Memorial Scholarship','Robert Hughes Memorial Scholarship','Charles Burley Memorial Scholarship',
  'MFCU College Scholarship','Manistique Rotary Scholarships','MAS Foundation Scholarship','Rick Demers Memorial Scholarship',
  'Lakeside Lodge Masonic Scholarship','Band Booster Club Scholarship','2027 local scholarships','U.P. Authentic Scholarship');
update public.scholarships set scope = 'State & regional' where scope is null and name in (
  'Michigan Achievement Scholarship','Community Commitment Scholarship','BBB Trust Scholarship','Scholar-Athlete Award 2026-27',
  'Fergin Scholarship','Michael Brukwicki Jr. Memorial Leadership Scholarship','Kathy Gillis Memorial Scholarship',
  'GSNWGL Council Scholarship','MIGCA Scholarship');
update public.scholarships set scope = 'National' where scope is null and name in (
  'Most Valuable Student (MVS) 2027','NHS Scholarship 2027','Burger King Scholars 2027-28','Equitable Excellence Scholarship',
  'College Scholarship Program','NASC Scholarship 2026-27','Kiwanis Children''s Fund Key Club Scholarships',
  'Christopher L. Hunt Scholarship (business/marketing)');
