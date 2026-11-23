-- Private Supabase Storage bucket for Embedded Learning Hub rich-media assets.
-- Run once in Supabase Dashboard -> SQL Editor as a database owner.
-- Safe to re-run. Each Auth user may manage only objects in their own UUID folder.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'knowledge-media',
  'knowledge-media',
  false,
  null,
  array[
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'image/bmp',
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json',
    'application/zip',
    'application/gzip',
    'application/octet-stream',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.ms-powerpoint'
  ]::text[]
)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = null,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "knowledge_media_read_own" on storage.objects;
create policy "knowledge_media_read_own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'knowledge-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "knowledge_media_upload_own" on storage.objects;
create policy "knowledge_media_upload_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'knowledge-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "knowledge_media_update_own" on storage.objects;
create policy "knowledge_media_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'knowledge-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  )
  with check (
    bucket_id = 'knowledge-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists "knowledge_media_delete_own" on storage.objects;
create policy "knowledge_media_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'knowledge-media'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

commit;
