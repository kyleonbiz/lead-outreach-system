import { expect, test } from "@playwright/test";

test.describe("public demo page", () => {
  test("shows the hero and a working demo workspace", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Document Management System" })).toBeVisible();
    await expect(page.getByText("Store, organize, and manage all business documents securely in one place.")).toBeVisible();
    for (const pill of ["Folder & Tag Organization", "File Metadata Tracking", "Full-Text Search"]) {
      await expect(page.getByText(pill, { exact: true })).toBeVisible();
    }
    await expect(page.getByRole("note")).toContainText("not saved or uploaded anywhere");
    await expect(page.getByTestId("document-card").first()).toBeVisible();

    await page.getByRole("button", { name: "Contracts, 3 documents" }).click();
    await expect(page.getByTestId("document-card")).toHaveCount(3);

    await page.getByRole("button", { name: /All Files/ }).click();
    await page.getByRole("searchbox").fill("northwind");
    await expect(page.getByTestId("document-card")).toHaveCount(1);
  });

  test("opens document details with a preview, then closes with Escape and restores focus", async ({ page }) => {
    await page.goto("/");
    const open = page.getByRole("button", { name: /Open Invoice_INV-2041_Northwind.pdf/ });
    await open.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Invoice_INV-2041_Northwind.pdf" })).toBeVisible();
    await expect(dialog.locator("iframe[title^='Preview of']")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Download", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
  });

  test("unsupported formats show a download-to-view fallback", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Open AR_Aging_Report_Oct.xlsx/ }).click();
    await expect(page.getByTestId("preview-unsupported")).toContainText("Preview not available");
    await expect(page.getByRole("button", { name: /Download to view/ })).toBeVisible();
  });

  test("upload dialog validates files and reports progress", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByTestId("file-input").setInputFiles({ name: "e2e-demo.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 e2e") });
    await expect(dialog.getByTestId("upload-row").first()).toHaveAttribute("data-status", "success");
    await dialog.getByTestId("file-input").setInputFiles({ name: "notes.txt.exe", mimeType: "application/x-msdownload", buffer: Buffer.from("MZ") });
    await expect(dialog.getByTestId("upload-row").first()).toHaveAttribute("data-status", "error");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("button", { name: /Open e2e-demo.pdf/ })).toBeVisible();
  });

  test("mobile layout: single column, full-height details sheet, no horizontal scroll", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.getByTestId("document-card").first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const boxes = await page.getByTestId("document-card").evaluateAll((els) => els.slice(0, 2).map((e) => e.getBoundingClientRect().left));
    expect(boxes[0]).toBe(boxes[1]); // stacked, same column
    await page.getByRole("button", { name: /Open Invoice_INV-2041/ }).click();
    const box = await page.getByRole("dialog").boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(388);
    expect(box!.height).toBeGreaterThan(700);
    await ctx.close();
  });
});
