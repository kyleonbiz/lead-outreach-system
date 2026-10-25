import { HardDrive } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/dms/validation";
import type { StorageUsage } from "@/lib/dms/types";
import { formatPercent } from "./format";
import { cn } from "@/lib/utils";

export function StorageUsageIndicator({
  usage,
  className,
  compact = false,
}: {
  usage: StorageUsage;
  className?: string;
  compact?: boolean;
}) {
  const pct = formatPercent(usage.usedBytes, usage.quotaBytes);
  const nearFull = pct >= 90;
  return (
    <div className={cn("min-w-0", className)} data-testid="storage-usage">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <HardDrive className="size-3.5 text-muted-foreground" aria-hidden />
          <span className="sr-only">Storage used </span>
          <span className="tabular-nums">
            {formatBytes(usage.usedBytes)} / {formatBytes(usage.quotaBytes)}
          </span>
        </span>
        {!compact && <span className={cn("tabular-nums text-muted-foreground", nearFull && "font-medium text-destructive")}>{pct}%</span>}
      </div>
      <Progress
        value={pct}
        aria-label={`Storage used: ${pct}%`}
        className={cn("mt-1.5 bg-indigo-100", compact ? "h-1" : "h-1.5")}
        indicatorClassName={cn("from-indigo-500 to-indigo-500", nearFull && "from-orange-500 to-red-500")}
      />
      {!compact && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {usage.documentCount} {usage.documentCount === 1 ? "document" : "documents"}
        </p>
      )}
    </div>
  );
}
