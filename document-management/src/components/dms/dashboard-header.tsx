import { Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { StorageUsage } from "@/lib/dms/types";
import { StorageUsageIndicator } from "./storage-usage-indicator";

export function DashboardHeader({
  usage,
  canUpload,
  onUpload,
  onTeam,
}: {
  usage: StorageUsage | null;
  canUpload: boolean;
  onUpload: () => void;
  /** Present only when the caller may manage the team. */
  onTeam?: () => void;
}) {
  return (
    <header className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <h2 className="text-2xl font-bold tracking-tight sm:text-[28px]">Document Management</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Organize, store, and manage your business documents securely.
        </p>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        {usage && (
          <div className="rounded-xl border bg-card px-4 py-2.5 shadow-sm sm:w-56">
            <StorageUsageIndicator usage={usage} compact />
          </div>
        )}
        {onTeam && (
          <Button variant="outline" onClick={onTeam} className="w-full sm:w-auto">
            <Users /> Team
          </Button>
        )}
        <Button
          variant="gradient"
          onClick={onUpload}
          disabled={!canUpload}
          title={canUpload ? undefined : "Your role cannot upload documents"}
          className="w-full sm:w-auto"
        >
          <Upload /> Upload
        </Button>
      </div>
    </header>
  );
}
