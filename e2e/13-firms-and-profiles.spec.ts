import fs from "node:fs";
import path from "node:path";

import { expect, test } from "playwright/test";

import { fieldInput, openE2eDb } from "./helpers";

// SPEC §17 and §9c career history, in a real browser: a firm gets a tier
// and an address format, Rolo suggests an address and the owner accepts
// it, a bounce is shown on the timeline — and the extension's own page
// reader, run against a profile page laid out the way LinkedIn lays one
// out, brings a person's roles and schools into Rolo.

test.describe.configure({ mode: "serial" });

const TOKEN = "e2e-extension-token-0123456789abcdef";
let contactUrl = "";
let contactId = 0;

function withDb<T>(fn: (db: ReturnType<typeof openE2eDb>) => T): T {
  const db = openE2eDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test("a firm gets a tier and an address format; what the owner types is checked", async ({ page }) => {
  await page.goto("/contacts/new");
  await fieldInput(page, "First name").fill("Dev");
  await fieldInput(page, "Last name").fill("Guessable");
  await fieldInput(page, "Company").fill("E2E Partners");
  await page.getByRole("button", { name: "Create contact" }).click();
  await expect(page).toHaveURL(/\/contacts\/\d+$/);
  contactUrl = page.url();
  contactId = Number(contactUrl.split("/").pop());
  // Nothing is known about the firm yet, so nothing is suggested.
  await expect(page.getByTestId("email-guess")).toHaveCount(0);

  await page.goto("/outreach");
  await page.getByRole("link", { name: /Firms: tiers and address formats/ }).click();
  await expect(page.getByRole("heading", { name: /Firms/, level: 1 })).toBeVisible();
  await expect(page.getByText(/No firm has a tier or an address format yet/)).toBeVisible();

  const add = page.locator("form").filter({ has: page.getByRole("button", { name: "Add" }) });
  await add.getByLabel(/^Firm/).fill("Nobody Works Here");
  await add.getByLabel("Tier").fill("Elite boutique");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(add.getByRole("alert")).toContainText("Nobody in Rolo works at");

  await add.getByLabel(/^Firm/).fill("E2E Partners");
  await add.getByLabel("Email domain").fill("gmail.com");
  await add.getByRole("button", { name: "Add" }).click();
  await expect(add.getByRole("alert")).toContainText("mailbox provider or a school");

  await add.getByLabel("Email domain").fill("e2epartners.test");
  await add.getByLabel(/^Built like/).selectOption("flast");
  await add.getByRole("button", { name: "Add" }).click();
  const row = page.getByTestId("firm-row").filter({ hasText: "E2E Partners" });
  await expect(row).toContainText("1 person");
  await expect(row).toContainText("asilva@e2epartners.test");
  await expect(row).toContainText("set by you");
  await expect(page.getByRole("region", { name: "Elite boutique" })).toContainText("E2E Partners");
});

test("Rolo suggests an address with its evidence; only accepting it puts it on the contact", async ({ page }) => {
  await page.goto(contactUrl);
  const guess = page.getByTestId("email-guess");
  await expect(guess).toContainText("dguessable@e2epartners.test");
  await expect(guess).toContainText("guess · likely");
  await expect(guess).toContainText("the format you set for E2E Partners");
  expect(withDb((db) => db.prepare("SELECT count(*) AS n FROM contact_emails WHERE contact_id = ?").get(contactId))).toEqual({ n: 0 });

  await guess.getByRole("button", { name: "Use this address" }).click();
  await expect(page.getByTestId("email-guess")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "dguessable@e2epartners.test", exact: true })).toBeVisible();
  await expect(page.getByText("guess", { exact: true })).toBeVisible();
  expect(withDb((db) => db.prepare("SELECT email, source FROM contact_emails WHERE contact_id = ?").all(contactId))).toEqual([{ email: "dguessable@e2epartners.test", source: "guess" }]);
  expect(withDb((db) => db.prepare("SELECT status, pattern FROM email_guesses WHERE contact_id = ?").all(contactId))).toEqual([{ status: "accepted", pattern: "flast" }]);

  // "It works" is the owner saying the guess was right.
  await page.getByRole("button", { name: "it works" }).click();
  await expect(page.getByText("guess, confirmed")).toBeVisible();
  expect(withDb((db) => db.prepare("SELECT status FROM email_guesses WHERE contact_id = ?").all(contactId))).toEqual([{ status: "confirmed" }]);
});

test("an email that came back is marked on the timeline", async ({ page }) => {
  withDb((db) => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO interactions (contact_id, kind, direction, occurred_at, title, meta, source, counts_for_touch, created_at)
       VALUES (?, 'email', 'outbound', ?, 'E2E-BOUNCED-SUBJECT', '{"bounced":true}', 'user', 0, ?)`
    ).run(contactId, now - 3600_000, now);
  });
  await page.goto(contactUrl);
  const row = page.locator("ol").last().locator("li").filter({ hasText: "E2E-BOUNCED-SUBJECT" });
  await expect(row.getByText("bounced", { exact: true })).toBeVisible();
});

// A profile page laid out as LinkedIn lays one out: each visible line in an
// aria-hidden span with a screen-reader copy beside it, a role's own text
// in a list nested under it, several roles nested under one employer.
const line = (text: string) => `<div><span aria-hidden="true">${text}</span><span class="visually-hidden">${text}</span></div>`;
const PROFILE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Ana Capture | LinkedIn</title></head><body><main>
<section><h1>Ana Capture</h1><div class="text-body-medium break-words">Tech M&amp;A at E2E Partners</div></section>
<section><div id="about"></div><h2>${line("About")}</h2><div>${line("I cover software and internet companies.")}</div><button>…see more</button></section>
<section><div id="experience"></div><h2>${line("Experience")}</h2><ul>
  <li>${line("Vice President")}${line("E2E Partners · Full-time")}${line("Jan 2022 - Present · 2 yrs 11 mos")}${line("London, England, United Kingdom · Hybrid")}
    <ul><li>${line("TMT investment banking: software and internet coverage.")}</li><li>${line("Skills: M&amp;A · Valuation")}</li></ul></li>
  <li>${line("Morgan Example")}${line("Full-time · 4 yrs")}
    <ul><li>${line("Associate")}${line("Jan 2020 - Dec 2021 · 2 yrs")}</li><li>${line("Analyst")}${line("Jan 2018 - Dec 2019 · 2 yrs")}<ul><li>${line("Healthcare coverage.")}</li></ul></li></ul></li>
  <li><a href="#">${line("Show all 9 experiences")}</a></li>
</ul></section>
<section><div id="education"></div><h2>${line("Education")}</h2><ul>
  <li>${line("London Business School")}${line("Master of Business Administration - MBA, Finance")}${line("2016 - 2018")}</li>
</ul></section>
</main></body></html>`;

test("the extension reads a profile's roles and schools off the page, and Rolo shows them once each", async ({ page, request }) => {
  withDb((db) => db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('linkedin_extension.token', ?)").run(JSON.stringify(TOKEN)));

  // The extension's content script, as shipped, on a page served in place of LinkedIn. Nothing leaves the machine.
  await page.route("https://www.linkedin.com/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: PROFILE_HTML }));
  await page.addInitScript(() => {
    const noop = () => {};
    // The script registers listeners with the extension runtime; a page has none.
    (window as unknown as Record<string, unknown>).chrome = {
      runtime: { onMessage: { addListener: noop }, sendMessage: async () => null },
      storage: { local: { get: async () => ({}), set: async () => {} }, onChanged: { addListener: noop } },
    };
  });
  await page.goto("https://www.linkedin.com/in/ana-capture-e2e/");
  await page.addScriptTag({ content: `${fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8")}\nwindow.__read = () => ({ profile: readProfile(), sections: readSections() });` });
  const read = await page.evaluate(() => (window as unknown as { __read: () => { profile: Record<string, unknown>; sections: { experience: { lines: string[]; children: { lines: string[] }[] }[]; education: unknown[]; about: string | null } } }).__read());
  expect(read.profile).toMatchObject({ publicIdentifier: "ana-capture-e2e", fullName: "Ana Capture", headline: "Tech M&A at E2E Partners" });
  // Lines as a reader sees them: one per line, the screen-reader copies left out, nested entries kept apart.
  expect(read.sections.experience[0].lines).toEqual(["Vice President", "E2E Partners · Full-time", "Jan 2022 - Present · 2 yrs 11 mos", "London, England, United Kingdom · Hybrid"]);
  expect(read.sections.experience[0].children.map((c) => c.lines)).toEqual([["TMT investment banking: software and internet coverage."], ["Skills: M&A · Valuation"]]);
  expect(read.sections.experience[1].children[1].lines).toEqual(["Analyst", "Jan 2018 - Dec 2019 · 2 yrs", "Healthcare coverage."]);
  expect(read.sections.education).toHaveLength(1);
  expect(read.sections.about).toBe("About\nI cover software and internet companies.");

  expect((read.sections as { page?: string }).page).toBe("profile");

  // A "show all experiences" page is read as a list and nothing more: its heading is not anybody's name.
  await page.goto("https://www.linkedin.com/in/ana-capture-e2e/details/experience/");
  await page.addScriptTag({ content: `${fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8")}\nwindow.__read = () => ({ profile: readProfile(), sections: readSections() });` });
  const details = await page.evaluate(() => (window as unknown as { __read: () => { profile: Record<string, unknown>; sections: Record<string, unknown> } }).__read());
  expect(details.profile).toEqual({ publicIdentifier: "ana-capture-e2e", firstName: null, lastName: null, fullName: null, headline: null, location: null });
  expect(details.sections.page).toBe("details");

  // What the extension would post, posted.
  const res = await request.post("/api/linkedin/extension/capture", { headers: { authorization: `Bearer ${TOKEN}` }, data: read });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { contactId: number; created: boolean; career: Record<string, unknown> };
  expect(body).toMatchObject({ created: true, career: { read: { roles: 3, schools: 1, about: true }, rolesAdded: 2, rolesUpdated: 1, schoolsAdded: 1, bio: "set" } });
  const again = await request.post("/api/linkedin/extension/capture", { headers: { authorization: `Bearer ${TOKEN}` }, data: read });
  expect((await again.json()) as Record<string, unknown>).toMatchObject({ created: false, career: { rolesAdded: 0, rolesUpdated: 0, schoolsAdded: 0 } });
  expect((await request.post("/api/linkedin/extension/capture", { data: read })).status()).toBe(401);

  await page.goto(`/contacts/${body.contactId}`);
  await expect(page.getByText("TMT investment banking: software and internet coverage.")).toBeVisible();
  await expect(page.getByText("Healthcare coverage.")).toBeVisible();
  await expect(page.getByText("2022-01 – now")).toBeVisible();
  await expect(page.getByText("I cover software and internet companies.")).toBeVisible();
  await expect(page.getByText("London Business School")).toBeVisible();
  expect(withDb((db) => db.prepare("SELECT count(*) AS n FROM work_history WHERE contact_id = ?").get(body.contactId))).toEqual({ n: 3 });
});
