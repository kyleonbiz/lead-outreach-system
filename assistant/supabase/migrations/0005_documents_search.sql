-- 0005_documents_search.sql
-- Document text chunks + full-text search over chunks and the knowledge base.
-- Full-text search (no embeddings) keeps this free of extra services and cost; swap in pgvector later if needed.

alter table public.documents
  add column source text not null default 'upload' check (source in ('upload', 'generated')),
  add column error text,
  add column text_chars int;

create table public.document_chunks (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  document_id  uuid not null,
  chunk_index  int not null check (chunk_index >= 0),
  content      text not null check (char_length(content) <= 8000),
  tsv          tsvector generated always as (to_tsvector('english', content)) stored,
  unique (document_id, chunk_index),
  foreign key (document_id, org_id) references public.documents (id, org_id) on delete cascade
);
create index document_chunks_tsv_idx on public.document_chunks using gin (tsv);
create index document_chunks_org_idx on public.document_chunks (org_id, document_id);

alter table public.knowledge_base_sources
  add column tsv tsvector generated always as (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))) stored;
create index knowledge_base_tsv_idx on public.knowledge_base_sources using gin (tsv);

alter table public.document_chunks enable row level security;
create policy document_chunks_select on public.document_chunks for select to authenticated
  using (private.is_org_member(org_id));
-- chunks are written by the server (service role) only
grant select on public.document_chunks to authenticated;

-- Search. SECURITY INVOKER: RLS limits results to the caller's organizations; p_org narrows to one.
create or replace function public.search_knowledge(p_org uuid, p_query text, p_limit int default 5)
returns table (source text, id uuid, title text, snippet text, rank real)
language sql stable security invoker
set search_path = ''
as $$
  with q as (select websearch_to_tsquery('english', left(p_query, 300)) as tsq)
  select * from (
    select 'knowledge'::text as source, k.id, k.title,
           ts_headline('english', k.content, q.tsq, 'MaxFragments=2, MaxWords=40, MinWords=10') as snippet,
           ts_rank_cd(k.tsv, q.tsq) as rank
    from public.knowledge_base_sources k, q
    where k.org_id = p_org and k.is_active and k.tsv @@ q.tsq
    union all
    select 'document'::text, d.id, d.name,
           ts_headline('english', c.content, q.tsq, 'MaxFragments=2, MaxWords=40, MinWords=10'),
           ts_rank_cd(c.tsv, q.tsq)
    from public.document_chunks c
    join public.documents d on d.id = c.document_id and d.org_id = c.org_id, q
    where c.org_id = p_org and c.tsv @@ q.tsq
  ) r
  order by rank desc
  limit least(greatest(p_limit, 1), 25);
$$;
revoke all on function public.search_knowledge(uuid, text, int) from public, anon;
grant execute on function public.search_knowledge(uuid, text, int) to authenticated, service_role;

-- Uploaders can remove their own files (admins can remove any), so deleting a document row never orphans the file.
drop policy documents_objects_delete on storage.objects;
create policy documents_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and (
    private.has_org_role(private.storage_org(name), array['owner', 'admin'])
    or exists (select 1 from public.documents d where d.storage_path = name and d.uploaded_by = (select auth.uid()))
  ));
