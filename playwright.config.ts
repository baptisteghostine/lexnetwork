import path from "node:path";

import { defineConfig, devices } from "playwright/test";

// E2E suite (SPEC §12/§13): three critical flows against a real dev server
// on an isolated data directory (e2e/.data — wiped per run, gitignored).
// Specs share one database and run in declaration order, one worker.

const E2E_DATA_DIR = path.join(__dirname, "e2e/.data");

// Sandboxed/CI environments with a pre-installed Chromium that doesn't
// match this Playwright version can point at it explicitly.
const chromiumExe = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: chromiumExe ? { executablePath: chromiumExe } : {},
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { storageState: path.join(E2E_DATA_DIR, "state.json") },
    },
  ],
  webServer: {
    // reset-data.mjs wipes e2e/.data first — sequenced here because the
    // web server can be up before globalSetup runs, and the config file
    // is re-evaluated per worker (a wipe in either place deletes the
    // database out from under the live server).
    command: "node e2e/reset-data.mjs && npm run dev -- --port 3100",
    url: "http://localhost:3100/login",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      ROLO_DATA_DIR: E2E_DATA_DIR,
      NODE_ENV: "development",
    },
  },
});
