"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createBrowserSupabase } from "@/lib/supabase/browser";
import { createWorkspaceSchema } from "@/lib/dms/validation";
import type { z } from "zod";

type Values = z.infer<typeof createWorkspaceSchema>;

export function OnboardingForm({ displayName, email }: { displayName: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const { register, handleSubmit, formState } = useForm<Values>({
    resolver: zodResolver(createWorkspaceSchema),
    defaultValues: { name: "" },
  });

  const submit = handleSubmit(async ({ name }) => {
    setError("");
    const { error: rpcError } = await createBrowserSupabase().rpc("create_workspace", {
      p_name: name,
      p_display_name: displayName,
      p_email: email,
    });
    if (rpcError) return setError(rpcError.message.includes("workspace_limit") ? "You already own the maximum number of workspaces." : "Could not create the workspace. Please try again.");
    router.refresh();
  });

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="ws-name">Workspace name</Label>
        <Input id="ws-name" placeholder="e.g. Harbor Property Group" autoFocus aria-invalid={!!formState.errors.name} {...register("name")} />
        {formState.errors.name && (
          <p role="alert" className="text-xs text-destructive">
            {formState.errors.name.message}
          </p>
        )}
      </div>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" variant="gradient" className="w-full" disabled={formState.isSubmitting}>
        {formState.isSubmitting ? "Creating…" : "Create workspace"}
      </Button>
    </form>
  );
}
