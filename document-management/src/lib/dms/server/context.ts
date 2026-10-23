import "server-only";
import { DocumentService } from "../service";
import { DmsError } from "../errors";
import { loadUploadLimits } from "../config";
import { SupabaseRepository } from "../supabase/repository";
import { SupabaseStorage } from "../supabase/storage";
import { SAMPLE_USER_ID, SAMPLE_WORKSPACE_ID } from "../memory/sample-data";
import { devModeAllowed, getSupabaseEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Role } from "../types";
import { getDevKit } from "./dev-store";

export interface Dms {
  mode: "live" | "dev";
  userId: string;
  service: DocumentService;
}

export interface Membership {
  workspaceId: string;
  role: Role;
  displayName: string;
}

/** The signed-in user's first workspace, or null if they have none yet. */
export async function findMembership(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  userId: string,
): Promise<Membership | null> {
  const { data, error } = await supabase
    .from("workspace_members")
    .select("workspace_id, role, display_name")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new DmsError("internal", "Could not load your workspace.");
  return data ? { workspaceId: data.workspace_id, role: data.role as Role, displayName: data.display_name } : null;
}

/**
 * Joins the signed-in user to workspaces that invited their verified email.
 * Failure must never block sign-in, so errors are swallowed.
 */
export async function acceptPendingInvites(
  supabase: Awaited<ReturnType<typeof createServerSupabase>>,
  displayName: string,
): Promise<number> {
  const { data, error } = await supabase.rpc("dms_accept_invites", { p_display_name: displayName });
  return error ? 0 : Number(data ?? 0);
}

/**
 * Resolves the caller. With Supabase configured the user is authenticated by
 * the auth server (never trusted from a cookie alone) and all data access runs
 * under their session, so RLS applies.
 */
export async function getDms(): Promise<Dms> {
  if (getSupabaseEnv()) {
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new DmsError("unauthenticated", "Please sign in.");
    const membership = await findMembership(supabase, data.user.id);
    if (!membership) throw new DmsError("not_found", "You do not belong to a workspace yet.");
    const email = data.user.email ?? "";
    const repo = new SupabaseRepository(supabase);
    return {
      mode: "live",
      userId: data.user.id,
      service: new DocumentService({
        repo,
        team: repo,
        storage: new SupabaseStorage(supabase),
        limits: loadUploadLimits(),
        userEmail: email,
        ctx: {
          workspaceId: membership.workspaceId,
          userId: data.user.id,
          userName: membership.displayName || email.split("@")[0] || "User",
          role: membership.role,
        },
      }),
    };
  }
  if (!devModeAllowed()) {
    throw new DmsError("unavailable", "The document service is not configured.");
  }
  const kit = getDevKit();
  return {
    mode: "dev",
    userId: SAMPLE_USER_ID,
    service: new DocumentService({
      repo: kit.repo,
      team: kit.repo,
      storage: kit.storage,
      limits: loadUploadLimits(),
      userEmail: "dev@localhost",
      ctx: { workspaceId: SAMPLE_WORKSPACE_ID, userId: SAMPLE_USER_ID, userName: "Dev User", role: "owner" },
    }),
  };
}
