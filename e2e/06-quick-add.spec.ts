import { expect, test, type Page } from "playwright/test";

// SPEC §2 amendment: "Who did you meet?" — global quick log. `q` opens it
// anywhere; find-or-create a contact; the entry lands as a counting
// interaction on their timeline.

test.describe.configure({ mode: "serial" });

/**
 * `q` is a global key handler attached on hydration. On a cold dev compile
 * the page is visible before it has hydrated, and a keypress sent then is
 * simply lost — so press until the dialog answers. A press is only
 * repeated while the dialog is still closed, so it never types into it.
 */
async function openQuickLog(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Who did you meet?" });
  await expect(async () => {
    if (!(await heading.isVisible())) await page.keyboard.press("q");
    await expect(heading).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000 });
}

test("q opens quick log; a brand-new person is created and logged", async ({
  page,
}) => {
  await page.goto("/contacts");
  await openQuickLog(page);

  await page
    .getByPlaceholder("Search contacts or type a new name…")
    .fill("Zara Quicklog");
  await page.getByRole("button", { name: /Create new contact/ }).click();
  await page
    .getByPlaceholder("What happened? (coffee, call, intro…)")
    .fill("Met at demo day");
  await page.getByRole("button", { name: "Log it" }).click();
  await expect(
    page.getByRole("heading", { name: "Who did you meet?" })
  ).toHaveCount(0, { timeout: 15_000 });

  // The contact exists and the interaction is on their timeline.
  await page.goto("/contacts");
  await page.getByRole("link", { name: "Zara Quicklog" }).first().click();
  await expect(page.getByText("Met at demo day").first()).toBeVisible();
});

test("an existing contact is found by search and logged", async ({ page }) => {
  await page.goto("/today");
  await openQuickLog(page);
  const search = page.getByPlaceholder("Search contacts or type a new name…");
  await search.fill("Zara");
  // First option is the existing match, not the create row.
  await page
    .getByRole("button", { name: /Zara Quicklog/ })
    .first()
    .click();
  await page
    .getByPlaceholder("What happened? (coffee, call, intro…)")
    .fill("Follow-up call");
  await page.getByRole("button", { name: "Log it" }).click();
  await expect(
    page.getByRole("heading", { name: "Who did you meet?" })
  ).toHaveCount(0, { timeout: 15_000 });

  await page.goto("/contacts");
  await page.getByRole("link", { name: "Zara Quicklog" }).first().click();
  await expect(page.getByText("Follow-up call").first()).toBeVisible();
  // Still one Zara — logging found her, didn't duplicate her.
  await page.goto("/contacts");
  await expect(page.getByRole("link", { name: "Zara Quicklog" })).toHaveCount(1);
});
