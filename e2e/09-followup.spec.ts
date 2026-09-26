import { expect, test } from "playwright/test";

import { fieldInput, openE2eDb } from "./helpers";

// SPEC §9e/§11 (2026-09-26): a meeting that just ended with someone in
// Rolo asks "how did it go?" on Today; the answer becomes a note on that
// person. AI is off in E2E, so the owner's words are saved verbatim —
// the path that must work whatever the model does.

test("a just-ended meeting asks for a debrief and saves it as a note", async ({ page }) => {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill("Mira");
  await fieldInput(page, "Last name").fill("Debrief");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  const contactId = Number(page.url().split("/").pop());

  const db = openE2eDb();
  try {
    const now = Date.now();
    const account = db
      .prepare(
        `INSERT INTO integration_accounts (provider, account_email, scopes, status, created_at, updated_at)
         VALUES ('google', 'e2e@example.com', '', 'active', ?, ?)`
      )
      .run(now, now);
    db.prepare(
      `INSERT INTO calendar_events (event_key, account_id, summary, starts_at, ends_at, all_day, status, my_response, attendees, updated_at)
       VALUES ('evt-1', ?, 'Coffee with Mira', ?, ?, 0, 'confirmed', 'accepted', ?, ?)`
    ).run(
      account.lastInsertRowid,
      now - 2 * 3600_000,
      now - 3600_000,
      JSON.stringify([{ email: "mira@example.com", name: "Mira Debrief", contactId }]),
      now
    );
  } finally {
    db.close();
  }

  await page.goto("/today");
  await expect(page.getByText("How did it go with")).toBeVisible();
  await page
    .getByPlaceholder(/One line is enough/)
    .fill("Great chat about Santander, I promised to send the deck");
  await page.getByRole("button", { name: "Save note + reminders" }).click();
  await expect(page.getByText(/Saved as a note/)).toBeVisible({ timeout: 15_000 });
  await page.reload();
  await expect(page.getByText("How did it go with")).toHaveCount(0);

  await page.goto(`/contacts/${contactId}`);
  await expect(page.getByText("Great chat about Santander, I promised to send the deck")).toBeVisible();
});
