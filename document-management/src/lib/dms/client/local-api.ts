import { DmsError, toDmsError } from "../errors";
import { loadUploadLimitsForBrowser } from "./limits";
import type { DmsApi, DocumentChanges, UploadArgs } from "./api";
import { DocumentService } from "../service";
import {
  SAMPLE_USER_ID,
  SAMPLE_USER_NAME,
  SAMPLE_WORKSPACE_ID,
  createSampleKit,
  prepareSampleImages,
} from "../memory/sample-data";
import type { DocumentQuery } from "../types";

/**
 * Runs the real DocumentService against in-browser memory. Used on the public
 * demo page. Nothing is sent to a server or persisted, and the UI says so.
 */
export function createLocalApi(): DmsApi {
  const kit = createSampleKit();
  const service = new DocumentService({
    repo: kit.repo,
    storage: kit.storage,
    limits: loadUploadLimitsForBrowser(),
    userEmail: "demo@aurumventura.net",
    ctx: {
      workspaceId: SAMPLE_WORKSPACE_ID,
      userId: SAMPLE_USER_ID,
      userName: SAMPLE_USER_NAME,
      role: "owner",
    },
  });
  const ready = prepareSampleImages(kit.store, kit.storage).catch(() => undefined);

  async function run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await ready;
      return await fn();
    } catch (e) {
      throw toDmsError(e);
    }
  }

  return {
    mode: "demo",
    capabilities: { share: false },
    bootstrap: () => run(() => service.bootstrap()),
    listDocuments: (q: DocumentQuery) => run(() => service.listDocuments(q)),
    getDocument: (id) => run(() => service.getDocument(id)),
    updateDocument: (id, changes: DocumentChanges) => run(() => service.updateDocument(id, changes)),
    deleteDocument: (id) => run(() => service.deleteDocument(id)),
    restoreDocument: (id) => run(() => service.restoreDocument(id)),
    purgeDocument: (id) => run(() => service.purgeDocument(id)),
    getFileLink: (id, opts) => run(() => service.getFileLink(id, opts)),
    createShareLink: () =>
      Promise.reject(new DmsError("unavailable", "Share links need a connected workspace.")),
    createFolder: (name) => run(() => service.createFolder({ name })),
    renameFolder: (id, name) => run(() => service.renameFolder(id, { name })),
    deleteFolder: (id) => run(() => service.deleteFolder(id)),
    uploadFile: (args: UploadArgs) =>
      run(async () => {
        const init = await service.initiateUpload({
          fileName: args.file.name,
          size: args.file.size,
          mimeType: args.file.type,
          folderId: args.folderId,
          category: args.category,
          documentId: args.documentId,
        });
        try {
          if (args.signal?.aborted) throw new DmsError("conflict", "Upload cancelled.");
          args.onProgress?.(0, args.file.size);
          const bytes = new Uint8Array(await args.file.arrayBuffer());
          if (args.signal?.aborted) throw new DmsError("conflict", "Upload cancelled.");
          const version = await kit.repo.getVersion(SAMPLE_WORKSPACE_ID, init.documentId, init.versionNumber);
          kit.storage.put(version!.storageKey, bytes, version!.mimeType);
          args.onProgress?.(args.file.size, args.file.size);
          return await service.finalizeUpload(init.documentId, init.versionNumber);
        } catch (e) {
          await service.abortUpload(init.documentId, init.versionNumber).catch(() => undefined);
          throw e;
        }
      }),
  };
}
