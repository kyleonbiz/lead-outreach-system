-- Security hardening from the pre-release review (see SECURITY_REVIEW.md).

-- 1. Quota bypass: dms_complete_upload trusted a caller-supplied size and never
--    looked at the stored object. An editor could declare 1 byte, upload a 50 MB
--    object, and finish with p_size = 1. The size is now the declared (and
--    quota-checked) size, and it must match the object actually in storage.
--    p_size / p_mime stay in the signature for compatibility but are ignored.
create or replace function public.dms_complete_upload(
  p_workspace uuid, p_document uuid, p_version integer, p_size bigint, p_mime text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); ver public.document_versions; doc public.documents; stored bigint;
begin
  if uid is null or not public.dms_has_role(p_workspace, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ver from public.document_versions v
    where v.document_id = p_document and v.workspace_id = p_workspace and v.version_number = p_version
      and v.status = 'pending' for update;
  if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
  if ver.created_by is distinct from uid and not public.dms_has_role(p_workspace, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select (o.metadata ->> 'size')::bigint into stored
    from storage.objects o where o.bucket_id = 'documents' and o.name = ver.storage_key;
  if stored is null then raise exception 'invalid_upload: object_missing' using errcode = '22023'; end if;
  if stored <> ver.size_bytes then raise exception 'invalid_upload: size_mismatch' using errcode = '22023'; end if;

  perform set_config('dms.rpc', '1', true);
  update public.document_versions set status = 'ready' where id = ver.id;
  update public.documents set status = 'ready', storage_key = ver.storage_key, size_bytes = ver.size_bytes,
    mime_type = ver.mime_type, current_version = p_version
    where id = p_document and workspace_id = p_workspace returning * into doc;
  return to_jsonb(doc) - 'search_vector' - 'content_text';
end $$;

-- 2. Share-link lifetime cap: clients may still INSERT link rows (the app does),
--    so a direct API call could mint a link that never expires. Enforce the
--    7-day cap and server-side timestamps in the database.
create or replace function public.dms_share_links_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user = 'authenticated' then
    new.created_at := now();
    new.revoked_at := null;
    if new.expires_at > now() + interval '7 days' + interval '1 minute' then
      raise exception 'invalid_expiry: share links last at most 7 days' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger share_links_guard before insert on public.document_share_links
  for each row execute function public.dms_share_links_guard();

-- 3. File names written straight through the API bypass the app's sanitiser.
--    NOT VALID: new and updated rows are checked without scanning old data.
alter table public.documents
  add constraint documents_display_name_safe check (display_name !~ '[[:cntrl:]/\\]') not valid,
  add constraint documents_original_name_safe check (original_name !~ '[[:cntrl:]/\\]') not valid;

-- 4. Workspace creation: take the email from the auth record (not the client),
--    cap display-name length, and limit how many workspaces one user can own so
--    self-service sign-up cannot be used to mint unlimited storage quota.
create or replace function public.create_workspace(p_name text, p_display_name text, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); ws uuid; em text;
begin
  if uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_name is null or char_length(trim(p_name)) < 2 or char_length(trim(p_name)) > 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  if (select count(*) from public.workspace_members m where m.user_id = uid and m.role = 'owner') >= 5 then
    raise exception 'workspace_limit: you already own the maximum number of workspaces' using errcode = 'P0001';
  end if;
  select coalesce(u.email, '') into em from auth.users u where u.id = uid;
  insert into public.workspaces (name, created_by) values (trim(p_name), uid) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role, display_name, email)
  values (ws, uid, 'owner', left(trim(coalesce(p_display_name, '')), 80), coalesce(em, ''));
  insert into public.document_folders (workspace_id, name, color, is_system, default_category, created_by) values
    (ws, 'Invoices', 'violet', true, 'invoice', uid),
    (ws, 'Receipts', 'emerald', true, 'receipt', uid),
    (ws, 'Tax Documents', 'amber', true, 'tax', uid),
    (ws, 'Contracts', 'blue', true, 'contract', uid),
    (ws, 'HR Documents', 'rose', true, 'hr', uid);
  perform public.dms_audit_write(ws, 'workspace.created', 'workspace', ws, jsonb_build_object('name', trim(p_name)));
  return ws;
end $$;
revoke all on function public.create_workspace(text, text, text) from public, anon;
grant execute on function public.create_workspace(text, text, text) to authenticated;
