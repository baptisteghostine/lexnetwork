import { describe, expect, it } from "vitest";

import { buildHealthIssues, failingJobs } from "@/lib/health";

describe("failingJobs", () => {
  it("a dead row is failing only while no later success supersedes it", () => {
    expect(
      failingJobs([
        { kind: "gmail_sync", status: "dead", finishedAt: 100, lastError: "401" },
        { kind: "gmail_sync", status: "success", finishedAt: 200, lastError: null },
      ])
    ).toEqual([]);
    expect(
      failingJobs([
        { kind: "gmail_sync", status: "success", finishedAt: 100, lastError: null },
        { kind: "gmail_sync", status: "dead", finishedAt: 200, lastError: "401" },
      ])
    ).toEqual([{ kind: "gmail_sync", error: "401" }]);
  });

  it("ignores kinds that have no label (backup has its own reader)", () => {
    expect(
      failingJobs([
        { kind: "backup", status: "dead", finishedAt: 1, lastError: "disk" },
        { kind: "ai_batch_tag", status: "dead", finishedAt: 1, lastError: "429" },
      ])
    ).toEqual([]);
  });

  it("reports each failing kind once, in a stable order", () => {
    const out = failingJobs([
      { kind: "network_updates", status: "dead", finishedAt: 5, lastError: "ECONNREFUSED" },
      { kind: "digest", status: "dead", finishedAt: 4, lastError: "ECONNREFUSED" },
      { kind: "digest", status: "dead", finishedAt: 3, lastError: "older" },
    ]);
    expect(out).toEqual([
      { kind: "digest", error: "ECONNREFUSED" },
      { kind: "network_updates", error: "ECONNREFUSED" },
    ]);
  });
});

describe("buildHealthIssues", () => {
  it("is empty when everything is fine", () => {
    expect(
      buildHealthIssues({
        backupFailing: false,
        accounts: [{ provider: "google", status: "active", lastError: null }],
        jobs: [{ kind: "gmail_sync", status: "success", finishedAt: 1, lastError: null }],
      })
    ).toEqual([]);
  });

  it("names a revoked Google account with its reason and where to fix it", () => {
    const issues = buildHealthIssues({
      backupFailing: false,
      accounts: [
        {
          provider: "google",
          status: "revoked",
          lastError: "Google access expired or was revoked — reconnect.",
        },
      ],
      jobs: [],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].id).toBe("account:google");
    expect(issues[0].href).toBe("/settings?tab=integrations");
    expect(issues[0].message).toContain("Google is disconnected");
    expect(issues[0].message).toContain("Reconnect in Settings");
  });

  it("keeps the backup banner first and bounds long errors", () => {
    const issues = buildHealthIssues({
      backupFailing: true,
      accounts: [],
      jobs: [
        {
          kind: "network_updates",
          status: "dead",
          finishedAt: 1,
          lastError: "x".repeat(500),
        },
      ],
    });
    expect(issues.map((i) => i.id)).toEqual(["backup", "job:network_updates"]);
    expect(issues[1].message.length).toBeLessThan(220);
    expect(issues[1].message).toContain("Network-updates email is failing");
  });
});
