"use server";

import { redirect } from "next/navigation";

import {
  endSession,
  getPasswordHash,
  setPasswordHash,
  startSession,
} from "@/lib/auth";
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
  const password = String(formData.get("password") ?? "");
  if (!verifyPassword(password, hash)) {
    return { error: "Wrong password." };
  }
  await startSession();
  redirect("/today");
}

export async function logoutAction(): Promise<void> {
  await endSession();
  redirect("/login");
}
