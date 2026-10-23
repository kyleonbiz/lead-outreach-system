import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Responsive checks at tablet (820 px) and small-phone (360 px) widths:
 * no horizontal page scroll, nothing clipped off-screen, floating panels fit
 * the viewport, and touch targets are usable. Screenshots land in
 * test-results/layout/ for a visual review.
 */
const VIEWPORTS = [
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "phone-360", width: 360, height: 740 },
] as const;

/** First visits compile pages in the dev server, so allow for a slow first render. */
async function gotoReady(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("document-card").first()).toBeVisible({ timeout: 45_000 });
}

async function noHorizontalScroll(page: Page, where: string) {
  const { scroll, inner } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    inner: window.innerWidth,
  }));
  expect(scroll, `horizontal overflow ${where}: scrollWidth ${scroll} > innerWidth ${inner}`).toBeLessThanOrEqual(inner);
}

async function fitsViewport(page: Page, el: Locator, what: string) {
  const box = await el.boundingBox();
  const vp = page.viewportSize()!;
  expect(box, `${what} is rendered`).not.toBeNull();
  expect(box!.x, `${what} left edge`).toBeGreaterThanOrEqual(-0.5);
  expect(box!.y, `${what} top edge`).toBeGreaterThanOrEqual(-0.5);
  expect(box!.x + box!.width, `${what} right edge`).toBeLessThanOrEqual(vp.width + 0.5);
  expect(box!.y + box!.height, `${what} bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
}

/** Every visible card/button inside `scope` stays within the viewport's width. */
async function nothingClippedHorizontally(page: Page, scope: Locator, what: string) {
  const vp = page.viewportSize()!;
  const offenders = await scope.evaluateAll(
    (nodes, width) =>
      nodes.flatMap((n) =>
        [...n.querySelectorAll<HTMLElement>("button, a, [role=combobox], input, article, h1, h2, h3")]
          .map((e) => ({ r: e.getBoundingClientRect(), t: (e.getAttribute("aria-label") || e.textContent || e.tagName).trim().slice(0, 40) }))
          .filter(({ r }) => r.width > 0 && (r.right > width + 0.5 || r.left < -0.5))
          .map(({ t, r }) => `${t} [${Math.round(r.left)}–${Math.round(r.right)}]`),
      ),
    vp.width,
  );
  expect(offenders, `${what}: elements outside the viewport`).toEqual([]);
}

for (const vp of VIEWPORTS) {
  test.describe(`layout @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, hasTouch: true });
    const shot = (page: Page, name: string, fullPage = false) =>
      page.screenshot({ path: `test-results/layout/${vp.name}-${name}.png`, fullPage });

    test("public demo page", async ({ page }) => {
      await gotoReady(page, "/");
      await expect(page.getByRole("heading", { name: "Document Management System" })).toBeVisible();
      await noHorizontalScroll(page, "demo page");
      await nothingClippedHorizontally(page, page.locator("main"), "demo page");
      await shot(page, "demo", true);

      // Hero pills wrap instead of overflowing.
      for (const label of ["Folder & Tag Organization", "File Metadata Tracking", "Full-Text Search"]) {
        await fitsViewport(page, page.getByText(label, { exact: true }), `pill "${label}"`);
      }
    });

    test("touch targets on cards are comfortable", async ({ page }) => {
      await gotoReady(page, "/");
      const star = page.getByRole("button", { name: /^(Star|Unstar) / }).first();
      const box = (await star.boundingBox())!;
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(36);
      const upload = (await page.getByRole("button", { name: "Upload", exact: true }).boundingBox())!;
      expect(upload.height).toBeGreaterThanOrEqual(40);
    });

    test("upload dialog fits and is operable", async ({ page }) => {
      await gotoReady(page, "/");
      await page.getByRole("button", { name: "Upload", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(350); // entrance animation
      await fitsViewport(page, dialog, "upload dialog");
      await dialog.getByTestId("file-input").setInputFiles({ name: "layout-check-with-a-rather-long-file-name-2026-final-v3.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4 layout") });
      await expect(dialog.getByTestId("upload-row").first()).toHaveAttribute("data-status", "success");
      await fitsViewport(page, dialog, "upload dialog with a long file name");
      await nothingClippedHorizontally(page, dialog, "upload dialog");
      await fitsViewport(page, dialog.getByRole("button", { name: "Done" }), "Done button");
      await shot(page, "upload");
      await noHorizontalScroll(page, "upload dialog open");
    });

    test("details panel fits, scrolls internally and closes", async ({ page }) => {
      await gotoReady(page, "/");
      await page.getByRole("button", { name: /Open Master_Services_Agreement_Harbor/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("button", { name: "Download", exact: true })).toBeVisible();
      await page.waitForTimeout(350);
      await fitsViewport(page, dialog, "details panel");
      await nothingClippedHorizontally(page, dialog, "details panel");
      await shot(page, "details");
      // The sidebar (tags, metadata, versions) is reachable by scrolling inside the panel.
      await dialog.getByLabel("Add tag").first().scrollIntoViewIfNeeded();
      await dialog.getByText("Expiration date (optional)").scrollIntoViewIfNeeded();
      await fitsViewport(page, dialog, "details panel after scrolling");
      await noHorizontalScroll(page, "details panel open");
      await page.getByRole("button", { name: "Close details" }).click();
      await expect(dialog).toBeHidden();
    });

    test("image and unsupported previews fit", async ({ page }) => {
      await gotoReady(page, "/");
      await page.getByRole("button", { name: /Open NDA_Summit_Property_Group.docx/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByTestId("preview-unsupported")).toBeVisible();
      await page.waitForTimeout(350);
      await fitsViewport(page, dialog.getByTestId("preview-unsupported"), "unsupported preview");
      await shot(page, "details-unsupported");
    });

    test("filters and folders do not overflow", async ({ page }) => {
      await gotoReady(page, "/");
      await page.getByRole("button", { name: /^Contracts, / }).click();
      await expect(page.getByTestId("document-card")).toHaveCount(3);
      await nothingClippedHorizontally(page, page.getByTestId("workspace"), "workspace");
      await page.getByRole("button", { name: "Starred" }).click();
      await noHorizontalScroll(page, "starred view");
      await page.getByRole("searchbox").fill("zzzz-no-such");
      await expect(page.getByTestId("empty-state")).toBeVisible();
      await shot(page, "empty", true);
      await noHorizontalScroll(page, "empty state");
    });

    test("dev-mode workspace and team dialog fit", async ({ page }) => {
      await gotoReady(page, "/app");
      await noHorizontalScroll(page, "app page");
      await shot(page, "app", true);
      await page.getByRole("button", { name: "Team", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Team" });
      await expect(dialog.getByTestId("member-row").first()).toBeVisible();
      await page.waitForTimeout(350);
      await fitsViewport(page, dialog, "team dialog");
      await nothingClippedHorizontally(page, dialog, "team dialog");
      await shot(page, "team");
      await noHorizontalScroll(page, "team dialog open");
    });
  });
}
