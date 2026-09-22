import { expect, test } from "playwright/test";

import { fieldInput, openE2eDb } from "./helpers";

// SPEC §2/§3 (owner request 2026-09-22): formatted notes on a logged
// interaction, and a counting note that @-mentions someone moves *their*
// cadence clock too.

test.describe.configure({ mode: "serial" });

async function createContact(
  page: import("playwright/test").Page,
  first: string,
  last: string
) {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill(first);
  await fieldInput(page, "Last name").fill(last);
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  return page.url();
}

test("log interaction with toolbar-formatted notes", async ({ page }) => {
  await createContact(page, "Mia", "Toolbar");
  await page.getByRole("button", { name: "Log interaction" }).click();
  await page.getByRole("button", { name: "Message" }).click();
  await page.getByPlaceholder(/coffee at Blue Bottle/).fill("Quick DM");
  const notes = page.getByPlaceholder(/What you talked about/);
  await notes.fill("agreed next steps");
  // Select the whole text and bold it via the toolbar; then a bullet.
  await notes.press("ControlOrMeta+a");
  await page.getByRole("button", { name: "Bold (Ctrl+B)" }).click();
  await expect(notes).toHaveValue("**agreed next steps**");
  await page.getByRole("button", { name: /Bullet list/ }).click();
  await expect(notes).toHaveValue("- **agreed next steps**");
  await page.getByRole("button", { name: "Log it" }).click();

  // Both rows are on the timeline: the interaction, and a note whose
  // markdown rendered (a real <strong>, not literal asterisks).
  const timeline = page.locator("ol");
  await expect(timeline.getByText("Quick DM").first()).toBeVisible();
  await expect(timeline.locator("li strong", { hasText: "agreed next steps" })).toBeVisible();
  await expect(page.getByText("**agreed next steps**")).toHaveCount(0);
});

test("a counting note that mentions a contact counts for them", async ({
  page,
}) => {
  const noahUrl = await createContact(page, "Noah", "Mentioned");
  await page.goto(noahUrl);
  const stat = page.locator("dt", { hasText: "Last interaction" }).locator("xpath=..").locator("dd");
  await expect(stat).toHaveText("—");

  // On Mia's profile: a note mentioning Noah, then tick "counts as interaction".
  await page.goto("/contacts");
  await page.getByRole("link", { name: "Mia Toolbar" }).first().click();
  await page.getByRole("button", { name: "Add note" }).click();
  const editor = page.getByPlaceholder(/Write a note/);
  await editor.fill("Coffee with @Noa");
  // Typing fill() fires one change with the caret at the end — the
  // autocomplete opens on it.
  const option = page.getByRole("button", { name: /Noah Mentioned/ });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.click();
  await expect(editor).toHaveValue(/mention:\/\/contact\/\d+/);
  // Two notes are on Mia's profile now; scope to the one being edited.
  await page
    .locator("div.group", { has: editor })
    .getByLabel("counts as interaction")
    .check();
  // Done flushes the debounced autosave; wait for the mention row it
  // derives before reading Noah's profile.
  await page.getByRole("button", { name: "Done" }).click();
  await expect
    .poll(() => {
      const db = openE2eDb();
      try {
        return (db.prepare("SELECT count(*) AS c FROM note_mentions").get() as { c: number }).c;
      } finally {
        db.close();
      }
    }, { timeout: 15_000 })
    .toBe(1);

  // Noah's profile now shows the touch.
  await page.goto(noahUrl);
  await expect(stat).toHaveText("today", { timeout: 15_000 });
  await expect(page.getByText("Mentioned in a note")).toBeVisible();
});
