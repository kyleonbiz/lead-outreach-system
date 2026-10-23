-- Private storage bucket and object policies. Object keys are
-- "<workspace_id>/<document_id>/v<n>-<nonce>.<ext>", generated server-side.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 52428800, array[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv', 'application/csv', 'application/vnd.ms-excel', 'text/plain',
  'image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create policy dms_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and public.dms_has_role(public.dms_ws_from_key(name), 'viewer'));

-- An object can only be created for a pending version the caller opened via
-- dms_begin_upload(), so the quota check cannot be bypassed.
create policy dms_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and exists (
      select 1 from public.document_versions v
      where v.storage_key = name and v.status = 'pending' and v.created_by = (select auth.uid())
        and v.workspace_id = public.dms_ws_from_key(name)
        and public.dms_has_role(v.workspace_id, 'editor')));

-- Objects backing a ready version can't be deleted from the client; purge
-- removes the metadata first, then the objects.
create policy dms_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and public.dms_has_role(public.dms_ws_from_key(name), 'editor')
    and not exists (select 1 from public.document_versions v where v.storage_key = name and v.status = 'ready'));
