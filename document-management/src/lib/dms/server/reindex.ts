import type { SupabaseClient } from "@supabase/supabase-js";
import { computeContent, type ContentOutcome } from "../index-content";
import type { ObjectStorage } from "../ports";
import { SupabaseStorage } from "../supabase/storage";

export interface ReindexResult {
  found: number;
  indexed: number;
  unsupported: number;
  failed: number;
  /** Documents whose version changed while we were reading them. */
  skipped: number;
  /** True when the time budget ran out before every found document was handled. */
  incomplete: boolean;
}

interface Row {
  workspace_id: string;
  document_id: string;
  version_number: number;
  storage_key: string;
  file_name: string;
}

/**
 * Service-role backfill: extracts and stores text for documents that are still
 * `pending` (and, if asked, `failed`) across all workspaces. Used by the
 * maintenance route; reports counts only, never names, keys or text.
 */
export async function reindexBatch(
  admin: SupabaseClient,
  opts: { limit: number; includeFailed: boolean; budgetMs: number },
  deps: {
    compute?: (storage: ObjectStorage, file: { storageKey: string; fileName: string }) => Promise<ContentOutcome>;
    storage?: ObjectStorage;
    now?: () => number;
  } = {},
): Promise<ReindexResult> {
  const compute = deps.compute ?? computeContent;
  const storage = deps.storage ?? new SupabaseStorage(admin);
  const now = deps.now ?? Date.now;
  const started = now();

  const { data, error } = await admin.rpc("dms_service_list_unindexed", {
    p_limit: opts.limit,
    p_include_failed: opts.includeFailed,
  });
  if (error) throw new Error("list_failed");
  const rows = (data as Row[] | null) ?? [];

  const result: ReindexResult = { found: rows.length, indexed: 0, unsupported: 0, failed: 0, skipped: 0, incomplete: false };
  for (const r of rows) {
    if (now() - started > opts.budgetMs) {
      result.incomplete = true;
      break;
    }
    const outcome = await compute(storage, { storageKey: r.storage_key, fileName: r.file_name });
    const { data: stored, error: storeError } = await admin.rpc("dms_service_set_document_content", {
      p_workspace: r.workspace_id,
      p_document: r.document_id,
      p_version: Number(r.version_number),
      p_status: outcome.status,
      p_reason: outcome.reason,
      p_text: outcome.text,
    });
    if (storeError) result.failed++;
    else if (stored !== true) result.skipped++;
    else result[outcome.status]++;
  }
  return result;
}
