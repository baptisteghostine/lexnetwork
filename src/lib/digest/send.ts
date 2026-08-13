import nodemailer from "nodemailer";

import { getSetting } from "@/lib/settings";

// Dependency justification (PLAN Phase 5): SMTP client — stdlib has none.

export type SmtpSettings = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  to: string;
};

export function getSmtpSettings(): SmtpSettings | null {
  const s = getSetting<Partial<SmtpSettings>>("smtp");
  if (!s?.host || !s.from || !s.to) return null;
  return {
    host: s.host,
    port: s.port ?? 587,
    secure: s.secure ?? false,
    user: s.user ?? "",
    pass: s.pass ?? "",
    from: s.from,
    to: s.to,
  };
}

/** Sends via the configured SMTP. Throws when unconfigured or on failure. */
export async function sendEmail(mail: {
  subject: string;
  html: string;
  text: string;
}): Promise<void> {
  const smtp = getSmtpSettings();
  if (!smtp) {
    throw new Error("SMTP is not configured — set it up in Settings.");
  }
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  await transport.sendMail({
    from: smtp.from,
    to: smtp.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  });
}
