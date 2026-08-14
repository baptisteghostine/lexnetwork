import path from "node:path";

import { expect, test as setup } from "playwright/test";

import { E2E_PASSWORD } from "./helpers";

// First-run flow doubles as the auth fixture: create the password once,
// persist the session cookie for every spec (decision #6: setup screen,
// no password env var).

setup("first-run setup creates the password and logs in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel("Confirm password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "Create password" }).click();
  await expect(page).toHaveURL(/\/today/);

  await page.context().storageState({
    path: path.join(__dirname, ".data/state.json"),
  });
});
