// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ShareDialog } from "@/components/dms/share-dialog";
import { TeamDialog, assignableRoles } from "@/components/dms/team-dialog";
import { DocumentManagementPage } from "@/components/dms/document-management-page";
import type { DmsApi } from "@/lib/dms/client/api";
import { createLocalApi } from "@/lib/dms/client/local-api";
import { toDmsError } from "@/lib/dms/errors";
import { SAMPLE_USER_ID } from "@/lib/dms/memory/sample-data";
import type { Role, ShareLinkInfo } from "@/lib/dms/types";
import { WS_A, makeWorld } from "../support/world";

const MAYA = "00000000-0000-4000-8000-000000000187";

/** The real service over in-memory storage, exposed through the team parts of DmsApi. */
function teamApi(role: Role = "owner", userId = SAMPLE_USER_ID) {
  const world = makeWorld();
  const svc = world.as(WS_A, role, userId);
  const wrap = async <T,>(fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      throw toDmsError(e);
    }
  };
  const api = {
    mode: "dev",
    capabilities: { share: true, team: true },
    getTeam: () => wrap(() => svc.listTeam()),
    inviteMember: (email: string, r: Role) => wrap(() => svc.inviteMember({ email, role: r })),
    revokeInvite: (id: string) => wrap(() => svc.revokeInvite(id)),
    changeMemberRole: (u: string, r: Role) => wrap(() => svc.changeMemberRole(u, { role: r })),
    removeMember: (u: string) => wrap(() => svc.removeMember(u)),
  } as unknown as DmsApi;
  return { api, world };
}

function open(api: DmsApi, role: Role = "owner", userId = SAMPLE_USER_ID) {
  const notify = vi.fn();
  render(<TeamDialog open onOpenChange={() => {}} api={api} myRole={role} myUserId={userId} onNotify={notify} />);
  return notify;
}

describe("role options", () => {
  it("lets owners grant any role and admins only viewer/editor", () => {
    expect(assignableRoles("owner")).toEqual(["viewer", "editor", "admin", "owner"]);
    expect(assignableRoles("admin")).toEqual(["viewer", "editor"]);
  });
});

describe("TeamDialog", () => {
  it("lists members and marks the current user, who cannot edit or remove themselves", async () => {
    const { api } = teamApi();
    open(api);
    const rows = await screen.findAllByTestId("member-row");
    expect(rows).toHaveLength(2);
    const me = rows.find((r) => within(r).queryByText("You"))!;
    expect(within(me).queryByRole("combobox")).toBeNull();
    expect(within(me).getByRole("button", { name: /Remove/ })).toBeDisabled();
    const maya = rows.find((r) => /Maya/.test(r.textContent ?? ""))!;
    expect(within(maya).getByRole("combobox", { name: /Role for Maya/ })).toBeEnabled();
  });

  it("validates the invite email before calling the API", async () => {
    const { api } = teamApi();
    const spy = vi.spyOn(api, "inviteMember");
    open(api);
    await screen.findAllByTestId("member-row");
    await userEvent.type(screen.getByLabelText("Email"), "not-an-email");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/valid email/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it("invites by email, tells the user no email is sent, and shows the pending invite", async () => {
    const { api } = teamApi();
    const notify = open(api);
    expect(screen.getByText(/No email is sent/)).toBeInTheDocument();
    await screen.findAllByTestId("member-row");
    await userEvent.type(screen.getByLabelText("Email"), "New.Person@Example.test");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    const row = await screen.findByTestId("invite-row");
    expect(row).toHaveTextContent("new.person@example.test");
    expect(row).toHaveTextContent("Editor");
    expect(notify).toHaveBeenCalledWith("success", expect.stringContaining("new.person@example.test"));
  });

  it("shows server-side rule errors on the form (already a member)", async () => {
    const { api } = teamApi();
    open(api);
    await screen.findAllByTestId("member-row");
    await userEvent.type(screen.getByLabelText("Email"), "maya@aurumventura.net");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already a member/i);
  });

  it("revokes a pending invite", async () => {
    const { api } = teamApi();
    open(api);
    await screen.findAllByTestId("member-row");
    await userEvent.type(screen.getByLabelText("Email"), "gone@example.test");
    await userEvent.click(screen.getByRole("button", { name: "Invite" }));
    await screen.findByTestId("invite-row");
    await userEvent.click(screen.getByRole("button", { name: "Revoke invite for gone@example.test" }));
    await waitFor(() => expect(screen.queryByTestId("invite-row")).toBeNull());
    expect(screen.getByText("No pending invites.")).toBeInTheDocument();
  });

  it("removes a member only after confirmation", async () => {
    const { api, world } = teamApi();
    open(api);
    await screen.findAllByTestId("member-row");
    await userEvent.click(screen.getByRole("button", { name: "Remove Maya Chen" }));
    const confirm = await screen.findByRole("alertdialog");
    expect(world.store.members.has(`${WS_A}:${MAYA}`)).toBe(true); // nothing happens until confirmed
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(screen.getAllByTestId("member-row")).toHaveLength(1));
    expect(world.store.members.has(`${WS_A}:${MAYA}`)).toBe(false);
  });

  it("changes a member's role through the dropdown", async () => {
    const { api, world } = teamApi();
    const notify = open(api);
    await screen.findAllByTestId("member-row");
    await userEvent.click(screen.getByRole("combobox", { name: /Role for Maya/ }));
    await userEvent.click(await screen.findByRole("option", { name: "Viewer" }));
    await waitFor(() => expect(world.store.members.get(`${WS_A}:${MAYA}`)?.role).toBe("viewer"));
    expect(notify).toHaveBeenCalledWith("success", expect.stringContaining("Viewer"));
  });

  it("for an admin, hides owner-only controls on admins and owners", async () => {
    const adminId = "00000000-0000-4000-8000-0000000000a1";
    const { api, world } = teamApi("admin", adminId);
    world.store.members.set(`${WS_A}:${adminId}`, { workspaceId: WS_A, userId: adminId, role: "admin", email: "ada@x.test", displayName: "Ada", joinedAt: "2026-01-02T00:00:00Z" });
    open(api, "admin", adminId);
    const rows = await screen.findAllByTestId("member-row");
    const kyle = rows.find((r) => /Kyle/.test(r.textContent ?? ""))!;
    expect(within(kyle).queryByRole("combobox")).toBeNull();
    expect(within(kyle).getByRole("button", { name: /Remove Kyle/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("combobox", { name: "Role" }));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual(["Viewer", "Editor"]);
  });

  it("shows an error state with retry if the team cannot be loaded", async () => {
    const { api } = teamApi();
    let fail = true;
    const real = api.getTeam;
    api.getTeam = async () => {
      if (fail) throw toDmsError(new Error("x"));
      return real();
    };
    open(api);
    expect(await screen.findByTestId("error-state")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect((await screen.findAllByTestId("member-row")).length).toBeGreaterThan(0);
  });
});

describe("page wiring", () => {
  it("does not offer the Team button in the public demo", async () => {
    render(<DocumentManagementPage api={createLocalApi()} />);
    await waitFor(() => expect(screen.queryAllByTestId("document-card").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "Team" })).toBeNull();
  });
});

describe("ShareDialog: active links", () => {
  const link = (id: string): ShareLinkInfo => ({ id, createdAt: "2026-10-23T10:00:00Z", expiresAt: "2026-10-24T10:00:00Z", createdBy: "u", createdByName: "Kyle" });
  const setup = (links: ShareLinkInfo[]) => {
    let current = links;
    const onRevoke = vi.fn(async (id: string) => {
      current = current.filter((l) => l.id !== id);
    });
    render(
      <ShareDialog open fileName="a.pdf" onOpenChange={() => {}} onCreate={async () => ({ url: "https://x/share/abc", expiresAt: "2026-10-24T10:00:00Z" })}
        loadLinks={async () => current} onRevoke={onRevoke} />,
    );
    return onRevoke;
  };
  beforeEach(() => vi.clearAllMocks());

  it("lists active links with creator and expiry, and revokes one", async () => {
    const onRevoke = setup([link("l1"), link("l2")]);
    const list = await screen.findByTestId("share-links");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Kyle");
    await userEvent.click(within(list).getAllByRole("button", { name: /Revoke link/ })[0]);
    await waitFor(() => expect(within(screen.getByTestId("share-links")).getAllByRole("listitem")).toHaveLength(1));
    expect(onRevoke).toHaveBeenCalledWith("l1");
  });
  it("says so when there are none, and explains that the URL is shown only once", async () => {
    setup([]);
    expect(await screen.findByText("No active links for this document.")).toBeInTheDocument();
    expect(screen.getByText(/only shown once/)).toBeInTheDocument();
  });
});
