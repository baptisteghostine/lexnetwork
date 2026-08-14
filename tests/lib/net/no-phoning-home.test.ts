import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isAllowedOutboundUrl } from "@/lib/net/fetch";

// SPEC §13 "no phoning home" AC: the grep-level half. The runtime half is
// the outboundFetch allowlist (fetch.test.ts); this suite proves the
// source tree names no hosts beyond the allowlist + owner-facing links,
// and that nothing calls global fetch with an absolute URL outside the
// wrapper.

const SRC = path.join(__dirname, "../../../src");

// Hosts that appear in the UI as links the OWNER clicks (browser
// navigation from their own machine) — not requests Rolo's server makes.
const UI_LINK_HOSTS = new Set([
  "mail.google.com", // Gmail compose links (Today `o`, contact page)
  "www.linkedin.com", // "Get a copy of your data" export-page link
  "localhost", // app_url default
]);

function* walk(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield abs;
  }
}

describe("no phoning home (SPEC §13)", () => {
  it("every host named in src/ is allowlisted or an owner-clicked link", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
        const host = m[1];
        const allowed =
          UI_LINK_HOSTS.has(host) ||
          isAllowedOutboundUrl(`https://${host}/`);
        if (!allowed) {
          offenders.push(`${path.relative(SRC, file)}: ${m[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("nothing outside the wrapper calls fetch with an absolute URL", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file.endsWith(path.join("lib", "net", "fetch.ts"))) continue;
      const text = fs.readFileSync(file, "utf8");
      if (/[^a-zA-Z.]fetch\(\s*["'`]https?:/.test(text)) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
