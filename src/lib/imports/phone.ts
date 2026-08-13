import { parsePhoneNumberFromString } from "libphonenumber-js";

// Dependency justification: E.164 parsing/validation covers hundreds of
// regional formats — stdlib has nothing, and hand-rolling it is a known trap.

/**
 * Returns the E.164 form ("+41791234567") or null when the number can't be
 * parsed confidently. `defaultRegion` (ISO 3166-1 alpha-2, e.g. "CH") lets
 * national-format numbers parse; without it only +international succeeds.
 */
export function toE164(
  raw: string,
  defaultRegion?: string
): string | null {
  const parsed = parsePhoneNumberFromString(
    raw,
    defaultRegion as Parameters<typeof parsePhoneNumberFromString>[1]
  );
  return parsed?.isValid() ? parsed.number : null;
}
