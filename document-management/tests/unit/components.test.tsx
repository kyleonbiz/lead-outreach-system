// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentManagementPage } from "@/components/dms/document-management-page";
import { EmptyState, ErrorState, LoadingSkeleton } from "@/components/dms/states";
import { StorageUsageIndicator } from "@/components/dms/storage-usage-indicator";
import { createLocalApi } from "@/lib/dms/client/local-api";
import { DmsError } from "@/lib/dms/errors";

const cards = () => screen.queryAllByTestId("document-card");
async function ready() {
  await waitFor(() => expect(cards().length).toBeGreaterThan(0), { timeout: 4000 });
}

describe("state components", () => {
  it("renders each empty state with guidance", () => {
    const { rerender } = render(<EmptyState variant="search" onClearFilters={() => {}} />);
    expect(screen.getByText("No matching documents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
    rerender(<EmptyState variant="trash" />);
    expect(screen.getByText("Trash is empty")).toBeInTheDocument();
    rerender(<EmptyState variant="all" onUpload={() => {}} />);
    expect(screen.getByRole("button", { name: /Upload documents/ })).toBeInTheDocument();
  });
  it("shows an accessible error with a working retry", async () => {
    const retry = vi.fn();
    render(<ErrorState message="Network error." onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Network error.");
    await userEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(retry).toHaveBeenCalled();
  });
  it("announces loading", () => {
    render(<LoadingSkeleton count={2} />);
    expect(screen.getByRole("status", { name: "Loading documents" })).toBeInTheDocument();
  });
  it("computes storage usage", () => {
    render(<StorageUsageIndicator usage={{ usedBytes: 25 * 1024 * 1024, quotaBytes: 100 * 1024 * 1024, documentCount: 3 }} />);
    expect(screen.getByText("25.0 MB / 100 MB")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: /25%/ })).toBeInTheDocument();
  });
});

describe("workspace (demo data)", () => {
  it("shows header, folders with counts and documents", async () => {
    render(<DocumentManagementPage api={createLocalApi()} />);
    expect(screen.getByRole("heading", { name: "Document Management" })).toBeInTheDocument();
    expect(screen.getByText(/Organize, store, and manage your business documents securely/)).toBeInTheDocument();
    await ready();
    expect(screen.getByRole("button", { name: "All Files, 18 documents" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Invoices, 3 documents" })).toBeInTheDocument();
    expect(screen.getByTestId("storage-usage")).toBeInTheDocument();
  });

  it("filters the library by folder", async () => {
    const user = userEvent.setup();
    render(<DocumentManagementPage api={createLocalApi()} />);
    await ready();
    await user.click(screen.getByRole("button", { name: "Contracts, 3 documents" }));
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(cards().every((c) => /Contract/.test(c.textContent ?? ""))).toBe(true);
    await user.click(screen.getByRole("button", { name: /All Files/ }));
    await waitFor(() => expect(cards().length).toBeGreaterThan(3));
  });

  it("searches by filename and tag, and shows an empty state with no matches", async () => {
    const user = userEvent.setup();
    render(<DocumentManagementPage api={createLocalApi()} />);
    await ready();
    const box = screen.getByRole("searchbox");
    await user.type(box, "northwind");
    await waitFor(() => expect(cards()).toHaveLength(1), { timeout: 3000 });
    await user.clear(box);
    await user.type(box, "reimbursable");
    await waitFor(
      () => {
        expect(cards()).toHaveLength(1);
        expect(cards()[0]).toHaveTextContent("Receipt_Office_Supplies");
      },
      { timeout: 3000 },
    );
    await user.clear(box);
    await user.type(box, "zzzznothing");
    expect(await screen.findByTestId("empty-state", {}, { timeout: 3000 })).toHaveTextContent("No matching documents");
  });

  it("loads more documents incrementally", async () => {
    const user = userEvent.setup();
    render(<DocumentManagementPage api={createLocalApi()} />);
    await ready();
    expect(cards()).toHaveLength(12);
    await user.click(screen.getByRole("button", { name: /Load more \(6 remaining\)/ }));
    await waitFor(() => expect(cards()).toHaveLength(18));
  });

  it("stars and unstars a document", async () => {
    const user = userEvent.setup();
    render(<DocumentManagementPage api={createLocalApi()} />);
    await ready();
    const star = within(cards()[1]).getByRole("button", { name: /^Star / });
    expect(star).toHaveAttribute("aria-pressed", "false");
    await user.click(star);
    await waitFor(() => expect(within(cards()[1]).getByRole("button", { name: /^Unstar / })).toHaveAttribute("aria-pressed", "true"));
  });

  it("renames and deletes (with confirmation) from the details panel", async () => {
    const user = userEvent.setup();
    render(<DocumentManagementPage api={createLocalApi()} />);
    await ready();
    await user.click(screen.getByRole("button", { name: /Open Expenses_September.csv/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: /Download/ })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /Rename/ }));
    const input = within(dialog).getByLabelText("File name");
    await user.clear(input);
    await user.type(input, "Sept expenses{Enter}");
    expect(await within(dialog).findByRole("heading", { name: "Sept expenses.csv" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /^Delete File$/ }));
    const confirm = await screen.findByRole("alertdialog");
    expect(confirm).toHaveTextContent(/Move to Trash|moves to Trash/i);
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: /^Delete File$/ }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Move to trash" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Open Sept expenses/ })).not.toBeInTheDocument());
    expect(await screen.findByText(/Moved to trash/)).toBeInTheDocument();
  });

  it("uploads a valid file, and rejects an invalid one without sending it", async () => {
    const user = userEvent.setup({ applyAccept: false }); // drag-and-drop bypasses the input's accept filter
    render(<DocumentManagementPage api={createLocalApi()} />);
    await ready();
    await user.click(screen.getByRole("button", { name: "Upload", exact: true } as never));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByTestId("file-input") as HTMLInputElement;
    await user.upload(input, new File(["%PDF-1.4 hello"], "fresh-upload.pdf", { type: "application/pdf" }));
    await waitFor(() => expect(within(dialog).getAllByTestId("upload-row")[0]).toHaveAttribute("data-status", "success"));
    // Bypass the input's accept filter, like a drag-and-drop would.
    const bad = new File(["MZ"], "malware.exe", { type: "application/x-msdownload" });
    await user.upload(input, bad);
    await waitFor(() => expect(within(dialog).getAllByTestId("upload-row")[0]).toHaveAttribute("data-status", "error"));
    expect(within(dialog).getByText(/\.exe files are not allowed/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("button", { name: /Open fresh-upload.pdf/ })).toBeInTheDocument();
  });

  it("shows an error state and recovers on retry", async () => {
    const api = createLocalApi();
    const real = api.bootstrap.bind(api);
    let fail = true;
    api.bootstrap = vi.fn(async () => {
      if (fail) throw new DmsError("unavailable", "Network error. Check your connection.");
      return real();
    });
    const user = userEvent.setup();
    render(<DocumentManagementPage api={api} />);
    expect(await screen.findByTestId("error-state")).toHaveTextContent("Network error");
    fail = false;
    await user.click(screen.getByRole("button", { name: /Try again/ }));
    await ready();
  });

  it("shows the empty trash state", async () => {
    const user = userEvent.setup();
    render(<DocumentManagementPage api={createLocalApi()} />);
    await ready();
    await user.click(screen.getByRole("button", { name: /Trash/ }));
    expect(await screen.findByTestId("empty-state")).toHaveTextContent("Trash is empty");
  });
});
