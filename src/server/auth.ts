"use server";

import { redirect } from "next/navigation";

import {
  endSession,
  getLoginThrottle,
  getPasswordHash,
  setLoginThrottle,
  setPasswordHash,
  startSession,
} from "@/lib/auth";
import {
  checkLogin,
  formatWait,
  lockoutMs,
  NO_FAILURES,
  recordFailure,
} from "@/lib/auth/login-throttle";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

export type AuthFormState = { error?: string };

export async function setupPasswordAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  if (getPasswordHash()) redirect("/login");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (password !== confirm) {
    return { error: "Passwords don't match." };
  }
  setPasswordHash(hashPassword(password));
  await startSession();
  redirect("/today");
}

export async function loginAction(
  _prev: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const hash = getPasswordHash();
  if (!hash) redirect("/setup");
  // Throttle (SPEC Decisions §6). From reading the state to writing it back
  // there is no `await`, and better-sqlite3 is synchronous, so concurrent
  // submissions cannot interleave and slip extra guesses past the count.
  const now = Date.now();
  const throttle = getLoginThrottle();
  const gate = checkLogin(throttle, now);
  if (!gate.allowed) {
    // Refused before the password is looked at: a guess made during a
    // lockout learns nothing, and neither counts nor extends the wait.
    return {
      error: `Too many wrong passwords. Try again in ${formatWait(gate.retryAfterMs)}.`,
    };
  }
  const password = String(formData.get("password") ?? "");
  if (!verifyPassword(password, hash)) {
    const next = recordFailure(throttle, now);
    setLoginThrottle(next);
    const lockout = lockoutMs(next.failures);
    return {
      error:
        lockout > 0
          ? `Wrong password. Too many failed attempts — try again in ${formatWait(lockout)}.`
          : "Wrong password.",
    };
  }
  if (throttle.failures > 0) setLoginThrottle(NO_FAILURES);
  await startSession();
  redirect("/today");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
