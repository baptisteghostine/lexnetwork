import { expect, test } from "playwright/test";

import { fieldInput } from "./helpers";

// SPEC §3a: the board's job is emptying Uncategorized. Both ways of
// moving a contact are covered — keyboard triage and HTML5 drag-and-drop.

test.describe.configure({ mode: "serial" });

const NAME = "Ines Bucket";

test("board shows every frequency column and the untriaged pile", async ({
  page,
}) => {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill("Ines");
  await fieldInput(page, "Last name").fill("Bucket");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);

  await page.goto("/keep-in-touch");
  for (const label of [
    "Every week",
    "Every 2 weeks",
    "Every month",
    "Every 6 weeks",
    "Every 3 months",
    "Every 6 months",
    "Every year",
    "Uncategorized",
    "Don't keep in touch",
  ]) {
    await expect(
      page.getByRole("heading", { name: label, exact: true })
    ).toBeVisible();
  }
  // A brand-new contact has never been triaged.
  const untriaged = page.locator("section", {
    has: page.getByRole("heading", { name: "Uncategorized", exact: true }),
  });
  await expect(untriaged.getByText(NAME)).toBeVisible();
});

test("keyboard triage assigns a cadence and undo puts it back", async ({
  page,
}) => {
  await page.goto("/keep-in-touch");
  await page.getByRole("button", { name: "Triage by keyboard" }).click();

  // The focused card is the top of the Uncategorized queue; whoever it is,
  // pressing 1 files them under Every week.
  const focused = page.locator(".bg-accent\\/40").first();
  await expect(focused).toBeVisible();
  const name = (await focused.locator(".font-medium").first().innerText()).trim();

  await page.keyboard.press("1");
  const weekly = page.locator("section", {
    has: page.getByRole("heading", { name: "Every week", exact: true }),
  });
  await expect(weekly.getByText(name, { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await page.getByRole("button", { name: "Undo" }).click();
  await expect(weekly.getByText(name, { exact: true })).toHaveCount(0, {
    timeout: 15_000,
  });
});

test("dragging a card into a frequency column assigns that cadence", async ({
  page,
}) => {
  await page.goto("/keep-in-touch");
  const untriaged = page.locator("section", {
    has: page.getByRole("heading", { name: "Uncategorized", exact: true }),
  });
  const card = untriaged.locator("[draggable=true]").first();
  // The card's own innerText includes the avatar initials — read the name link.
  const name = (await card.locator("a").innerText()).trim();
  const monthly = page.locator("section", {
    has: page.getByRole("heading", { name: "Every month", exact: true }),
  });

  // Playwright's dragTo() drives mouse events, which Chromium does not
  // translate into an HTML5 drag; dispatch the real drag events instead,
  // sharing one DataTransfer exactly as the browser does.
  await card.evaluate((source, columnLabel: string) => {
    const column = [...document.querySelectorAll("section")].find(
      (s) => s.querySelector("h2")?.textContent === columnLabel
    );
    if (!column) throw new Error(`no column ${columnLabel}`);
    const dataTransfer = new DataTransfer();
    source.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer })
    );
    column.dispatchEvent(
      new DragEvent("dragover", { bubbles: true, dataTransfer })
    );
    column.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer }));
  }, "Every month");
  await expect(monthly.getByText(name, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("'don't keep in touch' leaves Uncategorized without setting a cadence", async ({
  page,
}) => {
  // Earlier tests emptied the pile — this one needs its own untriaged contact.
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill("Otto");
  await fieldInput(page, "Last name").fill("Never");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);

  await page.goto("/keep-in-touch");
  const untriaged = page.locator("section", {
    has: page.getByRole("heading", { name: "Uncategorized", exact: true }),
  });
  const before = await untriaged.locator("[draggable=true]").count();

  await page.getByRole("button", { name: "Triage by keyboard" }).click();
  const focused = page.locator(".bg-accent\\/40").first();
  const name = (await focused.locator(".font-medium").first().innerText()).trim();
  await page.keyboard.press("x");

  const never = page.locator("section", {
    has: page.getByRole("heading", { name: "Don't keep in touch", exact: true }),
  });
  await expect(never.getByText(name, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(untriaged.locator("[draggable=true]")).toHaveCount(before - 1);
});
