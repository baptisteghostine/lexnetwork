import { expect, test } from "playwright/test";

import { fieldInput } from "./helpers";

// SPEC §10 flow 3: manufacture a duplicate pair through the UI, scan,
// merge, then undo — the loser comes back.

test.describe.configure({ mode: "serial" });

const SHARED_EMAIL = "bobby@dupetest.example";

async function createContact(
  page: import("playwright/test").Page,
  first: string,
  last: string,
  company: string
) {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill(first);
  await fieldInput(page, "Last name").fill(last);
  await fieldInput(page, "Company").fill(company);
  // Emails section starts empty on the new-contact form — add a row.
  await page
    .locator('div:has(> label:text-is("Emails"))')
    .getByRole("button", { name: "Add" })
    .click();
  await page.getByPlaceholder("email@example.com").fill(SHARED_EMAIL);
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
}

test("two contacts sharing an email surface as duplicates and merge", async ({
  page,
}) => {
  await createContact(page, "Bob", "Dupetest", "Globex");
  await createContact(page, "Robert", "Dupetest", "Globex Inc");

  await page.goto("/duplicates");
  await page.getByRole("button", { name: "Scan now" }).click();
  const pairRow = page.locator("li", { hasText: "Bob Dupetest" }).first();
  await expect(pairRow).toBeVisible({ timeout: 15_000 });
  await expect(pairRow).toContainText("Robert Dupetest");

  await pairRow.getByRole("link", { name: /Merge/ }).click();
  await expect(page).toHaveURL(/\/duplicates\/merge\?/);
  await page.getByRole("button", { name: /^Merge into / }).click();

  // Back on the queue: pair resolved, merge recorded, loser gone.
  await expect(page).toHaveURL(/\/duplicates/);
  await page.goto("/contacts");
  await expect(page.getByRole("link", { name: "Bob Dupetest" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Robert Dupetest" })).toHaveCount(
    0
  );
});

test("undo restores the merged-away contact", async ({ page }) => {
  await page.goto("/duplicates");
  await page.getByRole("button", { name: "Undo" }).first().click();
  await expect(page.getByText(/Merge undone/i)).toBeVisible({
    timeout: 15_000,
  });

  await page.goto("/contacts");
  await expect(
    page.getByRole("link", { name: "Bob Dupetest" })
  ).toHaveCount(1);
  await expect(
    page.getByRole("link", { name: "Robert Dupetest" })
  ).toHaveCount(1);
});

test("bulk merge clears several selected pairs at once", async ({ page }) => {
  // Two fresh duplicate pairs, each sharing an email within the pair.
  const people: [string, string, string][] = [
    ["Nadia", "Bulkone", "nadia@bulktest.example"],
    ["Nadya", "Bulkone", "nadia@bulktest.example"],
    ["Piotr", "Bulktwo", "piotr@bulktest.example"],
    ["Peter", "Bulktwo", "piotr@bulktest.example"],
  ];
  for (const [first, last, email] of people) {
    await page.goto("/contacts/new");
    await fieldInput(page, "First name").fill(first);
    await fieldInput(page, "Last name").fill(last);
    await page
      .locator('div:has(> label:text-is("Emails"))')
      .getByRole("button", { name: "Add" })
      .click();
    await page.getByPlaceholder("email@example.com").fill(email);
    await page.getByRole("button", { name: "Create contact" }).click();
    await expect(page).toHaveURL(/\/contacts\/\d+$/);
  }

  await page.goto("/duplicates");
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.locator("li", { hasText: "Nadia Bulkone" }).first()).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: /Select exact matches/ }).click();
  await page.getByRole("button", { name: "Merge selected…" }).click();
  // Confirm step spells out the confidence breakdown before anything runs.
  await expect(page.getByText(/Merge \d+ pairs?: \d+ exact match/)).toBeVisible();
  await page.getByRole("button", { name: /^Merge \d+$/ }).click();
  await expect(page.getByText(/^Merged \d+ pairs?/)).toBeVisible({
    timeout: 20_000,
  });

  // One survivor per pair.
  await page.goto("/contacts");
  await expect(page.getByRole("link", { name: /Bulkone/ })).toHaveCount(1);
  await expect(page.getByRole("link", { name: /Bulktwo/ })).toHaveCount(1);
});
