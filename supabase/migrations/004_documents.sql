-- 004: private document vault (no financial records). Idempotent; safe to re-run.
-- Files live in the private Storage bucket 'documents'; metadata in public.documents.
-- Only family members can list, read, upload, or delete. Viewing uses short-lived signed URLs.

create table if not exists public.documents (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    text not null default 'Other'
              check (category in ('Essays','Transcripts & scores','Resume & activities','Awards & certificates',
                                  'Recommendations','Application receipts','Admission letters','Scholarships',
                                  'Visits & photos','Other')),
  college_id  uuid references public.colleges(id) on delete set null,
  file_path   text,            -- object path in the 'documents' bucket, or null for a link
  link_url    text,            -- e.g. a Google Doc or OneDrive link instead of a file
  file_name   text,
  mime_type   text,
  size_bytes  bigint,
  notes       text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  check (file_path is not null or link_url is not null)
);

do $$
begin
  execute 'drop trigger if exists stamp_documents on public.documents';
  execute 'create trigger stamp_documents before insert or update on public.documents for each row execute function public.stamp_row()';
  execute 'alter table public.documents enable row level security';
  execute 'drop policy if exists family_all on public.documents';
  execute 'create policy family_all on public.documents for all to authenticated using (public.is_member()) with check (public.is_member())';
  execute 'revoke all on public.documents from anon';
  execute 'grant select, insert, update, delete on public.documents to authenticated';
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'documents') then
    execute 'alter publication supabase_realtime add table public.documents';
  end if;
end $$;

-- Private bucket, 25 MB per file, common document/image types only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 26214400,
        array['application/pdf','image/jpeg','image/png','image/heic','image/heif','image/webp',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword',
              'application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists family_docs_select on storage.objects;
drop policy if exists family_docs_insert on storage.objects;
drop policy if exists family_docs_update on storage.objects;
drop policy if exists family_docs_delete on storage.objects;
create policy family_docs_select on storage.objects for select to authenticated using (bucket_id = 'documents' and public.is_member());
create policy family_docs_insert on storage.objects for insert to authenticated with check (bucket_id = 'documents' and public.is_member());
create policy family_docs_update on storage.objects for update to authenticated using (bucket_id = 'documents' and public.is_member()) with check (bucket_id = 'documents' and public.is_member());
create policy family_docs_delete on storage.objects for delete to authenticated using (bucket_id = 'documents' and public.is_member());
