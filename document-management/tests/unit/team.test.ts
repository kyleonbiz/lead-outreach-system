import { beforeEach, describe, expect, it } from "vitest";
import { toDmsError } from "@/lib/dms/errors";
import { SAMPLE_USER_ID } from "@/lib/dms/memory/sample-data";
import { DocumentService } from "@/lib/dms/service";
import type { Role } from "@/lib/dms/types";
import { USER_B, WS_A, WS_B, makeWorld, type World } from "../support/world";

const KYLE = SAMPLE_USER_ID; // seeded owner of workspace A
const MAYA = "00000000-0000-4000-8000-000000000187"; // seeded editor (sample-data uid(0xbb))
const ADMIN_ID = "00000000-0000-4000-8000-0000000000a1";
const OWNER2_ID = "00000000-0000-4000-8000-0000000000a2";
const DOC = "00000000-0000-4000-8000-000000000100";

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e) => toDmsError(e).code, // route handlers apply the same mapping to validation errors
  );

let w: World;
beforeEach(() => {
  w = makeWorld();
  const add = (userId: string, role: Role, email: string) =>
    w.store.members.set(`${WS_A}:${userId}`, {
      workspaceId: WS_A, userId, role, email, displayName: email.split("@")[0], joinedAt: "2026-01-01T00:00:00.000Z",
    });
  add(ADMIN_ID, "admin", "ada@aurum.test");
  add(OWNER2_ID, "owner", "olga@aurum.test");
});

const as = (role: Role, userId: string) => w.as(WS_A, role, userId);
const audit = (action: string) => w.store.audit.filter((a) => a.action === action);

describe("team: who can see and manage it", () => {
  it("is admin-only", async () => {
    expect(await code(as("viewer", MAYA).listTeam())).toBe("forbidden");
    expect(await code(as("editor", MAYA).listTeam())).toBe("forbidden");
    expect(await code(as("editor", MAYA).inviteMember({ email: "x@y.test", role: "viewer" }))).toBe("forbidden");
    const team = await as("admin", ADMIN_ID).listTeam();
    expect(team.members.map((m) => m.email)).toContain("maya@aurumventura.net");
  });
  it("only lists the caller's workspace", async () => {
    const team = await as("owner", KYLE).listTeam();
    expect(team.members.every((m) => m.userId !== USER_B)).toBe(true);
    await w.as(WS_B, "owner", USER_B).inviteMember({ email: "secret@beta.test", role: "viewer" });
    expect((await as("owner", KYLE).listTeam()).invites.map((i) => i.email)).not.toContain("secret@beta.test");
  });
  it("reports a clear error where team management is not wired (public demo)", async () => {
    const bare = new DocumentService({ repo: w.repo, storage: w.storage, limits: w.limits, ctx: { workspaceId: WS_A, userId: KYLE, userName: "K", role: "owner" } });
    expect(await code(bare.listTeam())).toBe("unavailable");
  });
});

describe("team: invites", () => {
  it("normalises the email, stores the invite and audits it", async () => {
    const inv = await as("admin", ADMIN_ID).inviteMember({ email: "  Frank@Example.TEST ", role: "editor" });
    expect(inv.email).toBe("frank@example.test");
    expect((await as("admin", ADMIN_ID).listTeam()).invites).toHaveLength(1);
    expect(audit("member.invited")[0]).toMatchObject({ workspaceId: WS_A, actorId: ADMIN_ID, metadata: { email: "frank@example.test", role: "editor" } });
  });
  it("re-inviting updates the pending invite instead of duplicating it", async () => {
    const svc = as("admin", ADMIN_ID);
    await svc.inviteMember({ email: "a@b.test", role: "viewer" });
    await svc.inviteMember({ email: "A@B.test", role: "editor" });
    const { invites } = await svc.listTeam();
    expect(invites).toHaveLength(1);
    expect(invites[0].role).toBe("editor");
  });
  it("rejects invalid emails and roles", async () => {
    const svc = as("admin", ADMIN_ID);
    expect(await code(svc.inviteMember({ email: "nope", role: "viewer" }))).toBe("validation");
    expect(await code(svc.inviteMember({ email: "a@b.test", role: "god" }))).toBe("validation");
  });
  it("refuses people who are already members (case-insensitive)", async () => {
    expect(await code(as("admin", ADMIN_ID).inviteMember({ email: "MAYA@aurumventura.net", role: "viewer" }))).toBe("conflict");
  });
  it("lets admins invite viewer/editor only; owners can invite anyone", async () => {
    const admin = as("admin", ADMIN_ID);
    expect(await code(admin.inviteMember({ email: "a@b.test", role: "admin" }))).toBe("forbidden");
    expect(await code(admin.inviteMember({ email: "a@b.test", role: "owner" }))).toBe("forbidden");
    expect(await code(as("owner", KYLE).inviteMember({ email: "a@b.test", role: "admin" }))).toBe("ok");
  });
  it("revokes invites; admins cannot revoke an admin invite; unknown ids are not found", async () => {
    const owner = as("owner", KYLE);
    const low = await owner.inviteMember({ email: "low@b.test", role: "viewer" });
    const high = await owner.inviteMember({ email: "high@b.test", role: "admin" });
    const admin = as("admin", ADMIN_ID);
    expect(await code(admin.revokeInvite(high.id))).toBe("forbidden");
    expect(await code(admin.revokeInvite(low.id))).toBe("ok");
    expect(await code(admin.revokeInvite(low.id))).toBe("not_found");
    expect(audit("member.invite_revoked")).toHaveLength(1);
  });
  it("ignores expired invites", async () => {
    const owner = as("owner", KYLE);
    await owner.inviteMember({ email: "late@b.test", role: "viewer" });
    w.store.invites[0].expiresAt = "2026-10-22T00:00:00.000Z"; // before NOW
    expect((await owner.listTeam()).invites).toHaveLength(0);
  });
});

describe("team: roles and removal", () => {
  it("lets an admin change viewers/editors but not admins/owners, and never to admin", async () => {
    const admin = as("admin", ADMIN_ID);
    expect(await code(admin.changeMemberRole(MAYA, { role: "viewer" }))).toBe("ok");
    expect(w.store.members.get(`${WS_A}:${MAYA}`)?.role).toBe("viewer");
    expect(await code(admin.changeMemberRole(MAYA, { role: "admin" }))).toBe("forbidden");
    expect(await code(admin.changeMemberRole(KYLE, { role: "viewer" }))).toBe("forbidden");
    expect(await code(admin.changeMemberRole(OWNER2_ID, { role: "viewer" }))).toBe("forbidden");
    expect(audit("member.role_changed")).toHaveLength(1);
    expect(audit("member.role_changed")[0].metadata).toMatchObject({ from: "editor", to: "viewer" });
  });
  it("lets an owner promote and demote anyone", async () => {
    const owner = as("owner", KYLE);
    expect(await code(owner.changeMemberRole(ADMIN_ID, { role: "editor" }))).toBe("ok");
    expect(await code(owner.changeMemberRole(MAYA, { role: "owner" }))).toBe("ok");
    expect(await code(owner.changeMemberRole(OWNER2_ID, { role: "admin" }))).toBe("ok");
  });
  it("never lets anyone change their own role or remove themselves", async () => {
    expect(await code(as("owner", KYLE).changeMemberRole(KYLE, { role: "viewer" }))).toBe("forbidden");
    expect(await code(as("owner", KYLE).removeMember(KYLE))).toBe("forbidden");
    expect(await code(as("admin", ADMIN_ID).removeMember(ADMIN_ID))).toBe("forbidden");
  });
  it("keeps at least one owner", async () => {
    // OWNER2 is the only owner left once Kyle is demoted; a third-party owner (not in the member list) tries to remove them.
    w.store.members.delete(`${WS_A}:${OWNER2_ID}`);
    const outsideOwner = as("owner", "00000000-0000-4000-8000-0000000000a9");
    expect(await code(outsideOwner.changeMemberRole(KYLE, { role: "editor" }))).toBe("conflict");
    expect(await code(outsideOwner.removeMember(KYLE))).toBe("conflict");
    expect(w.store.members.get(`${WS_A}:${KYLE}`)?.role).toBe("owner");
    // With a second owner present the same operations succeed.
    w.store.members.set(`${WS_A}:${OWNER2_ID}`, {
      workspaceId: WS_A, userId: OWNER2_ID, role: "owner", email: "olga@aurum.test", displayName: "Olga", joinedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(await code(outsideOwner.changeMemberRole(KYLE, { role: "editor" }))).toBe("ok");
  });
  it("removes members (admins: viewer/editor only) and audits it", async () => {
    const admin = as("admin", ADMIN_ID);
    expect(await code(admin.removeMember(KYLE))).toBe("forbidden");
    expect(await code(admin.removeMember(OWNER2_ID))).toBe("forbidden");
    expect(await code(admin.removeMember(MAYA))).toBe("ok");
    expect(w.store.members.has(`${WS_A}:${MAYA}`)).toBe(false);
    expect(await code(admin.removeMember(MAYA))).toBe("not_found");
    expect(audit("member.removed")).toHaveLength(1);
  });
  it("cannot reach members of another workspace", async () => {
    expect(await code(as("owner", KYLE).removeMember(USER_B))).toBe("not_found");
    expect(await code(as("owner", KYLE).changeMemberRole(USER_B, { role: "viewer" }))).toBe("not_found");
    expect(w.store.members.has(`${WS_B}:${USER_B}`)).toBe(true);
  });
});

describe("share links: list and revoke", () => {
  const make = async (svc: DocumentService) => {
    await svc.createShareLink(DOC, 60);
    return (await svc.listShareLinks(DOC)).at(0)!;
  };
  it("lists live links and hides expired and revoked ones", async () => {
    const owner = as("owner", KYLE);
    const link = await make(owner);
    await owner.createShareLink(DOC, 5);
    w.store.shares[1].expiresAt = "2026-10-22T00:00:00.000Z";
    expect(await owner.listShareLinks(DOC)).toHaveLength(1);
    await owner.revokeShareLink(DOC, link.id);
    expect(await owner.listShareLinks(DOC)).toHaveLength(0);
    expect(audit("document.share_revoked")).toHaveLength(1);
  });
  it("lets the creator or an admin revoke, but not another editor", async () => {
    const link = await make(as("editor", MAYA));
    expect(await code(as("editor", "00000000-0000-4000-8000-0000000000e9").revokeShareLink(DOC, link.id))).toBe("forbidden");
    expect(await code(as("admin", ADMIN_ID).revokeShareLink(DOC, link.id))).toBe("ok");
    const own = await make(as("editor", MAYA));
    expect(await code(as("editor", MAYA).revokeShareLink(DOC, own.id))).toBe("ok");
  });
  it("viewers cannot list or revoke; unknown links are not found; stays inside the workspace", async () => {
    const link = await make(as("owner", KYLE));
    expect(await code(as("viewer", MAYA).listShareLinks(DOC))).toBe("forbidden");
    expect(await code(as("viewer", MAYA).revokeShareLink(DOC, link.id))).toBe("forbidden");
    expect(await code(as("owner", KYLE).revokeShareLink(DOC, "00000000-0000-4000-8000-000000000999"))).toBe("not_found");
    expect(await code(w.as(WS_B, "owner", USER_B).listShareLinks(DOC))).toBe("not_found");
    expect(await code(w.as(WS_B, "owner", USER_B).revokeShareLink(DOC, link.id))).toBe("not_found");
  });
});
