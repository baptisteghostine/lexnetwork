import { expect, test } from "playwright/test";

import { fieldInput, openE2eDb } from "./helpers";

// SPEC §15: WhatsApp per person, in a real browser — link a chat by
// number and saved name, bring a phone export in, see it on the timeline
// as one row per day, and remove it again without touching anything else.
// The laptop collector is not part of this: it does not exist yet, and
// the panel says so.

test.describe.configure({ mode: "serial" });

const EXPORT = [
  "[17/11/2026, 09:15:02] John: Morning! Still on for Thursday?",
  "[17/11/2026, 09:16:40] E2E Owner: Yes — 5pm at the usual place",
  "[18/11/2026, 21:02:11] John: Running late, E2E-WHATSAPP-MARKER",
].join("\n");

let contactUrl = "";

/** The timeline list itself — the page's "recent" strip repeats row titles. */
const timeline = (page: import("playwright/test").Page) => page.locator("ol").last();

test("link a chat by number and the name they are saved under", async ({ page }) => {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill("Chris");
  await fieldInput(page, "Last name").fill("Whatsapp");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  contactUrl = page.url();

  const panel = page.getByRole("region", { name: "WhatsApp" });
  await expect(panel.getByText(/Rolo then deals with this chat only/)).toBeVisible();

  // Not a number: refused, nothing linked.
  await panel.getByLabel("Their WhatsApp number").fill("John");
  await panel.getByLabel("Name they are saved under in WhatsApp").fill("John");
  await panel.getByRole("button", { name: "Link chat" }).click();
  await expect(panel.getByRole("alert")).toContainText("not a phone number");

  await panel.getByLabel("Their WhatsApp number").fill("+44 7911 123456");
  await panel.getByRole("button", { name: "Link chat" }).click();
  await expect(panel.getByText("+447911123456")).toBeVisible();
  await expect(panel.getByText("“John”")).toBeVisible();
  await expect(panel.getByText("No messages in Rolo yet.")).toBeVisible();
  // Sync is off, and the panel is honest that nothing can sync yet.
  await expect(panel.getByLabel(/Keep this chat in sync/)).not.toBeChecked();
  await expect(panel.getByText(/The laptop collector has not connected to Rolo yet/)).toBeVisible();
});

test("a phone export lands on the timeline as one row per day, and uploading it twice adds nothing", async ({ page }) => {
  await page.goto(contactUrl);
  const panel = page.getByRole("region", { name: "WhatsApp" });
  await panel.getByText("Upload a phone export (older history)").click();
  await panel.getByLabel("WhatsApp export file").setInputFiles({ name: "_chat.txt", mimeType: "text/plain", buffer: Buffer.from(EXPORT, "utf8") });
  await panel.getByRole("button", { name: "Import export" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Imported" })).toContainText("Imported 3 new messages");
  await expect(panel.getByText(/3 messages, 17 Nov 2026 – 18 Nov 2026/)).toBeVisible();

  await expect(timeline(page).getByText("2 messages (1 sent, 1 received)", { exact: true })).toHaveCount(1);
  await expect(timeline(page).getByText("1 message received", { exact: true })).toHaveCount(1);
  // The day's words sit behind the row.
  await timeline(page).getByText("Messages", { exact: true }).first().click();
  await expect(page.getByText(/E2E-WHATSAPP-MARKER/).first()).toBeVisible();

  await panel.getByLabel("WhatsApp export file").setInputFiles({ name: "_chat.txt", mimeType: "text/plain", buffer: Buffer.from(EXPORT, "utf8") });
  await panel.getByRole("button", { name: "Import export" }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Imported" })).toContainText("Imported 0 new messages; 3 were already in Rolo");
  await expect(timeline(page).getByText("2 messages (1 sent, 1 received)", { exact: true })).toHaveCount(1);

  // Only what the owner sent counts as keeping in touch.
  const db = openE2eDb();
  try {
    expect(db.prepare("SELECT counts_for_touch FROM interactions WHERE source = 'whatsapp' ORDER BY occurred_at").all()).toEqual([
      { counts_for_touch: 1 },
      { counts_for_touch: 0 },
    ]);
  } finally {
    db.close();
  }
});

test("a file that is not this chat is refused; the saved name can be corrected; sync and history are remembered", async ({ page }) => {
  await page.goto(contactUrl);
  const panel = page.getByRole("region", { name: "WhatsApp" });
  await panel.getByText("Upload a phone export (older history)").click();
  const group = "[17/11/2026, 09:00:00] John: a\n[17/11/2026, 09:01:00] Maya: b\n[17/11/2026, 09:02:00] E2E Owner: c";
  await panel.getByLabel("WhatsApp export file").setInputFiles({ name: "_chat.txt", mimeType: "text/plain", buffer: Buffer.from(group, "utf8") });
  await panel.getByRole("button", { name: "Import export" }).click();
  await expect(panel.getByRole("alert")).toContainText("Group chats are not imported");

  await panel.getByRole("button", { name: "change" }).click();
  await panel.getByLabel("Name they are saved under in WhatsApp").fill("Johnny");
  await panel.getByRole("button", { name: "Save" }).click();
  await expect(panel.getByText("“Johnny”")).toBeVisible();

  await panel.getByLabel(/Keep this chat in sync/).check();
  await panel.getByLabel("Import history from").fill("2026-10-01");
  await panel.getByRole("button", { name: "Set" }).click();
  await expect(panel.getByText("The collector is asked for this chat from that date.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "WhatsApp" }).getByLabel(/Keep this chat in sync/)).toBeChecked();
  await expect(page.getByRole("region", { name: "WhatsApp" }).getByLabel("Import history from")).toHaveValue("2026-10-01");
});

test("Delete WhatsApp data removes only what came from WhatsApp for this person", async ({ page }) => {
  await page.goto(contactUrl);
  // Something of the owner's own that must survive.
  await page.getByRole("button", { name: "Log interaction" }).click();
  await page.getByPlaceholder(/coffee at Blue Bottle/).fill("E2E hand-logged lunch");
  await page.getByRole("button", { name: "Log it" }).click();
  await expect(page.getByText("E2E hand-logged lunch").first()).toBeVisible();

  const panel = page.getByRole("region", { name: "WhatsApp" });
  await panel.getByRole("button", { name: "Delete WhatsApp data…" }).click();
  await expect(panel.getByText(/nothing in WhatsApp itself changes/)).toBeVisible();
  // Cancel is a real way out.
  await panel.getByRole("button", { name: "Cancel" }).click();
  await expect(timeline(page).getByText("1 message received", { exact: true })).toHaveCount(1);

  await panel.getByRole("button", { name: "Delete WhatsApp data…" }).click();
  await panel.getByRole("button", { name: "Yes, delete WhatsApp data" }).click();
  await expect(page.getByRole("region", { name: "WhatsApp" }).getByRole("button", { name: "Link chat" })).toBeVisible();
  await expect(page.getByText(/WhatsApp · /)).toHaveCount(0);
  await expect(page.getByText(/message received/)).toHaveCount(0);
  await expect(page.getByText(/E2E-WHATSAPP-MARKER/)).toHaveCount(0);
  await expect(page.getByText("E2E hand-logged lunch").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Chris Whatsapp" })).toBeVisible();

  const db = openE2eDb();
  try {
    expect(db.prepare("SELECT (SELECT count(*) FROM whatsapp_links) AS links, (SELECT count(*) FROM whatsapp_messages) AS messages").get()).toEqual({ links: 0, messages: 0 });
  } finally {
    db.close();
  }
});
