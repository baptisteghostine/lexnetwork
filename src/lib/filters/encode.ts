// URL-safe encoding of a FilterSet for ?f= params (works in browser and
// Node — the contacts page decodes server-side).

import { parseFilterSet, type FilterSet } from "@/lib/filters/types";

export function encodeFilterParam(f: FilterSet): string {
  const json = JSON.stringify(f);
  const b64 =
    typeof btoa !== "undefined"
      ? btoa(String.fromCharCode(...new TextEncoder().encode(json)))
      : Buffer.from(json, "utf8").toString("base64");
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeFilterParam(s: string): FilterSet | null {
  try {
    const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
    const json =
      typeof atob !== "undefined"
        ? new TextDecoder().decode(
            Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          )
        : Buffer.from(b64, "base64").toString("utf8");
    return parseFilterSet(json);
  } catch {
    return null;
  }
}
