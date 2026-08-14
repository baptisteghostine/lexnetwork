// vCard 3.0 / 4.0 parser covering the properties Rolo stores:
// N, FN, ORG, TITLE, TEL, EMAIL, BDAY, URL, NOTE, ADR, PHOTO.
// Not supported: vCard 2.1 quoted-printable encoding (pre-2000 exports) —
// such lines are skipped rather than mangled.

import type { ImportRow } from "./types";

type VProp = {
  name: string;
  params: Record<string, string>;
  value: string;
};

export function parseVcards(input: string): ImportRow[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // Unfold: CRLF (or LF) followed by space/tab continues the previous line.
  const unfolded = text.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);

  const cards: VProp[][] = [];
  let current: VProp[] | null = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD$/i.test(line.trim())) {
      current = [];
      continue;
    }
    if (/^END:VCARD$/i.test(line.trim())) {
      if (current) cards.push(current);
      current = null;
      continue;
    }
    if (!current || !line.trim()) continue;
    const prop = parseLine(line);
    if (prop) current.push(prop);
  }
  return cards.map(cardToRow);
}

function parseLine(line: string): VProp | null {
  const colon = findUnquotedColon(line);
  if (colon < 0) return null;
  const lhs = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [nameWithGroup, ...paramParts] = lhs.split(";");
  // Groups like "item1.EMAIL" → EMAIL.
  const name = (nameWithGroup.split(".").pop() ?? "").toUpperCase();
  const params: Record<string, string> = {};
  for (const p of paramParts) {
    const eq = p.indexOf("=");
    if (eq < 0) {
      // vCard 2.1 bare params like TEL;HOME — treat as TYPE.
      params.TYPE = params.TYPE ? `${params.TYPE},${p}` : p;
    } else {
      const key = p.slice(0, eq).toUpperCase();
      const val = p.slice(eq + 1).replaceAll('"', "");
      params[key] = params[key] ? `${params[key]},${val}` : val;
    }
  }
  if (params.ENCODING?.toUpperCase() === "QUOTED-PRINTABLE") return null;
  return { name, params, value };
}

function findUnquotedColon(line: string): number {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuotes = !inQuotes;
    else if (line[i] === ":" && !inQuotes) return i;
  }
  return -1;
}

function unescape(v: string): string {
  // Single pass, so an escaped backslash can never re-trigger later rules
  // ("\\\\n" is a literal backslash + n, not backslash + newline).
  return v.replace(/\\(.)/g, (_, c: string) =>
    c === "n" || c === "N" ? "\n" : c
  );
}

/**
 * Split a compound value on *unescaped* semicolons (RFC 6350): "Sm\;ith"
 * is one component containing a semicolon, not two. Must run before
 * unescape — splitting the unescaped text re-breaks on freed semicolons.
 */
function splitEscaped(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i++;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function cardToRow(props: VProp[]): ImportRow {
  const row: ImportRow = { emails: [], phones: [], socials: [] };
  for (const p of props) {
    const typeLabel = p.params.TYPE?.split(",")[0]?.toLowerCase();
    switch (p.name) {
      case "N": {
        const parts = splitEscaped(p.value).map(unescape);
        // N: family;given;middle;prefix;suffix — middle names ignored.
        if (parts[1]) row.firstName = parts[1].trim();
        if (parts[0]) row.lastName = parts[0].trim();
        break;
      }
      case "FN":
        row.fullName = unescape(p.value).trim();
        break;
      case "ORG":
        row.company = unescape(splitEscaped(p.value)[0]).trim();
        break;
      case "TITLE":
        row.title = unescape(p.value).trim();
        break;
      case "EMAIL": {
        const email = p.value.trim();
        if (email) row.emails.push({ email, label: typeLabel });
        break;
      }
      case "TEL": {
        const phone = p.value.trim();
        if (phone) row.phones.push({ phone, label: typeLabel });
        break;
      }
      case "BDAY": {
        const bday = parseBday(p.value.trim());
        if (bday) row.birthday = bday;
        break;
      }
      case "URL": {
        const url = p.value.trim();
        if (url) {
          row.socials.push({
            platform: /linkedin\.com/i.test(url)
              ? "linkedin"
              : /twitter\.com|x\.com/i.test(url)
                ? "twitter"
                : /github\.com/i.test(url)
                  ? "github"
                  : "website",
            url,
          });
        }
        break;
      }
      case "NOTE":
        row.bio = unescape(p.value).trim().slice(0, 1000);
        break;
      case "ADR": {
        // pobox;ext;street;city;region;postcode;country → "city, region, country"
        const parts = splitEscaped(p.value).map((s) => unescape(s).trim());
        const loc = [parts[3], parts[4], parts[6]].filter(Boolean).join(", ");
        if (loc && !row.location) row.location = loc;
        break;
      }
      case "PHOTO": {
        const enc = p.params.ENCODING?.toUpperCase();
        if (enc === "B" || enc === "BASE64") {
          row.photoBase64 = {
            data: p.value.replaceAll(/\s/g, ""),
            mime: p.params.TYPE
              ? `image/${p.params.TYPE.split(",")[0].toLowerCase()}`
              : "image/jpeg",
          };
        } else if (p.value.startsWith("data:")) {
          const m = /^data:([^;]+);base64,(.+)$/.exec(p.value);
          if (m) row.photoBase64 = { mime: m[1], data: m[2] };
        }
        // Remote PHOTO URLs are ignored here; the applier decides whether
        // to download (allowed network call per SPEC §1).
        break;
      }
    }
  }
  return row;
}

function parseBday(v: string): ImportRow["birthday"] | null {
  // 1990-03-14 | 19900314 | --03-14 | --0314 (year-less)
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v);
  if (m) {
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }
  m = /^--(\d{2})-?(\d{2})$/.exec(v);
  if (m) return { year: null, month: Number(m[1]), day: Number(m[2]) };
  return null;
}
