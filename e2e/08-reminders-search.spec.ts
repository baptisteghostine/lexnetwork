import { expect, test } from "playwright/test";

import { fieldInput } from "./helpers";

// SPEC §4 (edit in place) and §12 (palette without a keyboard), owner
// request 2026-09-26.

test("a reminder can be edited in place", async ({ page }) => {
  await page.goto("/reminders");
  await page.getByPlaceholder(/Follow up about the intro/).fill("Send the deck");
  await page.getByRole("button", { name: "Add reminder" }).click();
  const row = page.locator("li", { hasText: "Send the deck" }).first();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Edit reminder" }).click();
  const title = page.getByPlaceholder(/Follow up about the intro/).last();
  await expect(title).toHaveValue("Send the deck");
  await title.fill("Send the revised deck");
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.locator("li", { hasText: "Send the revised deck" }).first()).toBeVisible();
  await expect(page.getByText("Send the deck", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.locator("li", { hasText: "Send the revised deck" }).first()).toBeVisible();
});

test.describe("search without a keyboard", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the phone top bar's search icon opens the palette and finds a contact", async ({
    page,
  }) => {
    await page.goto("/contacts/new");
    await fieldInput(page, "First name").fill("Priya");
    await fieldInput(page, "Last name").fill("Findable");
    await page.getByRole("button", { name: "Create contact" }).click();
    await expect(page).toHaveURL(/\/contacts\/\d+$/);

    await page.goto("/contacts");
    await page.getByRole("button", { name: "Search", exact: true }).first().click();
    const input = page.getByPlaceholder(/Search contacts or jump anywhere/);
    await expect(input).toBeVisible();
    await input.fill("Priy");
    await page.getByRole("button", { name: /Priya Findable/ }).click();
    await expect(page).toHaveURL(/\/contacts\/\d+$/);
    await expect(page.getByText("Priya Findable").first()).toBeVisible();
  });
});
