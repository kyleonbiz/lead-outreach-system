"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { MailPlus, Trash2, UserMinus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { DmsApi } from "@/lib/dms/client/api";
import { toDmsError } from "@/lib/dms/errors";
import type { Invite, Member, Role, Team } from "@/lib/dms/types";
import { inviteMemberSchema } from "@/lib/dms/validation";
import { DeleteConfirmationDialog } from "./delete-confirmation-dialog";
import { formatDate } from "./format";
import { ErrorState } from "./states";

const ROLE_LABELS: Record<Role, string> = { viewer: "Viewer", editor: "Editor", admin: "Admin", owner: "Owner" };
const ROLE_HELP: Record<Role, string> = {
  viewer: "Can view and download",
  editor: "Can upload, edit and delete",
  admin: "Also manages the team and permanent deletion",
  owner: "Full control of the workspace",
};

const schema = z.object({ email: inviteMemberSchema.shape.email, role: inviteMemberSchema.shape.role });
type Values = z.input<typeof schema>;

/** Roles the current user may hand out: owners anything, admins viewer/editor only. */
export function assignableRoles(me: Role): Role[] {
  return me === "owner" ? ["viewer", "editor", "admin", "owner"] : ["viewer", "editor"];
}

export function TeamDialog({
  open,
  onOpenChange,
  api,
  myRole,
  myUserId,
  onNotify,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: DmsApi;
  myRole: Role;
  myUserId: string;
  onNotify: (kind: "success" | "error", message: string) => void;
}) {
  const [team, setTeam] = useState<Team | null>(null);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const roles = assignableRoles(myRole);

  const load = useCallback(async () => {
    try {
      setTeam(await api.getTeam());
      setError("");
    } catch (e) {
      setError(toDmsError(e).message);
    }
  }, [api]);

  useEffect(() => {
    // The previous list stays visible until the fresh one arrives.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) void load();
  }, [open, load]);

  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: { email: "", role: "editor" } });
  const { register, handleSubmit, reset, setError: setFieldError, setValue, control, formState } = form;
  const role = useWatch({ control, name: "role" });

  const invite = handleSubmit(async ({ email, role }) => {
    try {
      await api.inviteMember(email, role);
      reset({ email: "", role });
      onNotify("success", `Invite saved for ${email.trim().toLowerCase()}. Ask them to sign up with that address.`);
      await load();
    } catch (e) {
      setFieldError("email", { message: toDmsError(e).message });
    }
  });

  async function act(fn: () => Promise<unknown>, success: string) {
    try {
      await fn();
      onNotify("success", success);
      await load();
    } catch (e) {
      onNotify("error", toDmsError(e).message);
      await load();
    }
  }

  const canTouch = (target: Role) => myRole === "owner" || target === "viewer" || target === "editor";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:h-[min(720px,calc(100dvh-3rem))] sm:max-w-2xl" aria-describedby="team-desc" closeLabel="Close team">
        <div className="border-b px-5 py-4 pr-14 sm:px-6">
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-5 text-violet-500" aria-hidden /> Team
          </DialogTitle>
          <DialogDescription id="team-desc" className="mt-1">
            Invite people and manage what they can do in this workspace.
          </DialogDescription>
        </div>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
          <form onSubmit={invite} noValidate className="space-y-3 rounded-xl border bg-muted/30 p-4" aria-label="Invite a teammate">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <MailPlus className="size-4 text-muted-foreground" aria-hidden /> Invite a teammate
            </h3>
            <div className="grid gap-3 sm:grid-cols-[1fr_170px_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  autoComplete="off"
                  placeholder="name@company.com"
                  aria-invalid={!!formState.errors.email}
                  aria-describedby={formState.errors.email ? "invite-email-error" : undefined}
                  {...register("email")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <Select value={role} onValueChange={(v) => setValue("role", v as Role)}>
                  <SelectTrigger id="invite-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {roles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={formState.isSubmitting}>
                {formState.isSubmitting ? "Saving…" : "Invite"}
              </Button>
            </div>
            {formState.errors.email && (
              <p id="invite-email-error" role="alert" className="text-xs text-destructive">
                {formState.errors.email.message}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {ROLE_HELP[role]}. No email is sent: the person joins automatically when they sign up or sign in
              with this exact, verified address.
            </p>
          </form>

          {error && <ErrorState message={error} onRetry={load} />}
          {!team && !error && (
            <div className="space-y-2" role="status" aria-label="Loading team">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          )}

          {team && (
            <>
              <section aria-labelledby="members-heading">
                <h3 id="members-heading" className="mb-2 text-sm font-semibold">
                  Members <span className="font-normal text-muted-foreground">({team.members.length})</span>
                </h3>
                <ul className="divide-y rounded-xl border" data-testid="member-list">
                  {team.members.map((m) => {
                    const isMe = m.userId === myUserId;
                    const editable = !isMe && canTouch(m.role);
                    return (
                      <li key={m.userId} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="member-row">
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground" aria-hidden>
                          {(m.displayName || m.email || "?").charAt(0).toUpperCase()}
                        </span>
                        <div className="min-w-0 flex-1 basis-40">
                          <p className="truncate text-sm font-medium">
                            {m.displayName || m.email}
                            {isMe && <Badge variant="muted" className="ml-2">You</Badge>}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{m.email} · joined {formatDate(m.joinedAt)}</p>
                        </div>
                        <div className="ml-auto flex items-center gap-1.5">
                        {editable ? (
                          <Select
                            value={m.role}
                            onValueChange={(r) =>
                              act(() => api.changeMemberRole(m.userId, r as Role), `${m.displayName || m.email} is now ${ROLE_LABELS[r as Role]}.`)
                            }
                          >
                            <SelectTrigger aria-label={`Role for ${m.displayName || m.email}`} className="h-9 w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {roles.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ROLE_LABELS[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge>{ROLE_LABELS[m.role]}</Badge>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Remove ${m.displayName || m.email}`}
                          disabled={!editable}
                          title={isMe ? "You cannot remove yourself" : !editable ? "Only an owner can remove this member" : undefined}
                          onClick={() => setRemoving(m)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <UserMinus />
                        </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section aria-labelledby="invites-heading">
                <h3 id="invites-heading" className="mb-2 text-sm font-semibold">
                  Pending invites <span className="font-normal text-muted-foreground">({team.invites.length})</span>
                </h3>
                {team.invites.length === 0 ? (
                  <p className="rounded-xl border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">No pending invites.</p>
                ) : (
                  <ul className="divide-y rounded-xl border" data-testid="invite-list">
                    {team.invites.map((i: Invite) => (
                      <li key={i.id} className="flex items-center gap-3 px-4 py-3" data-testid="invite-row">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{i.email}</p>
                          <p className="text-xs text-muted-foreground">{ROLE_LABELS[i.role]} · expires {formatDate(i.expiresAt)}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Revoke invite for ${i.email}`}
                          disabled={!canTouch(i.role)}
                          onClick={() => act(() => api.revokeInvite(i.id), `Invite for ${i.email} revoked.`)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 />
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>

        <DeleteConfirmationDialog
          open={removing !== null}
          onOpenChange={(o) => !o && setRemoving(null)}
          title={`Remove ${removing?.displayName || removing?.email || "member"}?`}
          description="They lose access to this workspace immediately. Documents they uploaded stay."
          confirmLabel="Remove member"
          onConfirm={async () => {
            if (removing) await act(() => api.removeMember(removing.userId), "Member removed.");
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
