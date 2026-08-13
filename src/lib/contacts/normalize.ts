// Pure helpers — no DB, no React (see CLAUDE.md lib/ conventions).

/**
 * Canonical form used for identity matching (imports, dedupe, Gmail sync):
 * lowercase + trim; for gmail domains, dots in the local part are ignored
 * and +tags stripped, per SPEC §10.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replaceAll(".", "");
  }
  return `${local}@${domain}`;
}

/**
 * Derived display_name (see SCHEMA.md contacts): "First Last" → single name
 * → primary email → primary phone → "Unnamed".
 */
export function deriveDisplayName(input: {
  firstName?: string | null;
  lastName?: string | null;
  primaryEmail?: string | null;
  primaryPhone?: string | null;
}): string {
  const first = input.firstName?.trim() ?? "";
  const last = input.lastName?.trim() ?? "";
  const name = [first, last].filter(Boolean).join(" ");
  if (name) return name;
  const email = input.primaryEmail?.trim();
  if (email) return email;
  const phone = input.primaryPhone?.trim();
  if (phone) return phone;
  return "Unnamed";
}

export function isValidBirthday(
  month: number | null,
  day: number | null
): boolean {
  if (month === null && day === null) return true;
  if (month === null || day === null) return false;
  if (month < 1 || month > 12) return false;
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= daysInMonth[month - 1];
}
