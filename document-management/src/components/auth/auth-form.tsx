"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { safeNext } from "@/lib/safe-redirect";
import { signInSchema } from "@/lib/dms/validation";

const signUpSchema = signInSchema.extend({ fullName: z.string().trim().min(2, "Enter your name").max(80) });
type SignInValues = z.infer<typeof signInSchema>;
type SignUpValues = z.infer<typeof signUpSchema>;

export function AuthForm({ mode, next }: { mode: "login" | "signup"; next?: string }) {
  const router = useRouter();
  const [formError, setFormError] = useState("");
  const [info, setInfo] = useState("");
  const isSignup = mode === "signup";
  const form = useForm<SignUpValues>({
    resolver: zodResolver(isSignup ? signUpSchema : (signInSchema as unknown as typeof signUpSchema)),
    defaultValues: { email: "", password: "", fullName: "" },
  });
  const { register, handleSubmit, formState } = form;

  const submit = handleSubmit(async (values: SignInValues & Partial<SignUpValues>) => {
    setFormError("");
    setInfo("");
    const supabase = createBrowserSupabase();
    if (isSignup) {
      const { data, error } = await supabase.auth.signUp({
        email: values.email,
        password: values.password,
        options: {
          data: { full_name: values.fullName },
          emailRedirectTo: `${window.location.origin}/auth/callback`,
        },
      });
      if (error) return setFormError(error.message);
      if (!data.session) return setInfo("Check your email to confirm your account, then sign in.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: values.email, password: values.password });
      if (error) return setFormError("Incorrect email or password.");
    }
    router.replace(safeNext(next));
    router.refresh();
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {isSignup && (
        <Field id="fullName" label="Full name" error={formState.errors.fullName?.message}>
          <Input id="fullName" autoComplete="name" aria-invalid={!!formState.errors.fullName} {...register("fullName")} />
        </Field>
      )}
      <Field id="email" label="Email" error={formState.errors.email?.message}>
        <Input id="email" type="email" autoComplete="email" aria-invalid={!!formState.errors.email} {...register("email")} />
      </Field>
      <Field id="password" label="Password" error={formState.errors.password?.message}>
        <Input
          id="password"
          type="password"
          autoComplete={isSignup ? "new-password" : "current-password"}
          aria-invalid={!!formState.errors.password}
          {...register("password")}
        />
      </Field>
      {formError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-destructive">
          {formError}
        </p>
      )}
      {info && (
        <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {info}
        </p>
      )}
      <Button type="submit" variant="gradient" className="w-full" disabled={formState.isSubmitting}>
        {formState.isSubmitting ? "Please wait…" : isSignup ? "Create account" : "Sign in"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">
        {isSignup ? "Already have an account? " : "New to Aurum Ventura? "}
        <Link href={isSignup ? "/login" : "/signup"} className="font-medium text-primary hover:underline">
          {isSignup ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </form>
  );
}

function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
