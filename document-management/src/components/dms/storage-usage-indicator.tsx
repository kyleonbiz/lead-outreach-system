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
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <HardDrive className="size-3.5 text-violet-500" aria-hidden />
          Storage
        </span>
        <span className={cn("tabular-nums text-muted-foreground", nearFull && "font-medium text-destructive")}>
          {formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)}
        </span>
      </div>
      <Progress
        value={pct}
        aria-label={`Storage used: ${pct}%`}
        className={cn("mt-1.5", compact ? "h-1.5" : "h-2")}
        indicatorClassName={nearFull ? "from-orange-500 to-red-500" : undefined}
      />
      {!compact && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {pct}% used · {usage.documentCount} {usage.documentCount === 1 ? "document" : "documents"}
        </p>
      )}
    </div>
  );
}
