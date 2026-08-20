import { expect, test } from "playwright/test";

import { fieldInput } from "./helpers";

// SPEC §7a: contacts with recognizable locations appear as country
// bubbles; clicking a country lists its contacts; unplaceable locations
// are reported, not guessed.

test.describe.configure({ mode: "serial" });

test("contacts appear as country counts and the side list drills in", async ({
  page,
}) => {
  const people: [string, string, string][] = [
    ["Heidi", "Alpsworth", "Zurich, Switzerland"],
    ["Ueli", "Bergmann", "Geneva, Switzerland"],
    ["Priya", "Mumbaikar", "Mumbai, Maharashtra, India"],
    ["Mysterio", "Nowhere", "The Moon Base"],
  ];
  for (const [first, last, location] of people) {
    await page.goto("/contacts/new");
    await fieldInput(page, "First name").fill(first);
    await fieldInput(page, "Last name").fill(last);
    await fieldInput(page, "Location").fill(location);
    await page.getByRole("button", { name: "Create contact" }).click();
    await expect(page).toHaveURL(/\/contacts\/\d+$/);
  }

  await page.goto("/map");
  // Switzerland bubble (id 756) shows a count of 2.
  const swiss = page.locator('[data-bubble="756"]');
  await expect(swiss).toBeVisible();
  await expect(swiss.locator("text")).toHaveText("2");
  // India (356) shows 1.
  await expect(page.locator('[data-bubble="356"]').locator("text")).toHaveText("1");

  // The by-country ranking lists Switzerland; the unplaceable string is
  // reported by name.
  await expect(
    page.getByRole("link", { name: /Switzerland\s*2/ })
  ).toBeVisible();
  await expect(page.getByText("The Moon Base · 1")).toBeVisible();

  // Drill in: bubble click → side panel lists the two Swiss contacts.
  await swiss.click();
  await expect(page).toHaveURL(/\/map\?c=756/);
  await expect(
    page.getByRole("heading", { name: "Switzerland" })
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Heidi Alpsworth/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Ueli Bergmann/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Priya Mumbaikar/ })).toHaveCount(0);

  // Clear returns to the ranking.
  await page.getByRole("link", { name: "Clear" }).click();
  await expect(page.getByRole("heading", { name: "By country" })).toBeVisible();
});
