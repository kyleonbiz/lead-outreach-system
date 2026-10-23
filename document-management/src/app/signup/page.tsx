import type { Metadata } from "next";
import { AuthCard } from "@/components/auth/auth-card";
import { AuthForm } from "@/components/auth/auth-form";
import { getSupabaseEnv } from "@/lib/supabase/env";

export const metadata: Metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <AuthCard title="Create your account" subtitle="Start organizing documents securely.">
      {getSupabaseEnv() ? (
        <AuthForm mode="signup" />
      ) : (
        <p className="text-sm text-muted-foreground">
          Authentication is not configured. Set the Supabase environment variables (see README) to enable sign-up.
        </p>
      )}
    </AuthCard>
  );
}
