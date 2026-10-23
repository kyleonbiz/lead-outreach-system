import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-header";
import { AuthCard } from "@/components/auth/auth-card";
import { OnboardingForm } from "@/components/auth/onboarding-form";
import { LiveWorkspace } from "@/components/dms/live-workspace";
import { acceptPendingInvites, findMembership } from "@/lib/dms/server/context";
import { devModeAllowed, getSupabaseEnv } from "@/lib/supabase/env";
import { createServerSupabase } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Documents" };
export const dynamic = "force-dynamic";

export default async function AppPage() {
  if (getSupabaseEnv()) {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getUser();
    if (!data.user) redirect("/login?next=/app");
    const email = data.user.email ?? "";
    const fullName = (data.user.user_metadata?.full_name as string | undefined) ?? email.split("@")[0];
    // Pending invites for this (verified) email take effect before onboarding is offered.
    await acceptPendingInvites(supabase, fullName);
    const membership = await findMembership(supabase, data.user.id);
    if (!membership) {
      return (
        <AuthCard title="Create your workspace" subtitle="A workspace holds your team's documents, folders and storage.">
          <OnboardingForm displayName={fullName} email={email} />
        </AuthCard>
      );
    }
    const { data: ws } = await supabase.from("workspaces").select("name").eq("id", membership.workspaceId).maybeSingle();
    return (
      <div className="min-h-dvh">
        <AppHeader workspaceName={ws?.name} userLabel={email} />
        <main className="mx-auto max-w-7xl px-3 py-6 sm:px-6">
          <LiveWorkspace mode="live" />
        </main>
      </div>
    );
  }

  if (!devModeAllowed()) {
    return (
      <AuthCard title="Not configured" subtitle="This deployment has no database connected.">
        <p className="text-sm text-muted-foreground">
          Set the Supabase environment variables described in the README. Development mode is disabled in production.
        </p>
      </AuthCard>
    );
  }
  return (
    <div className="min-h-dvh">
      <AppHeader badge="Development mode" />
      <main className="mx-auto max-w-7xl px-3 py-6 sm:px-6">
        <LiveWorkspace mode="dev" />
      </main>
    </div>
  );
}
