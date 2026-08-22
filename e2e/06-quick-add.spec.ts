import { expect, test } from "playwright/test";

// SPEC §2 amendment: "Who did you meet?" — global quick log. `q` opens it
// anywhere; find-or-create a contact; the entry lands as a counting
// interaction on their timeline.

test.describe.configure({ mode: "serial" });

test("q opens quick log; a brand-new person is created and logged", async ({
  page,
}) => {
  await page.goto("/contacts");
  await page.keyboard.press("q");
  await expect(
    page.getByRole("heading", { name: "Who did you meet?" })
  ).toBeVisible();

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
  await page.keyboard.press("q");
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
