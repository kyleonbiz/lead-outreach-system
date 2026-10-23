-- RPCs and audit triggers.
-- SECURITY DEFINER functions check roles explicitly and set an empty search_path.
-- SECURITY INVOKER functions run under the caller's RLS.

-- Audit ------------------------------------------------------------------
create or replace function public.dms_audit_write(
  ws uuid, p_action text, p_type text, p_entity uuid, p_meta jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.audit_logs (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  values (ws, (select auth.uid()), p_action, p_type, p_entity, coalesce(p_meta, '{}'::jsonb))
$$;
revoke all on function public.dms_audit_write(uuid, text, text, uuid, jsonb) from public, anon, authenticated;

-- Events the database cannot observe itself (downloads, shares, tag edits).
create or replace function public.dms_record_audit(
  p_workspace uuid, p_action text, p_entity uuid, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.dms_has_role(p_workspace, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_action not in ('document.downloaded', 'document.shared', 'document.tags_updated') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;
  if not exists (select 1 from public.documents where id = p_entity and workspace_id = p_workspace) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform public.dms_audit_write(p_workspace, p_action, 'document', p_entity, p_meta);
end $$;
revoke all on function public.dms_record_audit(uuid, text, uuid, jsonb) from public, anon;
grant execute on function public.dms_record_audit(uuid, text, uuid, jsonb) to authenticated;

create or replace function public.dms_documents_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'ready' then
      perform public.dms_audit_write(old.workspace_id, 'document.purged', 'document', old.id,
        jsonb_build_object('name', old.display_name));
    end if;
    return old;
  end if;
  if new.status <> 'ready' then return new; end if;
  if new.display_name is distinct from old.display_name then
    perform public.dms_audit_write(new.workspace_id, 'document.renamed', 'document', new.id,
      jsonb_build_object('from', old.display_name, 'to', new.display_name));
  end if;
  if new.folder_id is distinct from old.folder_id then
    perform public.dms_audit_write(new.workspace_id, 'document.moved', 'document', new.id,
      jsonb_build_object('to', new.folder_id));
  end if;
  if new.starred is distinct from old.starred then
    perform public.dms_audit_write(new.workspace_id,
      case when new.starred then 'document.starred' else 'document.unstarred' end, 'document', new.id);
  end if;
  if new.category is distinct from old.category then
    perform public.dms_audit_write(new.workspace_id, 'document.category_changed', 'document', new.id,
      jsonb_build_object('to', new.category));
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    perform public.dms_audit_write(new.workspace_id, 'document.deleted', 'document', new.id);
  elsif old.deleted_at is not null and new.deleted_at is null then
    perform public.dms_audit_write(new.workspace_id, 'document.restored', 'document', new.id);
  end if;
  return new;
end $$;
create trigger documents_audit after update or delete on public.documents
  for each row execute function public.dms_documents_audit();

create or replace function public.dms_versions_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare doc_name text;
begin
  if old.status = 'pending' and new.status = 'ready' then
    select display_name into doc_name from public.documents where id = new.document_id;
    perform public.dms_audit_write(new.workspace_id,
      case when new.version_number > 1 then 'document.version_uploaded' else 'document.uploaded' end,
      'document', new.document_id,
      jsonb_build_object('name', doc_name, 'sizeBytes', new.size_bytes, 'version', new.version_number));
  end if;
  return new;
end $$;
create trigger versions_audit after update on public.document_versions
  for each row execute function public.dms_versions_audit();

create or replace function public.dms_folders_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not new.is_system then
      perform public.dms_audit_write(new.workspace_id, 'folder.created', 'folder', new.id,
        jsonb_build_object('name', new.name));
    end if;
  elsif tg_op = 'UPDATE' then
    if new.name is distinct from old.name then
      perform public.dms_audit_write(new.workspace_id, 'folder.renamed', 'folder', new.id,
        jsonb_build_object('from', old.name, 'to', new.name));
    end if;
  else
    perform public.dms_audit_write(old.workspace_id, 'folder.deleted', 'folder', old.id,
      jsonb_build_object('name', old.name));
    return old;
  end if;
  return new;
end $$;
create trigger folders_audit after insert or update or delete on public.document_folders
  for each row execute function public.dms_folders_audit();

-- Workspaces -------------------------------------------------------------
create or replace function public.create_workspace(p_name text, p_display_name text, p_email text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); ws uuid;
begin
  if uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if p_name is null or char_length(trim(p_name)) < 2 or char_length(trim(p_name)) > 80 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  insert into public.workspaces (name, created_by) values (trim(p_name), uid) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, role, display_name, email)
  values (ws, uid, 'owner', coalesce(p_display_name, ''), coalesce(p_email, ''));
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

-- Uploads ----------------------------------------------------------------
-- Quota check and row creation happen under a workspace row lock so two
-- concurrent uploads cannot both squeeze past the limit.
create or replace function public.dms_begin_upload(
  p_workspace uuid, p_document uuid, p_new_document uuid,
  p_original_name text, p_display_name text, p_folder uuid, p_category text,
  p_mime text, p_size bigint, p_nonce text, p_ext text, p_user_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := (select auth.uid());
  quota bigint; used bigint; vn integer; doc public.documents; ver public.document_versions; key text;
begin
  if uid is null or not public.dms_has_role(p_workspace, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_nonce !~ '^[A-Za-z0-9-]{1,40}$' or p_ext !~ '^[a-z0-9]{1,10}$' or p_size <= 0 then
    raise exception 'invalid_upload' using errcode = '22023';
  end if;

  select w.storage_quota_bytes into quota from public.workspaces w where w.id = p_workspace for update;
  select coalesce(sum(v.size_bytes), 0) into used from public.document_versions v where v.workspace_id = p_workspace;
  if used + p_size > quota then
    raise exception 'quota_exceeded' using errcode = 'P0001';
  end if;

  perform set_config('dms.rpc', '1', true);
  if p_document is not null then
    select * into doc from public.documents d
      where d.id = p_document and d.workspace_id = p_workspace and d.status = 'ready' and d.deleted_at is null
      for update;
    if not found then raise exception 'not_found' using errcode = 'P0002'; end if;
    if exists (select 1 from public.document_versions v where v.document_id = doc.id and v.status = 'pending') then
      raise exception 'conflict' using errcode = '40001';
    end if;
    select max(v.version_number) + 1 into vn from public.document_versions v where v.document_id = doc.id;
  else
    insert into public.documents (id, workspace_id, folder_id, original_name, display_name, mime_type,
      size_bytes, category, uploaded_by, uploaded_by_name, status, current_version)
    values (p_new_document, p_workspace, p_folder, p_original_name, p_display_name, p_mime,
      p_size, p_category, uid, coalesce(p_user_name, ''), 'pending', 0)
    returning * into doc;
    vn := 1;
  end if;

  key := p_workspace::text || '/' || doc.id::text || '/v' || vn::text || '-' || p_nonce || '.' || p_ext;
  insert into public.document_versions (workspace_id, document_id, version_number, storage_key, mime_type,
    size_bytes, status, created_by, created_by_name)
  values (p_workspace, doc.id, vn, key, p_mime, p_size, 'pending', uid, coalesce(p_user_name, ''))
  returning * into ver;
  return jsonb_build_object('document', to_jsonb(doc) - 'search_vector' - 'content_text', 'version', to_jsonb(ver));
end $$;

create or replace function public.dms_complete_upload(
  p_workspace uuid, p_document uuid, p_version integer, p_size bigint, p_mime text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); ver public.document_versions; doc public.documents;
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
  perform set_config('dms.rpc', '1', true);
  update public.document_versions set status = 'ready', size_bytes = p_size where id = ver.id;
  update public.documents set status = 'ready', storage_key = ver.storage_key, size_bytes = p_size,
    mime_type = p_mime, current_version = p_version
    where id = p_document and workspace_id = p_workspace returning * into doc;
  return to_jsonb(doc) - 'search_vector' - 'content_text';
end $$;

create or replace function public.dms_abort_upload(p_workspace uuid, p_document uuid, p_version integer)
returns text language plpgsql security definer set search_path = '' as $$
declare uid uuid := (select auth.uid()); ver public.document_versions;
begin
  if uid is null or not public.dms_has_role(p_workspace, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into ver from public.document_versions v
    where v.document_id = p_document and v.workspace_id = p_workspace and v.version_number = p_version
      and v.status = 'pending' for update;
  if not found then return null; end if;
  if ver.created_by is distinct from uid and not public.dms_has_role(p_workspace, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.document_versions where id = ver.id;
  delete from public.documents d where d.id = p_document and d.workspace_id = p_workspace and d.status = 'pending'
    and not exists (select 1 from public.document_versions v where v.document_id = d.id);
  return ver.storage_key;
end $$;

revoke all on function public.dms_begin_upload(uuid, uuid, uuid, text, text, uuid, text, text, bigint, text, text, text),
  public.dms_complete_upload(uuid, uuid, integer, bigint, text),
  public.dms_abort_upload(uuid, uuid, integer) from public, anon;
grant execute on function public.dms_begin_upload(uuid, uuid, uuid, text, text, uuid, text, text, bigint, text, text, text),
  public.dms_complete_upload(uuid, uuid, integer, bigint, text),
  public.dms_abort_upload(uuid, uuid, integer) to authenticated;

-- Queries (SECURITY INVOKER: RLS applies) ---------------------------------
-- Filename + metadata + tag search. Document *content* is not searched:
-- documents.content_text / search_vector are reserved for a later extraction pipeline.
create or replace function public.dms_query_documents(
  p_workspace uuid, p_view text, p_folder uuid, p_search text, p_category text,
  p_file_type text, p_tag text, p_sort text, p_page integer, p_size integer)
returns table (doc jsonb, total bigint)
language sql stable set search_path = '' as $$
  with base as (
    select d.*,
      lower(coalesce(substring(d.original_name from '\.([^.]+)$'), '')) as ext,
      coalesce((select array_agg(t.name order by t.name)
                from public.document_tag_assignments a
                join public.document_tags t on t.id = a.tag_id and t.workspace_id = a.workspace_id
                where a.document_id = d.id), '{}'::text[]) as tags
    from public.documents d
    where d.workspace_id = p_workspace and d.status = 'ready'
      and ((p_view = 'trash') = (d.deleted_at is not null))
      and (p_view <> 'starred' or d.starred)
      and (p_view <> 'recent' or d.created_at >= now() - interval '30 days')
      and (p_folder is null or d.folder_id = p_folder)
      and (p_category is null or d.category = p_category)
  ), filtered as (
    select * from base b
    where (p_tag is null or exists (select 1 from unnest(b.tags) x where lower(x) = lower(p_tag)))
      and (p_file_type is null or case p_file_type
            when 'pdf' then b.ext = 'pdf'
            when 'word' then b.ext in ('docx', 'doc')
            when 'excel' then b.ext in ('xlsx', 'xls')
            when 'csv' then b.ext = 'csv'
            when 'image' then b.mime_type like 'image/%' or b.ext in ('jpg', 'jpeg', 'png')
            when 'other' then not (b.ext in ('pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'jpg', 'jpeg', 'png')
                                   or b.mime_type like 'image/%')
            else false end)
      and (coalesce(trim(p_search), '') = '' or not exists (
            select 1 from regexp_split_to_table(lower(trim(p_search)), '\s+') w
            where not (
              lower(b.display_name) like '%' || regexp_replace(w, '([\\%_])', '\\\1', 'g') || '%'
              or lower(b.original_name) like '%' || regexp_replace(w, '([\\%_])', '\\\1', 'g') || '%'
              or lower(b.uploaded_by_name) like '%' || regexp_replace(w, '([\\%_])', '\\\1', 'g') || '%'
              or b.ext like '%' || regexp_replace(w, '([\\%_])', '\\\1', 'g') || '%'
              or (case b.category when 'invoice' then 'invoice' when 'receipt' then 'receipt'
                    when 'tax' then 'tax document' when 'contract' then 'contract'
                    when 'hr' then 'hr document' else 'other' end)
                  like '%' || regexp_replace(w, '([\\%_])', '\\\1', 'g') || '%'
              or exists (select 1 from unnest(b.tags) x
                         where lower(x) like '%' || regexp_replace(w, '([\\%_])', '\\\1', 'g') || '%')
            )))
  )
  select to_jsonb(f) - 'search_vector' - 'content_text' - 'ext' as doc, count(*) over () as total
  from filtered f
  order by
    case when p_sort = 'newest' then f.created_at end desc,
    case when p_sort = 'oldest' then f.created_at end asc,
    case when p_sort = 'name-asc' then lower(f.display_name) end asc,
    case when p_sort = 'name-desc' then lower(f.display_name) end desc,
    case when p_sort = 'size-desc' then f.size_bytes end desc,
    case when p_sort = 'size-asc' then f.size_bytes end asc,
    f.id
  limit least(greatest(p_size, 1), 100)
  offset (greatest(p_page, 1) - 1) * least(greatest(p_size, 1), 100)
$$;

create or replace function public.dms_get_document(p_workspace uuid, p_document uuid)
returns jsonb language sql stable set search_path = '' as $$
  select to_jsonb(d) - 'search_vector' - 'content_text'
         || jsonb_build_object('tags', coalesce((select array_agg(t.name order by t.name)
              from public.document_tag_assignments a
              join public.document_tags t on t.id = a.tag_id and t.workspace_id = a.workspace_id
              where a.document_id = d.id), '{}'::text[]))
  from public.documents d where d.id = p_document and d.workspace_id = p_workspace
$$;

create or replace function public.dms_set_tags(p_workspace uuid, p_document uuid, p_tags text[])
returns text[] language plpgsql set search_path = '' as $$
declare wanted text[];
begin
  if not exists (select 1 from public.documents d where d.id = p_document and d.workspace_id = p_workspace) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(distinct lower(x)), '{}') into wanted from unnest(p_tags) x;
  insert into public.document_tags (workspace_id, name)
    select p_workspace, x from unnest(p_tags) x
    on conflict (workspace_id, lower(name)) do nothing;
  delete from public.document_tag_assignments a
    where a.document_id = p_document
      and a.tag_id not in (select t.id from public.document_tags t
                           where t.workspace_id = p_workspace and lower(t.name) = any (wanted));
  insert into public.document_tag_assignments (document_id, tag_id, workspace_id, created_by)
    select p_document, t.id, p_workspace, (select auth.uid()) from public.document_tags t
    where t.workspace_id = p_workspace and lower(t.name) = any (wanted)
    on conflict do nothing;
  update public.documents set updated_at = now() where id = p_document and workspace_id = p_workspace;
  return array(select t.name from public.document_tag_assignments a
               join public.document_tags t on t.id = a.tag_id and t.workspace_id = a.workspace_id
               where a.document_id = p_document order by t.name);
end $$;

create or replace function public.dms_list_tags(p_workspace uuid)
returns text[] language sql stable set search_path = '' as $$
  select coalesce(array_agg(distinct t.name order by t.name), '{}') from public.document_tags t
  where t.workspace_id = p_workspace and exists (
    select 1 from public.document_tag_assignments a join public.documents d on d.id = a.document_id
    where a.tag_id = t.id and d.deleted_at is null)
$$;

create or replace function public.dms_usage(p_workspace uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'usedBytes', coalesce((select sum(v.size_bytes) from public.document_versions v where v.workspace_id = p_workspace), 0),
    'quotaBytes', coalesce((select w.storage_quota_bytes from public.workspaces w where w.id = p_workspace), 0),
    'documentCount', (select count(*) from public.documents d
                      where d.workspace_id = p_workspace and d.status = 'ready' and d.deleted_at is null),
    'trashCount', (select count(*) from public.documents d
                   where d.workspace_id = p_workspace and d.status = 'ready' and d.deleted_at is not null))
$$;

create or replace function public.dms_folder_counts(p_workspace uuid)
returns table (folder_id uuid, n bigint) language sql stable set search_path = '' as $$
  select d.folder_id, count(*) from public.documents d
  where d.workspace_id = p_workspace and d.status = 'ready' and d.deleted_at is null and d.folder_id is not null
  group by d.folder_id
$$;

-- Hard delete. Returns every storage key so the caller can remove the objects.
create or replace function public.dms_purge_document(p_workspace uuid, p_document uuid)
returns text[] language plpgsql set search_path = '' as $$
declare keys text[]; n integer;
begin
  select array_agg(v.storage_key) into keys from public.document_versions v
    where v.document_id = p_document and v.workspace_id = p_workspace;
  delete from public.documents d
    where d.id = p_document and d.workspace_id = p_workspace and d.deleted_at is not null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found' using errcode = 'P0002'; end if;
  return coalesce(keys, '{}');
end $$;

grant execute on function public.dms_query_documents(uuid, text, uuid, text, text, text, text, text, integer, integer),
  public.dms_get_document(uuid, uuid), public.dms_set_tags(uuid, uuid, text[]), public.dms_list_tags(uuid),
  public.dms_usage(uuid), public.dms_folder_counts(uuid), public.dms_purge_document(uuid, uuid)
  to authenticated;
revoke all on function public.dms_query_documents(uuid, text, uuid, text, text, text, text, text, integer, integer),
  public.dms_get_document(uuid, uuid), public.dms_set_tags(uuid, uuid, text[]), public.dms_list_tags(uuid),
  public.dms_usage(uuid), public.dms_folder_counts(uuid), public.dms_purge_document(uuid, uuid)
  from public, anon;

-- Share links: resolved only by the server with the service-role key. ------
create or replace function public.dms_resolve_share(p_token_hash text)
returns table (storage_key text, display_name text, mime_type text, workspace_id uuid, document_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  return query
  select v.storage_key, d.display_name, v.mime_type, d.workspace_id, d.id
  from public.document_share_links l
  join public.documents d on d.id = l.document_id and d.workspace_id = l.workspace_id
  join public.document_versions v on v.document_id = d.id and v.version_number = d.current_version
  where l.token_hash = p_token_hash and l.revoked_at is null and l.expires_at > now()
    and d.status = 'ready' and d.deleted_at is null and v.status = 'ready';
end $$;
revoke all on function public.dms_resolve_share(text) from public, anon, authenticated;
grant execute on function public.dms_resolve_share(text) to service_role;
