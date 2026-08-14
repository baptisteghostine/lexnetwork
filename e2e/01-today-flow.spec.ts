import { expect, test } from "playwright/test";

import { backdateCadence, fieldInput, noteExists } from "./helpers";

// SPEC §12/PLAN Phase 11 flow 1: login → create contact → note → due →
// clear from Today by keyboard, row leaves without a reload.

test.describe.configure({ mode: "serial" });

const NAME = { first: "Talia", last: "Verne" };
const DISPLAY = `${NAME.first} ${NAME.last}`;

test("create a contact with a note", async ({ page }) => {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill(NAME.first);
  await fieldInput(page, "Last name").fill(NAME.last);
  await fieldInput(page, "Title").fill("Founder");
  await fieldInput(page, "Company").fill("Verne Labs");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  await expect(page.getByText(DISPLAY).first()).toBeVisible();

  // Note with autosave (SPEC §2): type, wait for the debounced save to
  // land in the database, then prove persistence with a hard reload.
  await page.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByPlaceholder(/Write a note/);
  await expect(editor).toBeVisible();
  await editor.fill("Met at the Lisbon conference — follow up about hiring.");
  await expect
    .poll(
      () => noteExists("Met at the Lisbon conference — follow up about hiring."),
      { timeout: 20_000 }
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.getByText("Met at the Lisbon conference — follow up about hiring.")
  ).toBeVisible();
});

test("due contact is cleared from Today by keyboard, no reload", async ({
  page,
}) => {
  // The E2E stand-in for the seed script's backdate helper — a cadence
  // assigned through the UI wouldn't be due for another week.
  backdateCadence(DISPLAY);

  await page.goto("/today");
  const row = page.locator("li", { hasText: DISPLAY }).first();
  await expect(row).toBeVisible();

  // Keyboard-only: `l` opens the inline log form, Enter logs a counting
  // interaction; the row must leave the queue without a page reload.
  await row.click();
  await page.keyboard.press("l");
  await page.keyboard.type("Coffee catch-up");
  await page.keyboard.press("Enter");
  await expect(row).toHaveCount(0, { timeout: 15_000 });

  // next_touch_at advanced: the interaction shows on the timeline.
  await page.goto("/contacts");
  await page.getByRole("link", { name: DISPLAY }).first().click();
  await expect(page.getByText("Coffee catch-up").first()).toBeVisible();
});
