-- Row Level Security. Tenant isolation is enforced here, not in the app.

-- Helpers ----------------------------------------------------------------
-- SECURITY DEFINER so policies can read workspace_members without recursing
-- into its own policy. search_path is empty; everything is schema-qualified.
create or replace function public.dms_role(ws uuid)
returns text language sql stable security definer set search_path = '' as $$
  select m.role from public.workspace_members m
  where m.workspace_id = ws and m.user_id = (select auth.uid())
$$;

create or replace function public.dms_has_role(ws uuid, min_role text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    (case public.dms_role(ws) when 'viewer' then 0 when 'editor' then 1 when 'admin' then 2 when 'owner' then 3 end)
    >=
    (case min_role when 'viewer' then 0 when 'editor' then 1 when 'admin' then 2 when 'owner' then 3 end),
    false)
$$;

-- Workspace id embedded in a storage key ("<workspace uuid>/<document uuid>/..."), or null.
create or replace function public.dms_ws_from_key(key text)
returns uuid language sql immutable set search_path = '' as $$
  select case
    when key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then split_part(key, '/', 1)::uuid
  end
$$;

revoke all on function public.dms_role(uuid), public.dms_has_role(uuid, text) from public, anon;
grant execute on function public.dms_role(uuid), public.dms_has_role(uuid, text) to authenticated, service_role;
grant execute on function public.dms_ws_from_key(text) to anon, authenticated, service_role;

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.document_folders enable row level security;
alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.document_tags enable row level security;
alter table public.document_tag_assignments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.document_share_links enable row level security;

-- Table privileges: default-deny for anon; authenticated gets what policies then narrow.
revoke all on all tables in schema public from anon;
grant select on public.workspaces, public.workspace_members to authenticated;
grant select, insert, update, delete on public.document_folders, public.documents,
  public.document_tags, public.document_tag_assignments to authenticated;
grant select, delete on public.document_versions to authenticated;
grant select on public.audit_logs to authenticated;
grant select, insert, update, delete on public.document_share_links to authenticated;
grant all on all tables in schema public to service_role;

-- workspaces / members: read-only for members. Created via create_workspace().
create policy workspaces_select on public.workspaces for select to authenticated
  using (public.dms_has_role(id, 'viewer'));
create policy members_select on public.workspace_members for select to authenticated
  using (public.dms_has_role(workspace_id, 'viewer'));

-- folders
create policy folders_select on public.document_folders for select to authenticated
  using (public.dms_has_role(workspace_id, 'viewer'));
create policy folders_insert on public.document_folders for insert to authenticated
  with check (public.dms_has_role(workspace_id, 'editor') and not is_system and created_by = (select auth.uid()));
create policy folders_update on public.document_folders for update to authenticated
  using (public.dms_has_role(workspace_id, 'editor') and not is_system)
  with check (public.dms_has_role(workspace_id, 'editor') and not is_system);
create policy folders_delete on public.document_folders for delete to authenticated
  using (public.dms_has_role(workspace_id, 'editor') and not is_system);

-- documents: rows are created only through dms_begin_upload().
create policy documents_select on public.documents for select to authenticated
  using (public.dms_has_role(workspace_id, 'viewer'));
create policy documents_update on public.documents for update to authenticated
  using (public.dms_has_role(workspace_id, 'editor'))
  with check (public.dms_has_role(workspace_id, 'editor'));
create policy documents_delete on public.documents for delete to authenticated
  using (public.dms_has_role(workspace_id, 'admin'));

create policy versions_select on public.document_versions for select to authenticated
  using (public.dms_has_role(workspace_id, 'viewer'));
create policy versions_delete on public.document_versions for delete to authenticated
  using (public.dms_has_role(workspace_id, 'admin'));

-- tags
create policy tags_select on public.document_tags for select to authenticated
  using (public.dms_has_role(workspace_id, 'viewer'));
create policy tags_insert on public.document_tags for insert to authenticated
  with check (public.dms_has_role(workspace_id, 'editor'));
create policy tags_delete on public.document_tags for delete to authenticated
  using (public.dms_has_role(workspace_id, 'admin'));
create policy tag_assign_select on public.document_tag_assignments for select to authenticated
  using (public.dms_has_role(workspace_id, 'viewer'));
create policy tag_assign_insert on public.document_tag_assignments for insert to authenticated
  with check (public.dms_has_role(workspace_id, 'editor'));
create policy tag_assign_delete on public.document_tag_assignments for delete to authenticated
  using (public.dms_has_role(workspace_id, 'editor'));

-- audit: admins read; rows are written by triggers / dms_record_audit() only.
create policy audit_select on public.audit_logs for select to authenticated
  using (public.dms_has_role(workspace_id, 'admin'));

-- share links
create policy share_select on public.document_share_links for select to authenticated
  using (public.dms_has_role(workspace_id, 'editor'));
create policy share_insert on public.document_share_links for insert to authenticated
  with check (public.dms_has_role(workspace_id, 'editor') and created_by = (select auth.uid()));
create policy share_update on public.document_share_links for update to authenticated
  using (public.dms_has_role(workspace_id, 'admin') or created_by = (select auth.uid()))
  with check (public.dms_has_role(workspace_id, 'admin') or created_by = (select auth.uid()));
create policy share_delete on public.document_share_links for delete to authenticated
  using (public.dms_has_role(workspace_id, 'admin') or created_by = (select auth.uid()));

-- Guard columns that only the upload RPCs may change -----------------------
create or replace function public.dms_documents_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if coalesce(current_setting('dms.rpc', true), '') = '1' then
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id
     or new.storage_key is distinct from old.storage_key
     or new.mime_type is distinct from old.mime_type
     or new.size_bytes is distinct from old.size_bytes
     or new.status is distinct from old.status
     or new.current_version is distinct from old.current_version
     or new.uploaded_by is distinct from old.uploaded_by
     or new.original_name is distinct from old.original_name
     or new.created_at is distinct from old.created_at
     or new.content_text is distinct from old.content_text then
    raise exception 'protected_column' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger documents_guard before update on public.documents
  for each row execute function public.dms_documents_guard();

create or replace function public.dms_folders_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is distinct from old.workspace_id
     or new.is_system is distinct from old.is_system
     or new.default_category is distinct from old.default_category then
    raise exception 'protected_column' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger folders_guard before update on public.document_folders
  for each row execute function public.dms_folders_guard();
