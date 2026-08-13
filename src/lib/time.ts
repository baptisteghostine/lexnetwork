/**
 * Request-time clock for dynamic server components. Kept out of component
 * bodies so render code stays pure under the react-hooks/purity rule; every
 * caller is a force-dynamic page evaluated per request.
 */
export function now(): number {
  return Date.now();
}

// ---------- timezone math (SPEC §3: digest hour and "due today" are the
// owner's local time; DST handled via real IANA zone offsets) ----------

/** UTC offset of `tz` at `epochMs`, in ms (positive east of Greenwich). */
export function tzOffsetMs(tz: string, epochMs: number): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(epochMs)) p[part.type] = part.value;
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second)
  );
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/** Local {year, month(1-12), day, hour} of `epochMs` in `tz`. */
export function localParts(
  tz: string,
  epochMs: number
): { year: number; month: number; day: number; hour: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(epochMs)) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour) % 24,
  };
}

/**
 * The epoch of the next moment local time in `tz` reads `hour`:00, strictly
 * after `afterMs`. Fixed-point iteration over the zone offset converges in
 * a step or two; on DST gaps where hour:00 doesn't exist the result lands
 * on the shifted wall-clock instant, which is fine for a daily digest.
 */
export function nextLocalHour(
  tz: string,
  hour: number,
  afterMs: number
): number {
  const local = localParts(tz, afterMs);
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    let guess =
      Date.UTC(local.year, local.month - 1, local.day + dayOffset, hour) -
      tzOffsetMs(tz, afterMs);
    // Re-evaluate the offset at the guess itself (handles DST transitions).
    guess =
      Date.UTC(local.year, local.month - 1, local.day + dayOffset, hour) -
      tzOffsetMs(tz, guess);
    if (guess > afterMs) return guess;
  }
  // Unreachable for hour 0-23, but keep a sane fallback.
  return afterMs + 24 * 60 * 60_000;
}

/** Local YYYY-MM-DD of `epochMs` in `tz` (dedupe keys, digest dates). */
export function localDateKey(tz: string, epochMs: number): string {
  const p = localParts(tz, epochMs);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** The owner's timezone: setting first, then the server's zone. */
export function fallbackTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
