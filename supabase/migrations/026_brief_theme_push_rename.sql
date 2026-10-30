-- 026: brief_theme_push can rename and re-date themes Claude created, and record who picked a theme. Idempotent.
-- Family-set theme names and dates are still never changed by the job.
create or replace function public.brief_theme_push(key text, payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tok text; rid uuid; who text;
begin
  select token into tok from public.money_sync where id = 1;
  if key is null or tok is null or key <> tok then raise exception 'Not found'; end if;
  if jsonb_typeof(payload->'items') <> 'array' or jsonb_array_length(payload->'items') > 14 then raise exception 'Bad items'; end if;
  who := case when payload->>'set_by' in ('Family', 'Claude') then payload->>'set_by' else null end;
  rid := nullif(payload->>'id', '')::uuid;
  if rid is not null then
    update public.brief_themes set tagline = left(payload->>'tagline', 140), emoji = left(payload->>'emoji', 8), color1 = payload->>'color1', color2 = payload->>'color2',
      signoff = left(payload->>'signoff', 120), items = payload->'items', filled_at = now(),
      theme_name = case when set_by = 'Claude' and payload ? 'theme_name' then left(payload->>'theme_name', 80) else theme_name end,
      notes = case when payload ? 'notes' then left(payload->>'notes', 300) else notes end,
      start_date = case when set_by = 'Claude' and payload ? 'start_date' then (payload->>'start_date')::date else start_date end,
      end_date = case when set_by = 'Claude' and payload ? 'end_date' then (payload->>'end_date')::date else end_date end,
      set_by = coalesce(who, set_by)
    where id = rid;
  else
    insert into public.brief_themes (start_date, end_date, theme_name, notes, tagline, emoji, color1, color2, signoff, items, set_by, filled_at)
    values ((payload->>'start_date')::date, (payload->>'end_date')::date, left(payload->>'theme_name', 80), left(payload->>'notes', 300), left(payload->>'tagline', 140),
            left(payload->>'emoji', 8), payload->>'color1', payload->>'color2', left(payload->>'signoff', 120), payload->'items', coalesce(who, 'Claude'), now())
    returning id into rid;
  end if;
  return jsonb_build_object('id', rid, 'saved', true);
end $$;
revoke all on function public.brief_theme_push(text, jsonb) from public;
grant execute on function public.brief_theme_push(text, jsonb) to anon, authenticated;
select 'brief_theme_push updated' as status;
