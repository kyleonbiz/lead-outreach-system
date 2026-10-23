import type { Category, DocumentRecord, Folder, FolderColor, Workspace } from "../types";
import { MB } from "../config";
import { MemoryRepository, MemoryStorage, MemoryStore } from "./store";
import { makeCsv, makeImage, makePdf } from "./sample-files";

export const SAMPLE_WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";
export const SAMPLE_USER_ID = "00000000-0000-4000-8000-0000000000aa";
export const SAMPLE_USER_NAME = "Kyle Johnson";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface SampleFolder {
  n: number;
  name: string;
  color: FolderColor;
  system: boolean;
  category: Category | null;
}

const FOLDERS: SampleFolder[] = [
  { n: 10, name: "Invoices", color: "violet", system: true, category: "invoice" },
  { n: 11, name: "Receipts", color: "emerald", system: true, category: "receipt" },
  { n: 12, name: "Tax Documents", color: "amber", system: true, category: "tax" },
  { n: 13, name: "Contracts", color: "blue", system: true, category: "contract" },
  { n: 14, name: "HR Documents", color: "rose", system: true, category: "hr" },
  { n: 15, name: "Client Onboarding", color: "sky", system: false, category: null },
];

interface SampleDoc {
  name: string;
  folder: number | null;
  category: Category;
  size: number;
  daysAgo: number;
  tags: string[];
  starred?: boolean;
  by?: string;
  expiresInDays?: number;
}

const DOCS: SampleDoc[] = [
  { name: "Invoice_INV-2041_Northwind.pdf", folder: 10, category: "invoice", size: 184_320, daysAgo: 1, tags: ["Q4", "Northwind"], starred: true },
  { name: "Invoice_INV-2038_Harbor-Property.pdf", folder: 10, category: "invoice", size: 201_728, daysAgo: 6, tags: ["Q4", "Property"] },
  { name: "AR_Aging_Report_Oct.xlsx", folder: 10, category: "invoice", size: 96_256, daysAgo: 3, tags: ["Reporting", "Q4"], by: "Maya Chen" },
  { name: "Receipt_Office_Supplies_Staples.jpg", folder: 11, category: "receipt", size: 842_752, daysAgo: 2, tags: ["Office", "Reimbursable"] },
  { name: "Receipt_Client_Lunch_0912.png", folder: 11, category: "receipt", size: 512_000, daysAgo: 38, tags: ["Meals"] },
  { name: "Expenses_September.csv", folder: 11, category: "receipt", size: 18_432, daysAgo: 22, tags: ["Reporting", "Monthly"], by: "Maya Chen" },
  { name: "2025_Q3_Estimated_Tax_Payment.pdf", folder: 12, category: "tax", size: 322_560, daysAgo: 14, tags: ["Federal", "Q3"], starred: true },
  { name: "W9_Aurum_Ventura_Enterprise.pdf", folder: 12, category: "tax", size: 142_336, daysAgo: 90, tags: ["Federal", "Vendor"] },
  { name: "Sales_Tax_Filing_Summary.xlsx", folder: 12, category: "tax", size: 78_848, daysAgo: 41, tags: ["State", "Q3"] },
  { name: "Master_Services_Agreement_Harbor.pdf", folder: 13, category: "contract", size: 1_258_291, daysAgo: 8, tags: ["Client", "Signed"], starred: true, expiresInDays: 340 },
  { name: "NDA_Summit_Property_Group.docx", folder: 13, category: "contract", size: 64_512, daysAgo: 27, tags: ["Client", "NDA"], by: "Maya Chen" },
  { name: "Vendor_Agreement_CloudHost.pdf", folder: 13, category: "contract", size: 733_184, daysAgo: 120, tags: ["Vendor"], expiresInDays: 25 },
  { name: "Employee_Handbook_2025.pdf", folder: 14, category: "hr", size: 2_411_724, daysAgo: 55, tags: ["Policy"] },
  { name: "Offer_Letter_Template.docx", folder: 14, category: "hr", size: 38_912, daysAgo: 70, tags: ["Template", "Hiring"], by: "Maya Chen" },
  { name: "Client_Intake_Checklist.docx", folder: 15, category: "other", size: 45_056, daysAgo: 4, tags: ["Template", "Client"] },
  { name: "Onboarding_Kickoff_Deck.pdf", folder: 15, category: "other", size: 3_145_728, daysAgo: 9, tags: ["Client"], starred: true },
  { name: "Brand_Guidelines_Draft.pdf", folder: null, category: "other", size: 5_242_880, daysAgo: 16, tags: ["Marketing", "Draft"] },
  { name: "Team_Photo_Retreat.jpg", folder: null, category: "other", size: 2_936_012, daysAgo: 33, tags: ["Marketing"] },
];

export interface SampleKit {
  store: MemoryStore;
  repo: MemoryRepository;
  storage: MemoryStorage;
}

export function seedSampleStore(now: Date = new Date()): MemoryStore {
  const store = new MemoryStore();
  const workspace: Workspace = {
    id: SAMPLE_WORKSPACE_ID,
    name: "Aurum Ventura Demo Workspace",
    storageQuotaBytes: 100 * MB,
  };
  store.workspaces.set(workspace.id, workspace);

  const created = (daysAgo: number) =>
    new Date(now.getTime() - daysAgo * 86_400_000 - 3 * 3_600_000).toISOString();

  for (const f of FOLDERS) {
    const folder: Folder = {
      id: uid(f.n),
      workspaceId: workspace.id,
      name: f.name,
      color: f.color,
      isSystem: f.system,
      defaultCategory: f.category,
      createdAt: created(200 - f.n),
    };
    store.folders.set(folder.id, folder);
  }

  store.members.set(`${workspace.id}:${SAMPLE_USER_ID}`, {
    workspaceId: workspace.id,
    userId: SAMPLE_USER_ID,
    displayName: SAMPLE_USER_NAME,
    email: "kyle@aurumventura.net",
    role: "owner",
    joinedAt: created(220),
  });
  store.members.set(`${workspace.id}:${uid(0xbb)}`, {
    workspaceId: workspace.id,
    userId: uid(0xbb),
    displayName: "Maya Chen",
    email: "maya@aurumventura.net",
    role: "editor",
    joinedAt: created(120),
  });

  DOCS.forEach((d, i) => {
    const id = uid(100 + i);
    const ext = d.name.split(".").pop()!.toLowerCase();
    const key = `${workspace.id}/${id}/v1-sample${i}.${ext}`;
    const mime = MIME[ext];
    const at = created(d.daysAgo);
    const record: DocumentRecord = {
      id,
      workspaceId: workspace.id,
      folderId: d.folder ? uid(d.folder) : null,
      originalName: d.name,
      displayName: d.name,
      storageKey: key,
      mimeType: mime,
      sizeBytes: d.size,
      category: d.category,
      tags: d.tags,
      uploadedBy: d.by ? uid(0xbb) : SAMPLE_USER_ID,
      uploadedByName: d.by ?? SAMPLE_USER_NAME,
      createdAt: at,
      updatedAt: at,
      expiresAt: d.expiresInDays
        ? new Date(now.getTime() + d.expiresInDays * 86_400_000).toISOString()
        : null,
      starred: d.starred ?? false,
      status: "ready",
      deletedAt: null,
      currentVersion: 1,
    };
    store.documents.set(id, record);
    store.versions.set(id, [
      {
        id: uid(1000 + i),
        documentId: id,
        workspaceId: workspace.id,
        versionNumber: 1,
        storageKey: key,
        mimeType: mime,
        sizeBytes: d.size,
        createdBy: record.uploadedBy,
        createdByName: record.uploadedByName,
        createdAt: at,
        status: "ready",
      },
    ]);
  });

  // One document with a second version, to show version history.
  const v = store.versions.get(uid(100))!;
  v.unshift({
    ...v[0],
    id: uid(2000),
    versionNumber: 2,
    storageKey: v[0].storageKey.replace("/v1-", "/v2-"),
    createdAt: created(0),
  });
  const first = store.documents.get(uid(100))!;
  store.documents.set(first.id, { ...first, currentVersion: 2, storageKey: v[0].storageKey });

  return store;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  csv: "text/csv",
  jpg: "image/jpeg",
  png: "image/png",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Bytes for seeded demo records, generated on demand. Office formats have no sample bytes. */
export function createSampleSynthesizer(store: MemoryStore) {
  const cache = new Map<string, { bytes: Uint8Array; mimeType: string }>();
  return (key: string): { bytes: Uint8Array; mimeType: string } | null => {
    const hit = cache.get(key);
    if (hit) return hit;
    const doc = [...store.documents.values()].find((d) =>
      (store.versions.get(d.id) ?? []).some((v) => v.storageKey === key),
    );
    if (!doc || !key.includes("-sample")) return null;
    const ext = key.split(".").pop()!;
    let out: { bytes: Uint8Array; mimeType: string } | null = null;
    if (ext === "pdf") {
      out = {
        mimeType: "application/pdf",
        bytes: makePdf(doc.displayName.replace(/_/g, " ").replace(/\.pdf$/, ""), [
          "Sample document generated for the Aurum Ventura demo workspace.",
          `Category: ${doc.category}`,
          `Tags: ${doc.tags.join(", ") || "none"}`,
          "This is placeholder content, not a real client record.",
        ]),
      };
    } else if (ext === "csv") {
      out = {
        mimeType: "text/csv",
        bytes: makeCsv([
          ["Date", "Vendor", "Category", "Amount"],
          ["2025-09-02", "Staples", "Office", "84.20"],
          ["2025-09-09", "CloudHost", "Software", "129.00"],
          ["2025-09-12", "Harbor Bistro", "Meals", "62.75"],
          ["2025-09-21", "Zoom", "Software", "15.99"],
        ]),
      };
    }
    if (out) cache.set(key, out);
    return out;
  };
}

/** Pre-renders image samples (needs a canvas, so browser only). */
export async function prepareSampleImages(store: MemoryStore, storage: MemoryStorage) {
  for (const d of store.documents.values()) {
    const ext = d.originalName.split(".").pop()!.toLowerCase();
    if (ext !== "png" && ext !== "jpg") continue;
    for (const v of store.versions.get(d.id) ?? []) {
      if (store.blobs.has(v.storageKey)) continue;
      const mime = ext === "png" ? "image/png" : "image/jpeg";
      const bytes = await makeImage(d.displayName.replace(/_/g, " "), mime);
      if (bytes) storage.put(v.storageKey, bytes, mime);
    }
  }
}

export function createSampleKit(now?: Date): SampleKit {
  const store = seedSampleStore(now);
  const repo = new MemoryRepository(store);
  const storage = new MemoryStorage(store, { synthesize: createSampleSynthesizer(store) });
  return { store, repo, storage };
}

export { MB };
