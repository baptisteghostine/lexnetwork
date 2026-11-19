"use server";

import { redirect } from "next/navigation";

import {
  attemptPassword,
  endSession,
  getPasswordHash,
  setPasswordHash,
  startSession,
} from "@/lib/auth";
import { hashPassword } from "@/lib/auth/password";

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
  if (!getPasswordHash()) redirect("/setup");
  // Throttled check (SPEC Decisions §6), shared with the connector's
  // consent screen so both doors count against the same lockout.
  const attempt = attemptPassword(String(formData.get("password") ?? ""));
  if (!attempt.ok) return { error: attempt.error };
  await startSession();
  redirect("/today");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
