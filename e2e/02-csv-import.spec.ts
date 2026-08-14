import path from "node:path";

import { expect, test } from "playwright/test";

// SPEC §8 flow 2: CSV import round-trip through the real UI — upload,
// auto-guessed mapping, dry run, confirm; then the same file again is
// all-unchanged (zero writes).

test.describe.configure({ mode: "serial" });

const FIXTURE = path.join(
  __dirname,
  "../tests/fixtures/google-contacts.csv"
);

async function uploadFixture(page: import("playwright/test").Page) {
  await page.goto("/imports");
  // The page has two file inputs (LinkedIn ZIP first) — scope to the
  // CSV/vCard drop label.
  await page
    .locator('label:has-text("Choose a CSV or vCard")')
    .locator('input[type="file"]')
    .setInputFiles(FIXTURE);
  // First hit compiles the API route in dev — allow for it.
  await expect(page.getByText(/Map columns/)).toBeVisible({ timeout: 20_000 });
}

test("import a Google Contacts CSV via mapping + dry run + confirm", async ({
  page,
}) => {
  await uploadFixture(page);

  // Auto-guess must have mapped the Google shape without manual fixes.
  await page.getByRole("button", { name: "Dry run (no changes)" }).click();
  await expect(page.getByText("Dry run result")).toBeVisible();
  await expect(page.getByText(/new/i).first()).toBeVisible();

  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page).toHaveURL(/\/imports\/\d+$/, { timeout: 20_000 });

  await page.goto("/contacts");
  for (const name of ["Jane Doe", "Bob Smith", "Chloé Van Damme, Jr."]) {
    await expect(page.getByRole("link", { name }).first()).toBeVisible();
  }
});

test("re-importing the same file is all unchanged", async ({ page }) => {
  await uploadFixture(page);
  // Same bytes → the engine flags the exact-file re-import; force the run
  // to prove idempotency end-to-end.
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const anyway = page.getByRole("button", { name: "Import anyway" });
  await anyway.waitFor({ timeout: 5_000 }).catch(() => undefined);
  if (await anyway.isVisible().catch(() => false)) {
    await anyway.click();
  }
  await expect(page).toHaveURL(/\/imports\/\d+$/, { timeout: 20_000 });
  // Report page StatsRow: 3 rows, all unchanged, zero writes (SPEC §8 AC).
  // Each stat cell is a div whose direct children are <div>{n}</div> then
  // <div>{label}</div>.
  const stat = (label: string) =>
    page
      .locator(`div:has(> div:text-is("${label}"))`)
      .locator("> div")
      .first();
  await expect(stat("unchanged")).toHaveText("3");
  await expect(stat("new")).toHaveText("0");
  await expect(stat("updated")).toHaveText("0");
  await expect(
    page.getByText("3 rows were identical to stored data — no writes.")
  ).toBeVisible();
});
