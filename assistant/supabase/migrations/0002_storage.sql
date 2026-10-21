-- 0002_storage.sql
-- Private bucket for documents. Objects must live under "<org_id>/..." and access is
-- limited to members of that organization. Needs Supabase's storage schema.

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400)  -- 25 MB
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

create or replace function private.storage_org(p_name text)
returns uuid
language sql immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then split_part(p_name, '/', 1)::uuid
  end;
$$;

create policy documents_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and private.is_org_member(private.storage_org(name)));
create policy documents_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and private.is_org_member(private.storage_org(name)));
create policy documents_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and private.has_org_role(private.storage_org(name), array['owner', 'admin']));
