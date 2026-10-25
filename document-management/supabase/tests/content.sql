-- Content search (migration 0007). Included from rls.sql (\ir) after hardening.sql;
-- uses its helpers and psql variables (alice owner, erin admin, dave editor, carol viewer of A; bob owner of B).
\set c1 '''30000000-0000-4000-8000-000000000001'''
\set c2 '''30000000-0000-4000-8000-000000000002'''
\set c3 '''30000000-0000-4000-8000-000000000003'''
\set c4 '''30000000-0000-4000-8000-000000000004'''
\set b1 '''30000000-0000-4000-8000-0000000000b1'''

reset role;
insert into public.documents (id, workspace_id, original_name, display_name, mime_type, size_bytes, status, current_version, uploaded_by_name) values
  (:c1, :'wsa', 'lease-agreement.pdf', 'lease-agreement.pdf', 'application/pdf', 100, 'ready', 1, 'Alice'),
  (:c2, :'wsa', 'notes.txt', 'notes.txt', 'text/plain', 100, 'ready', 1, 'Alice'),
  (:c3, :'wsa', 'scan.png', 'scan.png', 'image/png', 100, 'ready', 1, 'Alice'),
  (:c4, :'wsa', 'zebra-report.pdf', 'zebra-report.pdf', 'application/pdf', 100, 'ready', 1, 'Alice'),
  (:b1, :'wsb', 'beta-lease.pdf', 'beta-lease.pdf', 'application/pdf', 100, 'ready', 1, 'Bob');
insert into public.document_versions (workspace_id, document_id, version_number, storage_key, mime_type, size_bytes, status)
  values (:'wsa', :c1, 1, 'content-fixture/c1-v1.pdf', 'application/pdf', 100, 'ready');
select t.ok('new documents start with content_status pending',
  (select count(*) from public.documents where id in (:c1, :c2, :c3, :c4) and content_status = 'pending') = 4);

-- ----------------------------------------------------------- who may store text
reset role;
\set vera '''00000000-0000-4000-8000-0000000000c1'''
insert into auth.users (id, email, email_confirmed_at) values (:vera, 'vera@a.test', now());
insert into public.workspace_members (workspace_id, user_id, role, display_name, email) values (:'wsa', :vera, 'viewer', 'Vera', 'vera@a.test');
select t.as_user(:vera);
select t.fails('viewer cannot store content',
  format($q$select public.dms_set_document_content(%L, %L, 1, 'indexed', null, 'hello')$q$, :'wsa', :c1), 'forbidden');
select t.as_user(:bob);
select t.fails('another workspace owner cannot store content',
  format($q$select public.dms_set_document_content(%L, %L, 1, 'indexed', null, 'hello')$q$, :'wsa', :c1), 'forbidden');
select t.fails('anon-style caller without a workspace role is refused for service functions',
  format($q$select public.dms_service_set_document_content(%L, %L, 1, 'indexed', null, 'hello')$q$, :'wsa', :c1), 'permission denied');
select t.fails('authenticated users cannot list the whole system for indexing',
  $q$select * from public.dms_service_list_unindexed(10, true)$q$, 'permission denied');

select t.as_user(:dave);
select t.fails('editors cannot write the content columns directly',
  format($q$update public.documents set content_text = 'forged' where id = %L$q$, :c1), 'protected_column');
select t.fails('editors cannot flip content_status directly',
  format($q$update public.documents set content_status = 'indexed' where id = %L$q$, :c1), 'protected_column');
select t.fails('invalid status is rejected',
  format($q$select public.dms_set_document_content(%L, %L, 1, 'pending', null, 'x')$q$, :'wsa', :c1), 'invalid_status');

-- ----------------------------------------------------------- storing and searching
select t.ok('editor stores extracted text',
  public.dms_set_document_content(:'wsa', :c1, 1, 'indexed', null,
    'The tenant shall pay quarterly rent of 5000 dollars. Termination requires ninety days notice. Contact: harbour@example.com'));
select t.ok('stale version write is ignored (returns false)',
  public.dms_set_document_content(:'wsa', :c1, 2, 'indexed', null, 'old words') = false);
select t.ok('writing to a missing document returns false',
  public.dms_set_document_content(:'wsa', '30000000-0000-4000-8000-0000000000ff', 1, 'indexed', null, 'x') = false);
select t.ok('indexed document is marked indexed with a timestamp and version',
  (select content_status = 'indexed' and content_indexed_at is not null and content_version = 1
   from public.documents where id = :c1));

select t.ok('content word finds the document',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'rent',null,null,null,'newest',1,10) where doc ->> 'id' = '30000000-0000-4000-8000-000000000001') = 1);
select t.ok('results flag a content match and carry a snippet with markers',
  (select (doc ->> 'content_match')::boolean and doc ->> 'snippet' like '%' || chr(57344) || '%' || chr(57345) || '%'
   from public.dms_query_documents(:'wsa','all',null,'rent',null,null,null,'newest',1,10) where doc ->> 'id' = '30000000-0000-4000-8000-000000000001'));
select t.ok('stored text and vector never appear in results',
  (select not (doc ? 'content_text') and not (doc ? 'search_vector') from public.dms_query_documents(:'wsa','all',null,'rent',null,null,null,'newest',1,10) limit 1));
select t.ok('a quoted phrase matches in order',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'"ninety days"',null,null,null,'newest',1,10)) = 1);
select t.ok('a quoted phrase out of order does not match',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'"days ninety"',null,null,null,'newest',1,10)) = 0);
select t.ok('-exclusion removes the document',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'rent -ninety',null,null,null,'newest',1,10)) = 0);
select t.ok('OR matches either word',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'nonexistentword or tenant',null,null,null,'newest',1,10)) = 1);
select t.ok('a word that is not in the text does not match',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'galaxy',null,null,null,'newest',1,10)) = 0);
select t.ok('operator-only input matches nothing and does not error',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'- "" or',null,null,null,'newest',1,10)) = 0);
select t.ok('filename search still works and has no content snippet',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'lease',null,null,null,'newest',1,10)
   where doc ->> 'id' = '30000000-0000-4000-8000-000000000001' and (doc ->> 'content_match')::boolean = false and doc -> 'snippet' = 'null'::jsonb) = 1);

-- ----------------------------------------------------------- unindexed documents never match on content
reset role;
select set_config('dms.rpc', '1', false);
update public.documents set content_text = 'secretzebra hidden words' where id = :c2;
select set_config('dms.rpc', '', false);   -- superuser fixture; status stays pending
select t.as_user(:dave);
select t.ok('a pending document does not match on its text',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'secretzebra',null,null,null,'newest',1,10)) = 0);
select t.ok('unsupported documents are recorded without text',
  public.dms_set_document_content(:'wsa', :c3, 1, 'unsupported', 'unsupported_type', 'should be ignored'));
select t.ok('unsupported status keeps no text',
  (select content_status = 'unsupported' and content_text is null and content_reason = 'unsupported_type' from public.documents where id = :c3));
select t.ok('failed documents are recorded without text',
  public.dms_set_document_content(:'wsa', :c4, 1, 'failed', 'timeout', 'ignored'));
select t.ok('failed status keeps no text',
  (select content_status = 'failed' and content_text is null from public.documents where id = :c4));

-- ----------------------------------------------------------- sanitising and limits
select t.ok('indexing text without any letters or digits becomes unsupported',
  public.dms_set_document_content(:'wsa', :c2, 1, 'indexed', null, '--- !!! ...'));
select t.ok('...with reason no_text_found and no stored text',
  (select content_status = 'unsupported' and content_reason = 'no_text_found' and content_text is null from public.documents where id = :c2));
select t.ok('snippet delimiters and control characters are stripped from stored text',
  public.dms_set_document_content(:'wsa', :c2, 1, 'indexed', null, 'before' || chr(57344) || 'inject' || chr(57345) || ' after' || chr(1) || 'tail <script>alert(1)</script>'));
select t.ok('stored text has no delimiter or control characters',
  (select content_text !~ (chr(57344) || '|' || chr(57345)) and content_text !~ '[\x01-\x08]' from public.documents where id = :c2));
select t.ok('snippets contain no tags (ts_headline drops them) and the database adds no HTML',
  (select doc ->> 'snippet' is not null and doc ->> 'snippet' not like '%<%>%'
   from public.dms_query_documents(:'wsa','all',null,'tail',null,null,null,'newest',1,10) where doc ->> 'id' = '30000000-0000-4000-8000-000000000002'));
select t.ok('very long text is truncated to 400000 characters and flagged',
  public.dms_set_document_content(:'wsa', :c4, 1, 'indexed', null, repeat('lorem ipsum ', 60000)));
select t.ok('truncation recorded',
  (select char_length(content_text) = 400000 and content_reason = 'truncated' from public.documents where id = :c4));

-- ----------------------------------------------------------- isolation
select t.as_user(:bob);
select t.ok('another workspace cannot search A''s content by RPC',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'rent',null,null,null,'newest',1,10)) = 0);
select t.ok('...nor see its own documents matching A''s words',
  (select count(*) from public.dms_query_documents(:'wsb','all',null,'rent',null,null,null,'newest',1,10)) = 0);
select t.as_user(:vera);
select t.ok('viewers can search content',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'tenant',null,null,null,'newest',1,10)) = 1);

-- ----------------------------------------------------------- relevance
select t.as_user(:dave);
select t.ok('relevance puts filename matches before content-only matches',
  (select doc ->> 'id' from public.dms_query_documents(:'wsa','all',null,'lease',null,null,null,'relevance',1,10) limit 1) = '30000000-0000-4000-8000-000000000001');
select t.ok('relevance works for a content-only query',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'lorem',null,null,null,'relevance',1,10)) = 1);
select t.ok('paging reports the full total',
  (select max(total) from public.dms_query_documents(:'wsa','all',null,'lorem or tenant',null,null,null,'relevance',1,1)) = 2);

-- ----------------------------------------------------------- new versions invalidate text
select public.dms_begin_upload(:'wsa', :c1, null, 'lease-agreement.pdf', 'lease-agreement.pdf', null, 'other',
  'application/pdf', 500, 'cv2', 'pdf', 'Dave') as cv \gset
select (:'cv'::jsonb -> 'version' ->> 'storage_key') as ckey \gset
reset role;
insert into storage.objects (bucket_id, name, owner, metadata) values ('documents', :'ckey', :dave, '{"size": 500}');
select t.as_user(:dave);
select t.ok('completing a new version succeeds', public.dms_complete_upload(:'wsa', :c1, 2, 500, 'application/pdf') is not null);
select t.ok('the old text is cleared and the document is pending again',
  (select content_status = 'pending' and content_text is null and content_version is null from public.documents where id = :c1));
select t.ok('old text no longer matches',
  (select count(*) from public.dms_query_documents(:'wsa','all',null,'tenant',null,null,null,'newest',1,10)) = 0);
select t.ok('a late write for the previous version is ignored',
  public.dms_set_document_content(:'wsa', :c1, 1, 'indexed', null, 'tenant returns') = false);
select t.ok('the new version can be indexed',
  public.dms_set_document_content(:'wsa', :c1, 2, 'indexed', null, 'amended tenant clause'));

-- ----------------------------------------------------------- work queues
select t.ok('editors list pending documents of their workspace',
  (select count(*) from public.dms_list_unindexed(:'wsa', 50, false)) >= 1);
select t.ok('...which excludes indexed, unsupported and failed ones',
  (select count(*) from public.dms_list_unindexed(:'wsa', 50, false) where document_id in (:c1, :c3, :c4)) = 0);
select public.dms_set_document_content(:'wsa', :c4, 1, 'failed', 'timeout', null);
select t.ok('...and includes failed ones when asked',
  (select count(*) from public.dms_list_unindexed(:'wsa', 50, true) where document_id = :c4) = 1);
select t.as_user(:bob);
select t.ok('another workspace sees none of them',
  (select count(*) from public.dms_list_unindexed(:'wsa', 50, true)) = 0);

reset role; set role service_role;
select t.ok('service role lists unindexed documents across workspaces',
  (select count(*) from public.dms_service_list_unindexed(100, true) where document_id = :b1) = 1);
select t.ok('service role can store content',
  public.dms_service_set_document_content(:'wsb', :b1, 1, 'indexed', null, 'beta lease text'));
reset role;
select t.ok('...and it is stored', (select content_status = 'indexed' from public.documents where id = :b1));
