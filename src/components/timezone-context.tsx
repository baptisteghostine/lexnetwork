"use client";

import { createContext, useContext } from "react";

import { formatInZone } from "@/lib/time";

// The owner's timezone, handed to client components by the app layout so
// a date renders the same on the server and in the browser (see
// formatInZone). Anything that shows a date to the owner formats through
// useFormatDate, never through toLocale*String with no arguments.

const TimezoneContext = createContext<string>("UTC");

export function TimezoneProvider({
  timezone,
  children,
}: {
  timezone: string;
  children: React.ReactNode;
}) {
  return <TimezoneContext.Provider value={timezone}>{children}</TimezoneContext.Provider>;
}

export function useTimezone(): string {
  return useContext(TimezoneContext);
}

/** A formatter bound to the owner's timezone and Rolo's display locale. */
export function useFormatDate(): (epochMs: number, opts: Intl.DateTimeFormatOptions) => string {
  const tz = useTimezone();
  return (epochMs, opts) => formatInZone(tz, epochMs, opts);
}
