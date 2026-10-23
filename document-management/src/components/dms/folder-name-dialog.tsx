"use client";

import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { folderNameSchema } from "@/lib/dms/validation";

const schema = z.object({ name: folderNameSchema });
type Values = z.infer<typeof schema>;

/** Create or rename a folder. `initialName` present means rename. */
export function FolderNameDialog({
  open,
  initialName,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  initialName?: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => Promise<void>;
}) {
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { name: initialName ?? "" } });
  const { register, handleSubmit, reset, setError, formState } = form;

  useEffect(() => {
    if (open) reset({ name: initialName ?? "" });
  }, [open, initialName, reset]);

  const submit = handleSubmit(async ({ name }) => {
    try {
      await onSubmit(name);
      onOpenChange(false);
    } catch (e) {
      setError("name", { message: e instanceof Error ? e.message : "Could not save the folder." });
    }
  });

  const rename = initialName !== undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="alert">
        <DialogTitle>{rename ? "Rename folder" : "New folder"}</DialogTitle>
        <DialogDescription className="mt-1">
          {rename ? "Choose a new name for this folder." : "Folders help you group related documents."}
        </DialogDescription>
        <form onSubmit={submit} className="mt-4 space-y-4" noValidate>
          <div className="space-y-1.5">
            <Label htmlFor="folder-name">Folder name</Label>
            <Input
              id="folder-name"
              autoFocus
              autoComplete="off"
              aria-invalid={!!formState.errors.name}
              aria-describedby={formState.errors.name ? "folder-name-error" : undefined}
              {...register("name")}
            />
            {formState.errors.name && (
              <p id="folder-name-error" role="alert" className="text-xs text-destructive">
                {formState.errors.name.message}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={formState.isSubmitting}>
              {rename ? "Save" : "Create folder"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
