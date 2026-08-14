// Wipes the E2E data directory. Runs as the first half of the Playwright
// webServer command — strictly before the dev server boots. (It must NOT
// run from the config file, which every worker re-evaluates, nor from
// globalSetup, which can run after the web server is already up.)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), ".data");
if (!process.env.PLAYWRIGHT_SKIP_DATA_WIPE) {
  fs.rmSync(dir, { recursive: true, force: true });
}
