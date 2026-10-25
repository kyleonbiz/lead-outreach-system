-- Document content search.
--
-- Text is extracted by the application server (PDF text layer, DOCX, XLSX, PPTX,
-- CSV, TXT; no OCR) after an upload is finalized, and stored here. A document
-- matches on content ONLY when content_status = 'indexed'; pending, unsupported
-- and failed documents are searchable by filename/metadata only.

-- 1. Status columns -----------------------------------------------------
alter table public.documents
  add column content_status text not null default 'pending'
    check (content_status in ('pending', 'indexed', 'unsupported', 'failed')),
  add column content_reason text check (char_length(content_reason) <= 64),
  add column content_indexed_at timestamptz,
  -- The document version the stored text was extracted from.
  add column content_version integer;

-- 2. Content-only search vector -----------------------------------------
-- The 0001 vector mixed in display_name; filenames are matched by the metadata
-- search instead, so the vector now covers content only. The text is capped at
-- 400,000 characters (also enforced by dms__store_content) so a to_tsvector
-- result stays under PostgreSQL's 1 MB tsvector limit.
drop index public.documents_search_vector_idx;
alter table public.documents drop column search_vector;
alter table public.documents add column search_vector tsvector generated always as (
  to_tsvector('simple', coalesce(left(content_text, 400000), ''))
) stored;
create index documents_search_vector_idx on public.documents using gin (search_vector);
create index documents_ws_content_status_idx on public.documents (workspace_id, content_status)
  where status = 'ready' and deleted_at is null;

-- 3. Guard: clients cannot write content columns directly -----------------
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
     or new.content_text is distinct from old.content_text
     or new.content_status is distinct from old.content_status
     or new.content_reason is distinct from old.content_reason
     or new.content_indexed_at is distinct from old.content_indexed_at
     or new.content_version is distinct from old.content_version then
    raise exception 'protected_column' using errcode = '42501';
  end if;
  return new;
end $$;

-- 4. A new version invalidates the old text -------------------------------
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
    mime_type = ver.mime_type, current_version = p_version,
    content_text = null, content_status = 'pending', content_reason = null,
    content_indexed_at = null, content_version = null
    where id = p_document and workspace_id = p_workspace returning * into doc;
  return to_jsonb(doc) - 'search_vector' - 'content_text';
end $$;

-- 5. Storing extracted text -----------------------------------------------
-- Internal worker. Writes only if the document is still on the version the text
-- came from, so a slow extraction cannot overwrite a newer version's state.
create or replace function public.dms__store_content(
  p_workspace uuid, p_document uuid, p_version integer, p_status text, p_reason text, p_text text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare txt text; reason text := p_reason; n integer;
begin
  if p_status not in ('indexed', 'unsupported', 'failed') then
    raise exception 'invalid_status' using errcode = '22023';
  end if;
  if p_status = 'indexed' then
    -- U+E000 / U+E001 delimit highlighted matches in snippets, so they must not
    -- occur in stored text; control characters and NULs are dropped as well.
    txt := regexp_replace(translate(coalesce(p_text, ''), chr(57344) || chr(57345), ''),
                          '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]', ' ', 'g');
    if char_length(txt) > 400000 then
      txt := left(txt, 400000);
      reason := 'truncated';
    end if;
    if txt !~ '[[:alnum:]]' then
      p_status := 'unsupported'; reason := 'no_text_found'; txt := null;
    end if;
  else
    txt := null;
  end if;

  perform set_config('dms.rpc', '1', true);
  update public.documents d set
    content_text = txt,
    content_status = p_status,
    content_reason = left(reason, 64),
    content_indexed_at = now(),
    content_version = p_version
  where d.id = p_document and d.workspace_id = p_workspace and d.status = 'ready'
    and d.current_version = p_version;
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.dms__store_content(uuid, uuid, integer, text, text, text)
  from public, anon, authenticated;

-- Signed-in editors (the uploader's request indexes right after finalize).
create or replace function public.dms_set_document_content(
  p_workspace uuid, p_document uuid, p_version integer, p_status text, p_reason text, p_text text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not public.dms_has_role(p_workspace, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public.dms__store_content(p_workspace, p_document, p_version, p_status, p_reason, p_text);
end $$;
revoke all on function public.dms_set_document_content(uuid, uuid, integer, text, text, text) from public, anon;
grant execute on function public.dms_set_document_content(uuid, uuid, integer, text, text, text) to authenticated;

-- Maintenance (service role): backfill existing documents and retry failures.
create or replace function public.dms_service_set_document_content(
  p_workspace uuid, p_document uuid, p_version integer, p_status text, p_reason text, p_text text)
returns boolean language sql security definer set search_path = '' as $$
  select public.dms__store_content(p_workspace, p_document, p_version, p_status, p_reason, p_text)
$$;
revoke all on function public.dms_service_set_document_content(uuid, uuid, integer, text, text, text)
  from public, anon, authenticated;
grant execute on function public.dms_service_set_document_content(uuid, uuid, integer, text, text, text)
  to service_role;

create or replace function public.dms_service_list_unindexed(p_limit integer, p_include_failed boolean)
returns table (workspace_id uuid, document_id uuid, version_number integer, storage_key text, file_name text)
language sql stable security definer set search_path = '' as $$
  select d.workspace_id, d.id, d.current_version, d.storage_key, d.original_name
  from public.documents d
  where d.status = 'ready' and d.deleted_at is null
    and (d.content_status = 'pending' or (p_include_failed and d.content_status = 'failed'))
  order by d.created_at, d.id
  limit least(greatest(p_limit, 1), 500)
$$;
revoke all on function public.dms_service_list_unindexed(integer, boolean) from public, anon, authenticated;
grant execute on function public.dms_service_list_unindexed(integer, boolean) to service_role;

-- Editors of one workspace (used by the in-app "index now" flow).
create or replace function public.dms_list_unindexed(p_workspace uuid, p_limit integer, p_include_failed boolean)
returns table (document_id uuid, version_number integer)
language sql stable set search_path = '' as $$
  select d.id, d.current_version
  from public.documents d
  where d.workspace_id = p_workspace and d.status = 'ready' and d.deleted_at is null
    and (d.content_status = 'pending' or (p_include_failed and d.content_status = 'failed'))
  order by d.created_at, d.id
  limit least(greatest(p_limit, 1), 500)
$$;
revoke all on function public.dms_list_unindexed(uuid, integer, boolean) from public, anon;
grant execute on function public.dms_list_unindexed(uuid, integer, boolean) to authenticated;

-- 6. Search ---------------------------------------------------------------
-- A document matches when EVERY whitespace-separated word appears in its
-- filename/metadata/tags (as before) OR the whole query matches its indexed
-- text. The content query uses websearch syntax: "quoted phrases", OR, -exclude.
-- Only documents with content_status = 'indexed' can match on content.
-- p_sort = 'relevance': metadata matches first, then content rank.
-- Snippets are plain text from the stored content; matches are wrapped in
-- U+E000 / U+E001 (which never occur in stored text) and are never HTML.
create or replace function public.dms_query_documents(
  p_workspace uuid, p_view text, p_folder uuid, p_search text, p_category text,
  p_file_type text, p_tag text, p_sort text, p_page integer, p_size integer)
returns table (doc jsonb, total bigint)
language sql stable set search_path = '' as $$
  with q as (
    select websearch_to_tsquery('simple', coalesce(trim(p_search), '')) as tsq,
           coalesce(trim(p_search), '') <> '' as searching
  ), base as (
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
  ), scored as (
    select b.*,
      (not (select searching from q) or not exists (
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
            ))) as meta_match,
      (b.content_status = 'indexed' and (select searching from q)
        and b.search_vector @@ (select tsq from q)) as content_match
    from base b
  ), filtered as (
    select s.*,
      case when s.content_match then ts_rank_cd(s.search_vector, (select tsq from q)) else 0 end as rank
    from scored s
    where (p_tag is null or exists (select 1 from unnest(s.tags) x where lower(x) = lower(p_tag)))
      and (p_file_type is null or case p_file_type
            when 'pdf' then s.ext = 'pdf'
            when 'word' then s.ext in ('docx', 'doc')
            when 'excel' then s.ext in ('xlsx', 'xls')
            when 'csv' then s.ext = 'csv'
            when 'image' then s.mime_type like 'image/%' or s.ext in ('jpg', 'jpeg', 'png')
            when 'other' then not (s.ext in ('pdf', 'docx', 'doc', 'xlsx', 'xls', 'csv', 'jpg', 'jpeg', 'png')
                                   or s.mime_type like 'image/%')
            else false end)
      and (not (select searching from q) or s.meta_match or s.content_match)
  ), paged as (
    select f.*, count(*) over () as total_rows
    from filtered f
    order by
      case when p_sort = 'relevance' then (case when f.meta_match then 1 else 0 end) end desc,
      case when p_sort = 'relevance' then f.rank end desc,
      case when p_sort in ('newest', 'relevance') then f.created_at end desc,
      case when p_sort = 'oldest' then f.created_at end asc,
      case when p_sort = 'name-asc' then lower(f.display_name) end asc,
      case when p_sort = 'name-desc' then lower(f.display_name) end desc,
      case when p_sort = 'size-desc' then f.size_bytes end desc,
      case when p_sort = 'size-asc' then f.size_bytes end asc,
      f.id
    limit least(greatest(p_size, 1), 100)
    offset (greatest(p_page, 1) - 1) * least(greatest(p_size, 1), 100)
  )
  select to_jsonb(p) - 'search_vector' - 'content_text' - 'ext' - 'meta_match' - 'rank' - 'total_rows'
           - 'content_match'
         || jsonb_build_object(
              'content_match', p.content_match,
              'snippet', case when p.content_match then
                  ts_headline('simple', left(p.content_text, 200000), (select tsq from q),
                    'StartSel=' || chr(57344) || ', StopSel=' || chr(57345) ||
                    ', MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "')
                end) as doc,
         p.total_rows as total
  from paged p
  order by
    case when p_sort = 'relevance' then (case when p.meta_match then 1 else 0 end) end desc,
    case when p_sort = 'relevance' then p.rank end desc,
    case when p_sort in ('newest', 'relevance') then p.created_at end desc,
    case when p_sort = 'oldest' then p.created_at end asc,
    case when p_sort = 'name-asc' then lower(p.display_name) end asc,
    case when p_sort = 'name-desc' then lower(p.display_name) end desc,
    case when p_sort = 'size-desc' then p.size_bytes end desc,
    case when p_sort = 'size-asc' then p.size_bytes end asc,
    p.id
$$;
