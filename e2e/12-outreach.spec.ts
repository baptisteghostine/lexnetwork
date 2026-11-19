import { expect, test } from "playwright/test";

import { fieldInput, openE2eDb } from "./helpers";

// SPEC §16: the outreach loop in a real browser — a campaign from a goal,
// a draft Claude wrote opened in Outlook and marked sent, and the person
// turning up on Today once a follow-up is due. Drafts are written through
// the connector (tests/server/outreach.test.ts covers that path); here one
// is put in the database the way the connector stores it.

test.describe.configure({ mode: "serial" });

const DAY = 24 * 60 * 60 * 1000;
const EMAIL = "ana.outreach@bank.test";
let contactId = 0;
let campaignUrl = "";

function withDb<T>(fn: (db: ReturnType<typeof openE2eDb>) => T): T {
  const db = openE2eDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function addDraft(kind: "first" | "nudge", subject: string, body: string): void {
  withDb((db) => {
    const groupId = Number(campaignUrl.split("/").pop());
    const now = Date.now();
    db.prepare(
      `INSERT INTO outreach_drafts (contact_id, group_id, kind, to_email, subject, body, status, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', 'agent', ?, ?)`
    ).run(contactId, groupId, kind, EMAIL, subject, body, now, now);
  });
}

test("a campaign is created from a goal and starts empty", async ({ page }) => {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill("Ana");
  await fieldInput(page, "Last name").fill("Outreach");
  await page.locator('div:has(> label:text-is("Emails"))').getByRole("button", { name: "Add" }).click();
  await page.getByPlaceholder("email@example.com").fill(EMAIL);
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  contactId = Number(page.url().split("/").pop());

  await page.getByRole("link", { name: "Outreach", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Outreach", level: 1 })).toBeVisible();
  await expect(page.getByText(/Nothing waiting\. Ask Claude to draft/)).toBeVisible();
  await expect(page.getByText(/Rolo\s+never sends anything itself/)).toBeVisible();

  await page.getByText("New campaign", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("E2E banking");
  await page.getByLabel("Goal, in one line").fill("Coffee chats with E2E bankers");
  await page.getByLabel(/^Brief/).fill("Who fits: **TMT coverage**.");
  await page.getByRole("button", { name: "Create campaign" }).click();
  await expect(page).toHaveURL(/\/outreach\/\d+$/);
  campaignUrl = page.url();
  await expect(page.getByText("Coffee chats with E2E bankers")).toBeVisible();
  await expect(page.locator("strong", { hasText: "TMT coverage" })).toBeVisible();
  await expect(page.getByText(/Nobody in this campaign yet/)).toBeVisible();

  // The same name again is refused rather than making a second group.
  await page.goto("/outreach");
  await page.getByText("New campaign", { exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("e2e BANKING");
  await page.getByLabel("Goal, in one line").fill("Again");
  await page.getByRole("button", { name: "Create campaign" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "already exists" })).toBeVisible();
});

test("a draft opens in Outlook as edited, and Sent puts it on the timeline", async ({ page }) => {
  withDb((db) => {
    const groupId = Number(campaignUrl.split("/").pop());
    db.prepare("INSERT INTO group_members (group_id, contact_id, created_at) VALUES (?, ?, ?)").run(groupId, contactId, Date.now());
  });
  await page.goto(campaignUrl);
  await expect(page.getByRole("region", { name: "Not contacted" }).getByRole("link", { name: "Ana Outreach" })).toBeVisible();

  addDraft("first", "E2E student — 15 minutes?", "Dear Ana,\n\nCould we speak for 15 minutes & compare notes?\n\nBest,\nOwner");
  await page.goto(campaignUrl);
  await expect(page.getByRole("region", { name: "Draft ready" }).getByText("a draft is waiting to be sent")).toBeVisible();

  await page.goto("/outreach");
  const card = page.getByTestId("draft-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByText(/First email · E2E banking · written by Claude/)).toBeVisible();
  await expect(card.getByText(EMAIL)).toBeVisible();

  // The link carries the address, subject and text — and nothing else can ride in on them.
  const outlook = card.getByRole("link", { name: "Open in Outlook" });
  const href = new URL((await outlook.getAttribute("href")) as string);
  expect(href.origin + href.pathname).toBe("https://outlook.office.com/mail/deeplink/compose");
  expect([...href.searchParams.keys()]).toEqual(["to", "subject", "body"]);
  expect(href.searchParams.get("to")).toBe(EMAIL);
  expect(href.searchParams.get("body")).toContain("15 minutes & compare notes?");
  await expect(card.getByRole("link", { name: "Open in mail app" })).toHaveAttribute("href", /^mailto:ana\.outreach@bank\.test\?subject=E2E%20student/);

  // An edit made here is what opens, and what gets logged.
  await card.getByLabel("Subject").fill("E2E student — a quick call?");
  await expect(outlook).toHaveAttribute("href", /subject=E2E%20student%20%E2%80%94%20a%20quick%20call%3F/);
  await card.getByRole("button", { name: "Sent", exact: true }).click();
  await expect(page.getByTestId("draft-card")).toHaveCount(0);
  await expect(page.getByText(/Nothing waiting/)).toBeVisible();

  await page.goto(`/contacts/${contactId}`);
  await expect(page.locator("ol").last().getByText("E2E student — a quick call?", { exact: true })).toHaveCount(1);

  await page.goto(campaignUrl);
  await expect(page.getByRole("region", { name: "Awaiting reply" }).getByText("0 days since your email")).toBeVisible();
  const sent = withDb((db) => db.prepare("SELECT kind, direction, source, counts_for_touch AS touch FROM interactions WHERE contact_id = ?").all(contactId));
  expect(sent).toEqual([{ kind: "email", direction: "outbound", source: "user", touch: 1 }]);
});

test("after a week with no reply they are on Today, until a follow-up is drafted or discarded", async ({ page }) => {
  // Nine days pass.
  withDb((db) => db.prepare("UPDATE interactions SET occurred_at = ? WHERE contact_id = ?").run(Date.now() - 9 * DAY, contactId));
  // The email is now from before the campaign's first day, so it no longer counts…
  await page.goto(campaignUrl);
  await expect(page.getByRole("region", { name: "Not contacted" }).getByRole("link", { name: "Ana Outreach" })).toBeVisible();
  // …until the owner says the outreach began earlier.
  await page.getByText("Edit goal, brief and start date").click();
  await page.getByLabel("Count what was sent since").fill(new Date(Date.now() - 20 * DAY).toISOString().slice(0, 10));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  await expect(page.getByRole("region", { name: "Awaiting reply" }).getByText("9 days since your email · follow-up due")).toBeVisible();

  await page.goto("/today");
  const row = page.getByRole("link", { name: /Ana Outreach/ }).filter({ hasText: "9 days since your email" });
  await expect(row).toBeVisible();
  await expect(row).toContainText("E2E banking");

  // A follow-up waiting to be sent replaces the reminder with a link to the draft.
  addDraft("nudge", "Re: E2E student — a quick call?", "Dear Ana,\n\nFollowing up on my note below.\n\nBest,\nOwner");
  await page.goto("/today");
  await expect(row).toHaveCount(0);
  await page.getByRole("link", { name: "1 draft to send →" }).click();
  await expect(page).toHaveURL(/\/outreach$/);

  // Discarding takes two clicks and leaves nothing on the timeline.
  const card = page.getByTestId("draft-card");
  await expect(card.getByText(/Follow-up · E2E banking/)).toBeVisible();
  await card.getByRole("button", { name: "Discard…" }).click();
  await card.getByRole("button", { name: "Keep" }).click();
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: "Discard…" }).click();
  await card.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.getByTestId("draft-card")).toHaveCount(0);
  expect(withDb((db) => db.prepare("SELECT count(*) AS n FROM interactions WHERE contact_id = ?").get(contactId))).toEqual({ n: 1 });
  await page.goto("/today");
  await expect(row).toBeVisible();

  // Archiving the campaign takes its people off Today.
  await page.goto(campaignUrl);
  await page.getByText("Edit goal, brief and start date").click();
  await page.getByRole("button", { name: "Archive campaign" }).click();
  await expect(page.getByText(/· archived/)).toBeVisible();
  await page.goto("/today");
  await expect(row).toHaveCount(0);
});
