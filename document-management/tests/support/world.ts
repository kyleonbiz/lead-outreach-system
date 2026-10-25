import { DocumentService } from "@/lib/dms/service";
import { defaultUploadLimits } from "@/lib/dms/config";
import { MemoryRepository, MemoryStorage } from "@/lib/dms/memory/store";
import { SAMPLE_WORKSPACE_ID, createSampleSynthesizer, seedSampleStore } from "@/lib/dms/memory/sample-data";
import type { Role, UploadLimits } from "@/lib/dms/types";

export const WS_A = SAMPLE_WORKSPACE_ID;
export const WS_B = "00000000-0000-4000-8000-000000000002";
export const USER_A = "00000000-0000-4000-8000-0000000000aa";
export const USER_B = "00000000-0000-4000-8000-0000000000b2";
export const FOLDER_B = "00000000-0000-4000-8000-000000000b10";
export const DOC_B = "00000000-0000-4000-8000-000000000b01";

export const NOW = new Date("2026-10-23T12:00:00Z");

/** Two tenants sharing one "database" so isolation is tested against shared state. */
export function makeWorld(opts: { limits?: Partial<UploadLimits>; quotaA?: number } = {}) {
  const store = seedSampleStore(NOW);
  if (opts.quotaA) store.workspaces.get(WS_A)!.storageQuotaBytes = opts.quotaA;
  store.workspaces.set(WS_B, { id: WS_B, name: "Beta LLC", storageQuotaBytes: 10_000_000 });
  store.folders.set(FOLDER_B, {
    id: FOLDER_B, workspaceId: WS_B, name: "Beta Private", color: "rose", isSystem: false,
    defaultCategory: null, createdAt: NOW.toISOString(),
  });
  const keyB = `${WS_B}/${DOC_B}/v1-beta.pdf`;
  store.documents.set(DOC_B, {
    id: DOC_B, workspaceId: WS_B, folderId: FOLDER_B, originalName: "beta-secret.pdf", displayName: "beta-secret.pdf",
    storageKey: keyB, mimeType: "application/pdf", sizeBytes: 4000, category: "contract", tags: ["Confidential"],
    uploadedBy: USER_B, uploadedByName: "Bea", createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
    expiresAt: null, starred: false, status: "ready", deletedAt: null, currentVersion: 1,
    contentStatus: "pending", contentReason: null, contentIndexedAt: null,
  });
  store.versions.set(DOC_B, [{
    id: "00000000-0000-4000-8000-000000000b99", documentId: DOC_B, workspaceId: WS_B, versionNumber: 1,
    storageKey: keyB, mimeType: "application/pdf", sizeBytes: 4000, createdBy: USER_B, createdByName: "Bea",
    createdAt: NOW.toISOString(), status: "ready",
  }]);

  store.members.set(`${WS_B}:${USER_B}`, {
    workspaceId: WS_B, userId: USER_B, displayName: "Bea", email: "bea@beta.test", role: "owner", joinedAt: NOW.toISOString(),
  });
  const repo = new MemoryRepository(store, { now: () => NOW });
  const storage = new MemoryStorage(store, { synthesize: createSampleSynthesizer(store) });
  storage.put(keyB, new TextEncoder().encode("%PDF-beta"), "application/pdf");
  const limits: UploadLimits = { ...defaultUploadLimits(), ...opts.limits };

  const as = (workspaceId: string, role: Role, userId = workspaceId === WS_A ? USER_A : USER_B) =>
    new DocumentService({
      repo, team: repo, storage, limits, now: () => NOW,
      ctx: { workspaceId, userId, userName: userId === USER_A ? "Kyle" : "Bea", role },
    });

  return { store, repo, storage, limits, as, keyB };
}

export type World = ReturnType<typeof makeWorld>;

export const PDF_BYTES = new TextEncoder().encode("%PDF-1.4 test");

/** Runs the full initiate → put → finalize flow like a real client. */
export async function uploadFile(
  world: World,
  svc: DocumentService,
  file: { name: string; size?: number; type?: string; bytes?: Uint8Array },
  extra: { folderId?: string | null; documentId?: string } = {},
) {
  const bytes = file.bytes ?? PDF_BYTES;
  const init = await svc.initiateUpload({
    fileName: file.name,
    size: file.size ?? bytes.byteLength,
    mimeType: file.type ?? "application/pdf",
    folderId: extra.folderId ?? null,
    documentId: extra.documentId,
  });
  const v = await world.repo.getVersion(WS_A, init.documentId, init.versionNumber);
  world.storage.put(v!.storageKey, bytes, file.type ?? "application/pdf");
  return svc.finalizeUpload(init.documentId, init.versionNumber);
}
