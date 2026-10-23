import { LogOut } from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";

export function AppHeader({
  workspaceName,
  userLabel,
  badge,
}: {
  workspaceName?: string;
  userLabel?: string;
  badge?: string;
}) {
  return (
    <header className="border-b bg-card">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <Brand href="/app" />
          {workspaceName && (
            <span className="hidden truncate rounded-md bg-muted px-2 py-1 text-xs font-medium text-muted-foreground sm:inline">
              {workspaceName}
            </span>
          )}
          {badge && <span className="rounded-md bg-amber-100 px-2 py-1 text-xs font-medium text-amber-900">{badge}</span>}
        </div>
        {userLabel && (
          <form action="/auth/signout" method="post" className="flex items-center gap-2">
            <span className="hidden max-w-48 truncate text-sm text-muted-foreground md:inline">{userLabel}</span>
            <Button type="submit" variant="outline" size="sm">
              <LogOut /> <span className="sr-only sm:not-sr-only">Sign out</span>
            </Button>
          </form>
        )}
      </div>
    </header>
  );
}
