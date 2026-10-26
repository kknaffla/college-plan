-- 005: editable number tiles on the profile (label/value pairs), replacing the fixed stat fields in the UI.
-- Idempotent. Seeds tiles once from the existing fields; ACT is left out by default.
alter table public.student_profile add column if not exists tiles jsonb;

update public.student_profile p set tiles = coalesce((
  select jsonb_agg(jsonb_build_object('label', t.label, 'value', t.value) order by t.ord)
  from (values
    (1, 'GPA (weighted)',   p.gpa_weighted),
    (2, 'GPA (unweighted)', p.gpa_unweighted),
    (3, 'SAT',              p.sat),
    (4, 'Class rank',       p.class_rank),
    (5, 'Dual-enrollment',  p.dual_credits)
  ) as t(ord, label, value)
), '[]'::jsonb)
where p.tiles is null;

-- Glee, not choir.
update public.tasks set title = replace(title, 'Ask choir director', 'Ask Glee director')
where title like 'Ask choir director%';
