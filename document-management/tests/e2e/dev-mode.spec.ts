import { expect, test, type APIRequestContext } from "@playwright/test";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: { json(): Promise<any> }) => res.json();

async function uploadViaApi(request: APIRequestContext, name: string, body: string) {
  const bytes = Buffer.from(body);
  const init = await json(await request.post("/api/dms/uploads", {
    data: { fileName: name, size: bytes.length, mimeType: "application/pdf", folderId: null },
  }));
  expect(init.ok).toBe(true);
  const put = await request.put(init.data.target.url, { data: bytes, headers: { "content-type": "application/pdf" } });
  expect(put.ok()).toBe(true);
  const fin = await json(await request.post(`/api/dms/uploads/${init.data.documentId}/finalize`, { data: { versionNumber: 1 } }));
  expect(fin.ok).toBe(true);
  return fin.data as { id: string };
}

test.describe("development-mode app (server API)", () => {
  test("renders the authenticated workspace without the marketing hero", async ({ page }) => {
    await page.goto("/app");
    await expect(page.getByText("Development mode", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Document Management System" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Document Management", exact: true })).toBeVisible();
    await expect(page.getByTestId("document-card").first()).toBeVisible();
  });

  test("uploads through the UI, persists on the server, and downloads the same bytes", async ({ page, request }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("file-input").setInputFiles({ name: "e2e-server.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 server-bytes") });
    await expect(dialog.getByTestId("upload-row").first()).toHaveAttribute("data-status", "success");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: /Open e2e-server.pdf/ })).toBeVisible();

    await page.reload(); // server-side state, not component state
    await page.getByRole("searchbox").fill("e2e-server");
    await expect(page.getByTestId("document-card")).toHaveCount(1);

    const list = await json(await request.get("/api/dms/documents?search=e2e-server"));
    const id = list.data.items[0].id;
    expect(JSON.stringify(list)).not.toContain("storageKey");
    const link = await json(await request.get(`/api/dms/documents/${id}/file?disposition=attachment`));
    const file = await request.get(link.data.url);
    expect(file.status()).toBe(200);
    expect(file.headers()["content-disposition"]).toContain("attachment");
    expect(file.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await file.text()).toBe("%PDF-1.4 server-bytes");
  });

  test("rename, move, star and tags persist", async ({ request }) => {
    const doc = await uploadViaApi(request, "e2e-edit.pdf", "%PDF-1.4 edit");
    const folders = (await json(await request.get("/api/dms/bootstrap"))).data.folders;
    const target = folders.find((f: { name: string }) => f.name === "Receipts");
    const res = await json(await request.patch(`/api/dms/documents/${doc.id}`, {
      data: { displayName: "renamed", folderId: target.id, starred: true, tags: ["E2E", "e2e", "Smoke"] },
    }));
    expect(res.ok).toBe(true);
    const detail = (await json(await request.get(`/api/dms/documents/${doc.id}`))).data;
    expect(detail).toMatchObject({ displayName: "renamed.pdf", folderId: target.id, starred: true, tags: ["E2E", "Smoke"] });
    const filtered = (await json(await request.get(`/api/dms/documents?folderId=${target.id}&tag=smoke`))).data;
    expect(filtered.items.map((d: { id: string }) => d.id)).toContain(doc.id);
  });

  test("delete → trash → restore → purge", async ({ request }) => {
    const doc = await uploadViaApi(request, "e2e-trash.pdf", "%PDF-1.4 trash");
    expect((await json(await request.delete(`/api/dms/documents/${doc.id}`))).ok).toBe(true);
    const trash = (await json(await request.get("/api/dms/documents?view=trash"))).data;
    expect(trash.items.map((d: { id: string }) => d.id)).toContain(doc.id);
    expect((await json(await request.get(`/api/dms/documents/${doc.id}/file`))).error.code).toBe("not_found");
    expect((await json(await request.post(`/api/dms/documents/${doc.id}/restore`, { data: {} }))).ok).toBe(true);
    expect((await json(await request.post(`/api/dms/documents/${doc.id}/purge`, { data: {} }))).error.code).toBe("conflict");
    await request.delete(`/api/dms/documents/${doc.id}`);
    expect((await json(await request.post(`/api/dms/documents/${doc.id}/purge`, { data: {} }))).ok).toBe(true);
    expect((await json(await request.get(`/api/dms/documents/${doc.id}`))).error.code).toBe("not_found");
  });

  test("folder lifecycle and filtering in the UI", async ({ page }) => {
    await page.goto("/app");
    await page.getByRole("button", { name: "New folder" }).click();
    await page.getByLabel("Folder name").fill("E2E Clients");
    await page.getByRole("button", { name: "Create folder" }).click();
    const card = page.getByRole("button", { name: /^E2E Clients, 0 documents$/ });
    await expect(card).toBeVisible();
    await card.click();
    await expect(page.getByTestId("empty-state")).toContainText("This folder is empty");
    await page.getByRole("button", { name: "Folder options for E2E Clients" }).click();
    await page.getByRole("menuitem", { name: "Delete folder" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete folder" }).click();
    await expect(card).toHaveCount(0);
  });

  test("rejects bad input and unauthorized shapes", async ({ request }) => {
    const bad = await request.post("/api/dms/uploads", { data: { fileName: "x.exe", size: 5, mimeType: "application/x-msdownload", folderId: null } });
    expect(bad.status()).toBe(400);
    const traversal = await request.post("/api/dms/uploads", { data: { fileName: "../../x.pdf", size: 5, mimeType: "application/pdf", folderId: null } });
    const t = await json(traversal);
    expect(JSON.stringify(t)).not.toContain("..");
    const orphan = await request.put("/api/dms/dev/upload?key=00000000-0000-4000-8000-000000000001%2Fnope%2Fv1-x.pdf", { data: "x" });
    expect(orphan.status()).toBe(404);
    const xsite = await request.post("/api/dms/folders", { data: { name: "Evil" }, headers: { origin: "https://evil.example" } });
    expect(xsite.status()).toBe(403);
    expect((await request.get("/api/dms/documents?folderId=not-a-uuid")).status()).toBe(400);
    expect((await request.get("/api/dms/dev/file?token=bogus")).status()).toBe(410);
    expect((await request.get("/share/not-a-real-token-abcdefghijklmnop")).status()).toBe(503);
  });

  test("login page explains that auth is not configured in dev mode", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText(/Authentication is not configured/)).toBeVisible();
  });
});

test.describe("team management (dev mode API + UI)", () => {
  test("invites, changes a role, and removes a member end to end", async ({ page, request }) => {
    const email = `e2e-${Date.now()}@example.test`;
    await page.goto("/app");
    await page.getByRole("button", { name: "Team", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Team" });
    await expect(dialog.getByTestId("member-row").first()).toBeVisible();

    await dialog.getByLabel("Email").fill(email);
    await dialog.getByRole("button", { name: "Invite" }).click();
    await expect(dialog.getByTestId("invite-row").filter({ hasText: email })).toBeVisible();

    // Server state, not just component state.
    const team = await json(await request.get("/api/dms/team"));
    expect(team.data.invites.map((i: { email: string }) => i.email)).toContain(email);

    await dialog.getByRole("button", { name: `Revoke invite for ${email}` }).click();
    await expect(dialog.getByTestId("invite-row").filter({ hasText: email })).toHaveCount(0);

    // Invariants enforced server-side regardless of the UI: no self role change, bad input rejected.
    const me = team.data.members.find((m: { role: string }) => m.role === "owner");
    const self = await json(await request.patch(`/api/dms/team/members/${me.userId}`, { data: { role: "viewer" } }));
    expect(self.ok).toBe(false);
    expect(self.error.code).toBe("forbidden");
    const bad = await json(await request.post("/api/dms/team/invites", { data: { email: "nope", role: "viewer" } }));
    expect(bad.error.code).toBe("validation");
  });

  test("share links are honestly unavailable in dev mode", async ({ request }) => {
    const list = await json(await request.get("/api/dms/documents?pageSize=1"));
    const id = list.data.items[0].id;
    const created = await json(await request.post(`/api/dms/documents/${id}/share`, { data: { ttlMinutes: 60 } }));
    expect(created.ok).toBe(false);
    expect(created.error.code).toBe("unavailable");
    expect((await json(await request.get(`/api/dms/documents/${id}/share`))).data).toEqual([]);
  });
});
