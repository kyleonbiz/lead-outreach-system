import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthForm } from "@/components/auth/auth-form";
import { getSupabaseEnv } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  return (
    <AuthCard title="Sign in" subtitle="Access your Aurum Ventura document workspace.">
      {getSupabaseEnv() ? (
        <AuthForm mode="login" next={typeof next === "string" ? next : undefined} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Authentication is not configured. Set the Supabase environment variables (see README) to enable sign-in.
        </p>
      )}
    </AuthCard>
  );
}
