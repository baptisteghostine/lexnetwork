import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// SPEC Decisions §6: the login action counts consecutive wrong passwords in
// `settings` and refuses attempts during a lockout — the right password
// included, or the lockout would be no obstacle to a guesser.

const cookieJar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined,
    set: (name: string, value: string) => void cookieJar.set(name, value),
    delete: (name: string) => void cookieJar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

const PASSWORD = "correct horse battery staple";
const T0 = 1_800_000_000_000;

let dataDir: string;
let rawDb: import("better-sqlite3").Database;
let loginAction: typeof import("@/server/auth").loginAction;
let setSetting: typeof import("@/lib/settings").setSetting;
let hashPassword: typeof import("@/lib/auth/password").hashPassword;

function attempt(password: string) {
  const form = new FormData();
  form.set("password", password);
  return loginAction({}, form);
}

function storedThrottle(): unknown {
  const row = rawDb
    .prepare("SELECT value FROM settings WHERE key = 'auth.login_throttle'")
    .get() as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rolo-login-"));
  process.env.ROLO_DATA_DIR = dataDir;
  const client = await import("@/db/client");
  rawDb = client.rawDb;
  migrate(client.db, { migrationsFolder: path.join(__dirname, "../../src/db/migrations") });
  ({ loginAction } = await import("@/server/auth"));
  ({ setSetting } = await import("@/lib/settings"));
  ({ hashPassword } = await import("@/lib/auth/password"));
  vi.useFakeTimers({ toFake: ["Date"] });
});

beforeEach(() => {
  rawDb.prepare("DELETE FROM settings").run();
  setSetting("auth.password_hash", hashPassword(PASSWORD));
  cookieJar.clear();
  vi.setSystemTime(T0);
});

afterAll(() => {
  vi.useRealTimers();
  rawDb?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("loginAction throttle", () => {
  it("answers the first four wrong passwords plainly, then locks on the 5th", async () => {
    for (let i = 0; i < 4; i++) {
      expect(await attempt("nope")).toEqual({ error: "Wrong password." });
    }
    expect(await attempt("nope")).toEqual({
      error: "Wrong password. Too many failed attempts — try again in 30 seconds.",
    });
    expect(storedThrottle()).toEqual({ failures: 5, lastFailureAt: T0 });
  });

  it("refuses the right password during a lockout, without counting the attempt", async () => {
    for (let i = 0; i < 5; i++) await attempt("nope");
    vi.setSystemTime(T0 + 12_000);
    expect(await attempt(PASSWORD)).toEqual({
      error: "Too many wrong passwords. Try again in 18 seconds.",
    });
    expect(await attempt("nope")).toEqual({
      error: "Too many wrong passwords. Try again in 18 seconds.",
    });
    expect(cookieJar.size).toBe(0);
    expect(storedThrottle()).toEqual({ failures: 5, lastFailureAt: T0 });
  });

  it("doubles the lockout when the attempt after the wait is wrong again", async () => {
    for (let i = 0; i < 5; i++) await attempt("nope");
    vi.setSystemTime(T0 + 30_000);
    expect(await attempt("nope")).toEqual({
      error: "Wrong password. Too many failed attempts — try again in 1 minute.",
    });
    vi.setSystemTime(T0 + 30_000 + 59_000);
    expect(await attempt(PASSWORD)).toEqual({
      error: "Too many wrong passwords. Try again in 1 second.",
    });
  });

  it("logs in once the wait is over and resets the count", async () => {
    for (let i = 0; i < 5; i++) await attempt("nope");
    vi.setSystemTime(T0 + 30_000);
    await expect(attempt(PASSWORD)).rejects.toThrow("REDIRECT:/today");
    expect(cookieJar.size).toBe(1);
    expect(storedThrottle()).toEqual({ failures: 0, lastFailureAt: 0 });
    // The slate is clean: four more slips are free again.
    cookieJar.clear();
    for (let i = 0; i < 4; i++) {
      expect(await attempt("nope")).toEqual({ error: "Wrong password." });
    }
    await expect(attempt(PASSWORD)).rejects.toThrow("REDIRECT:/today");
  });

  it("a password reset lifts the lockout", async () => {
    for (let i = 0; i < 9; i++) {
      await attempt("nope");
      vi.setSystemTime(Date.now() + 15 * 60_000);
    }
    vi.setSystemTime(T0);
    expect((await attempt(PASSWORD)).error).toMatch(/^Too many wrong passwords/);
    // What scripts/reset-password.ts writes.
    const { LOGIN_THROTTLE_KEY, NO_FAILURES } = await import("@/lib/auth/login-throttle");
    setSetting("auth.password_hash", hashPassword("a brand new password"));
    setSetting(LOGIN_THROTTLE_KEY, NO_FAILURES);
    await expect(attempt("a brand new password")).rejects.toThrow("REDIRECT:/today");
  });

  it("still sends a fresh install to /setup", async () => {
    rawDb.prepare("DELETE FROM settings").run();
    await expect(attempt("anything")).rejects.toThrow("REDIRECT:/setup");
  });
});
