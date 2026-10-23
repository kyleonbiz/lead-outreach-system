-- Aurum Ventura Document Management: core schema.
-- Every client-owned row carries workspace_id; composite foreign keys keep
-- child rows in the same workspace as their parent.

create extension if not exists pg_trgm with schema extensions;

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 80),
  storage_quota_bytes bigint not null default 5368709120 check (storage_quota_bytes >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('viewer', 'editor', 'admin', 'owner')),
  display_name text not null default '',
  email text not null default '',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);

create table public.document_folders (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  color text not null default 'violet'
    check (color in ('violet','blue','emerald','amber','rose','sky','orange','slate')),
  is_system boolean not null default false,
  default_category text
    check (default_category in ('invoice','receipt','tax','contract','hr','other')),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index document_folders_name_idx on public.document_folders (workspace_id, lower(name));

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  folder_id uuid,
  original_name text not null check (char_length(original_name) between 1 and 200),
  display_name text not null check (char_length(display_name) between 1 and 200),
  storage_key text not null default '',
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  category text not null default 'other'
    check (category in ('invoice','receipt','tax','contract','hr','other')),
  uploaded_by uuid references auth.users (id) on delete set null,
  uploaded_by_name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz,
  starred boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'ready')),
  deleted_at timestamptz,
  current_version integer not null default 0,
  -- Reserved for a future text-extraction pipeline. Nothing populates or
  -- queries content_text yet; search_vector is built so an index is ready.
  content_text text,
  search_vector tsvector generated always as (
    to_tsvector('simple', coalesce(display_name, '') || ' ' || coalesce(content_text, ''))
  ) stored,
  unique (id, workspace_id),
  foreign key (folder_id, workspace_id)
    references public.document_folders (id, workspace_id) on delete set null (folder_id)
);
create index documents_ws_folder_idx on public.documents (workspace_id, folder_id) where deleted_at is null;
create index documents_ws_created_idx on public.documents (workspace_id, created_at desc);
create index documents_ws_starred_idx on public.documents (workspace_id) where starred and deleted_at is null;
create index documents_display_name_trgm on public.documents using gin (display_name extensions.gin_trgm_ops);
create index documents_search_vector_idx on public.documents using gin (search_vector);

create table public.document_versions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  version_number integer not null check (version_number >= 1),
  storage_key text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  status text not null default 'pending' check (status in ('pending', 'ready')),
  created_by uuid references auth.users (id) on delete set null,
  created_by_name text not null default '',
  created_at timestamptz not null default now(),
  unique (document_id, version_number),
  foreign key (document_id, workspace_id)
    references public.documents (id, workspace_id) on delete cascade
);
create index document_versions_ws_idx on public.document_versions (workspace_id);

create table public.document_tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 32),
  created_at timestamptz not null default now(),
  unique (id, workspace_id)
);
create unique index document_tags_name_idx on public.document_tags (workspace_id, lower(name));

create table public.document_tag_assignments (
  document_id uuid not null,
  tag_id uuid not null,
  workspace_id uuid not null,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (document_id, tag_id),
  foreign key (document_id, workspace_id)
    references public.documents (id, workspace_id) on delete cascade,
  foreign key (tag_id, workspace_id)
    references public.document_tags (id, workspace_id) on delete cascade
);
create index document_tag_assignments_tag_idx on public.document_tag_assignments (tag_id);
create index document_tag_assignments_ws_idx on public.document_tag_assignments (workspace_id);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id uuid,
  action text not null,
  entity_type text not null check (entity_type in ('document', 'folder', 'workspace')),
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_ws_created_idx on public.audit_logs (workspace_id, created_at desc);

-- Share links store only a SHA-256 hash of the token.
create table public.document_share_links (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  document_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (document_id, workspace_id)
    references public.documents (id, workspace_id) on delete cascade
);
create index document_share_links_doc_idx on public.document_share_links (document_id);

create or replace function public.dms_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger workspaces_touch before update on public.workspaces
  for each row execute function public.dms_touch_updated_at();
create trigger documents_touch before update on public.documents
  for each row execute function public.dms_touch_updated_at();
